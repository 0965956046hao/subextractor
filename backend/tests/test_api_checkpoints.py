import tempfile
import unittest
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import patch

from app.config import settings
from app.models import SrtEntry
from app.services import translation_service as tr
from app.services import tts_service as tts
from app.services import capcut_tts_client as capcut
from app.services.dub_checkpoint import synthesize_checkpointed
from app.services.job_utils import JobCancelled
from app.services.srt_utils import entries_to_srt


def entries(count):
    return [SrtEntry(index=i + 1, start=i * 2, end=i * 2 + 1,
                     startLabel=f"00:00:{i * 2:02d},000",
                     endLabel=f"00:00:{i * 2 + 1:02d},000", text=f"字幕{i}")
            for i in range(count)]


class TranslationCheckpointTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.enterContext(patch.object(settings, "temp_dir", self.root))
        self.source = self.root / "source.srt"
        self.source.write_text(entries_to_srt(entries(51)), encoding="utf-8")
        self.enterContext(patch.object(tr, "_srt_path", return_value=self.source))
        self.enterContext(patch.object(tr, "configured_gemini_keys", return_value=["fake"]))
        self.enterContext(patch.object(tr, "_build_base_prompt", return_value="prompt"))
        self.enterContext(patch.object(tr, "load_translation_context", return_value="initial"))
        self.enterContext(patch.object(tr, "append_translation_context"))
        self.note = self.enterContext(patch.object(tr, "_build_patch_context_note", return_value="note"))

    def test_resume_after_failure_only_calls_missing_batch_and_restores_context(self):
        calls = []

        def translate(texts, **kwargs):
            calls.append(kwargs["instruction"])
            if len(calls) == 2:
                raise RuntimeError("network")
            return ["Dịch " + text for text in texts]

        with patch.object(tr, "gemini_map_texts", side_effect=translate):
            with self.assertRaises(RuntimeError):
                tr.translate_srt("video")
            self.assertFalse((self.root / "translated/video/subtitles_vi.srt").exists())
            result = tr.translate_srt("video")
        self.assertEqual(len(calls), 3)
        self.assertIn("initial\n\nnote", calls[-1])
        self.assertIn("Dịch", result)
        self.assertEqual(self.note.call_count, 2)

    def test_pause_during_note_keeps_translation_and_rebuilds_note(self):
        cancelled = [False]

        def translated(texts, **kwargs):
            cancelled[0] = True
            return ["Đã dịch " + text for text in texts]

        with patch.object(tr, "gemini_map_texts", side_effect=translated) as call:
            with self.assertRaises(JobCancelled):
                tr.translate_srt("video", cancelled_cb=lambda: cancelled[0])
            self.assertEqual(call.call_count, 1)
        with patch.object(tr, "gemini_map_texts", side_effect=lambda texts, **kw: texts) as call:
            tr.translate_srt("video")
            self.assertEqual(call.call_count, 1)  # second batch only
        self.assertEqual(self.note.call_count, 2)

    def test_changed_language_source_or_model_does_not_reuse(self):
        with patch.object(tr, "gemini_map_texts", side_effect=lambda texts, **kw: texts) as call:
            tr.translate_srt("video")
            tr.translate_srt("video")
            self.assertEqual(call.call_count, 2)
            tr.translate_srt("video", target_lang="en")
            self.assertEqual(call.call_count, 4)
            with patch.object(settings, "gemini_model", "another-model"):
                tr.translate_srt("video")
            self.assertEqual(call.call_count, 6)
            self.source.write_text(entries_to_srt(entries(1)), encoding="utf-8")
            tr.translate_srt("video")
            self.assertEqual(call.call_count, 7)

    def test_corrupt_checkpoint_is_rebuilt(self):
        with patch.object(tr, "gemini_map_texts", side_effect=lambda texts, **kw: texts) as call:
            tr.translate_srt("video")
            next((self.root / "translated").rglob("000001.json")).write_text("broken")
            tr.translate_srt("video")
            self.assertEqual(call.call_count, 3)

    def test_empty_initial_context_is_stable_across_restart(self):
        with patch.object(tr, "load_translation_context", return_value=None), patch.object(
            tr, "gemini_map_texts", side_effect=lambda texts, **kw: texts,
        ) as call:
            tr.translate_srt("video")
        # The exported global context has changed, but the checkpoint keeps its
        # own initial snapshot, so identity and context chain stay reusable.
        with patch.object(tr, "load_translation_context", return_value="new exported context"), patch.object(
            tr, "gemini_map_texts", side_effect=AssertionError("must not call Gemini"),
        ):
            tr.translate_srt("video")

    def test_multi_voice_pause_does_not_publish_final_srt(self):
        with patch.object(tr, "gemini_map_texts", side_effect=lambda texts, **kw: texts), patch.object(
            tr, "generate_voice_map", side_effect=JobCancelled,
        ):
            with self.assertRaises(JobCancelled):
                tr.translate_srt("video", multi_voice=True)
        self.assertFalse((self.root / "translated/video/subtitles_vi.srt").exists())

    def test_partial_batch_falls_back_commits_and_continues_next_batch(self):
        from app.services import gemini_array
        from app.services.checkpoint import read_json
        from app.services.srt_utils import parse_srt

        partial = SimpleNamespace(text="\n".join(f"{i}|Dịch {i}" for i in range(49)))
        logs = []
        with patch.object(gemini_array, "gemini_call_rotating", side_effect=[
            partial, partial, partial, SimpleNamespace(text="0|Dòng cuối"),
        ]) as call:
            result = tr.translate_srt("video", log_fn=lambda text, **kw: logs.append((text, kw)))
        self.assertEqual(call.call_count, 4)
        source = parse_srt(self.source.read_text(encoding="utf-8"))
        translated = parse_srt(result)
        self.assertEqual(len(translated), 51)
        self.assertEqual(translated[49].text, source[49].text)
        self.assertEqual(translated[50].text, "Dòng cuối")
        self.assertEqual([(e.index, e.start, e.end) for e in translated],
                         [(e.index, e.start, e.end) for e in source])
        saved = read_json(next((self.root / "translated").rglob("000000.json")))
        self.assertEqual(saved["texts"][49], source[49].text)
        self.assertTrue(saved["note_done"])
        self.assertEqual(self.note.call_count, 2)
        self.assertTrue(any("giữ nguyên văn bản gốc" in text and kw.get("level") == "warning"
                            for text, kw in logs))
        with patch.object(gemini_array, "gemini_call_rotating", side_effect=AssertionError("no repeat requests")):
            restored = tr.translate_srt("video")
        self.assertEqual(restored, result)
        self.assertEqual(self.note.call_count, 2)

    def test_fallback_checkpoint_survives_pause_before_context_note(self):
        from app.services import gemini_array

        def pause_note(*args, **kwargs):
            raise JobCancelled()

        with patch.object(gemini_array, "gemini_call_rotating", return_value=SimpleNamespace(text="0|Đã dịch")), patch.object(
            tr, "_build_patch_context_note", side_effect=pause_note,
        ):
            with self.assertRaises(JobCancelled):
                tr.translate_srt("video")
        self.assertFalse((self.root / "translated/video/subtitles_vi.srt").exists())
        with patch.object(gemini_array, "gemini_call_rotating", return_value=SimpleNamespace(text="0|Dòng cuối")) as call:
            result = tr.translate_srt("video")
        self.assertEqual(call.call_count, 1, "only the second batch needs a translation request")
        self.assertEqual(len(tr.parse_srt(result)), 51)


class DubCheckpointTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.enterContext(patch.object(settings, "temp_dir", self.root))
        self.enterContext(patch.object(settings, "tts_workers", 1))
        self.enterContext(patch("app.services.dub_checkpoint._get_audio_duration", return_value=1.0))
        self.enterContext(patch.object(tts, "_get_tts_client", return_value="token"))
        self.enterContext(patch.object(tts, "_texts_similar", return_value=False))

    @staticmethod
    def synth(token, entry, out_dir, index, **kwargs):
        path = out_dir / f"{index:04d}.mp3"
        path.write_bytes(f"audio {entry.text}".encode())
        return path

    def run_tts(self, **kwargs):
        options = dict(video_id="video", entries=entries(3), engine="google", voice="voice")
        options.update(kwargs)
        return synthesize_checkpointed(**options)

    def test_failure_resume_and_existing_audio_api_layout(self):
        def fail(token, entry, out_dir, index, **kwargs):
            if index == 2:
                raise RuntimeError("network")
            return self.synth(token, entry, out_dir, index)

        with patch.object(tts, "_synthesize_with_retry", side_effect=fail):
            with self.assertRaises(RuntimeError):
                self.run_tts()
        with patch.object(tts, "_synthesize_with_retry", side_effect=self.synth) as call:
            paths = self.run_tts()
            self.assertEqual(call.call_count, 2)
            self.assertEqual(paths[0], self.root / "tts/video/voice/0001.mp3")
            self.run_tts()
            self.assertEqual(call.call_count, 2)

    def test_configuration_and_content_invalidate_only_changed_lines(self):
        with patch.object(tts, "_synthesize_with_retry", side_effect=self.synth) as call:
            self.run_tts()
            changed = entries(3)
            changed[1].text = "different"
            self.run_tts(entries=changed)
            self.assertEqual(call.call_count, 4)
            self.run_tts(entries=changed, voice="other")
            self.assertEqual(call.call_count, 7)
            self.run_tts(entries=changed, voice="other", rate="1.2")
            self.assertEqual(call.call_count, 10)

    def test_partial_corrupt_audio_is_not_reused(self):
        with patch.object(tts, "_synthesize_with_retry", side_effect=self.synth) as call:
            self.run_tts()
            next((self.root / "tts/video/checkpoints").rglob("0002.mp3")).write_bytes(b"partial")
            self.run_tts()
            self.assertEqual(call.call_count, 4)

    def test_voice_review_regeneration_is_preserved(self):
        with patch.object(tts, "_synthesize_with_retry", side_effect=self.synth) as call:
            paths = self.run_tts()
            paths[1].write_bytes(b"manually regenerated audio")
            paths = self.run_tts()
            self.assertEqual(call.call_count, 3)
            self.assertEqual(paths[1].read_bytes(), b"manually regenerated audio")

    def test_pause_saves_inflight_completed_line_and_starts_no_next_call(self):
        cancelled = [False]

        def pause(*args, **kwargs):
            path = self.synth(*args, **kwargs)
            cancelled[0] = True
            return path

        with patch.object(tts, "_synthesize_with_retry", side_effect=pause) as call:
            with self.assertRaises(JobCancelled):
                self.run_tts(cancelled_cb=lambda: cancelled[0])
            self.assertEqual(call.call_count, 1)
        with patch.object(tts, "_synthesize_with_retry", side_effect=self.synth) as call:
            self.run_tts()
            self.assertEqual(call.call_count, 2)

    def test_capcut_interrupted_batch_is_retried_whole(self):
        cancelled = [False]

        def partial(texts, out_dir, indices, on_download, **kwargs):
            path = out_dir / "download.mp3"
            path.write_bytes(b"voice")
            on_download(indices[0], path)
            self.assertEqual(list((self.root / "tts/video/checkpoints").rglob("batch.json")), [])
            cancelled[0] = True
            raise JobCancelled()

        with patch.object(capcut, "generate_segments_to_dir", side_effect=partial):
            with self.assertRaises(JobCancelled):
                self.run_tts(engine="capcut", cancelled_cb=lambda: cancelled[0])

        def finish(texts, out_dir, indices, on_download, **kwargs):
            for index in indices:
                path = out_dir / f"{index}.mp3"
                path.write_bytes(b"voice")
                on_download(index, path)

        with patch.object(capcut, "generate_segments_to_dir", side_effect=finish) as call:
            self.run_tts(engine="capcut")
            self.assertEqual(call.call_args.kwargs["indices"], [1, 2, 3])

    def test_multi_voice_changed_assignment_invalidates_whole_batch(self):
        def finish(texts, out_dir, indices, on_download, **kwargs):
            for index in indices:
                path = out_dir / f"{index}.mp3"
                path.write_bytes(b"voice")
                on_download(index, path)

        with patch.object(capcut, "generate_segments_to_dir", side_effect=finish) as call:
            paths = self.run_tts(engine="capcut", voice_map={1: "A", 2: "B", 3: "A"})
            self.assertEqual(paths[1].parent.name, "B")
            call.reset_mock()
            self.run_tts(engine="capcut", voice_map={1: "A", 2: "C", 3: "A"})
            self.assertEqual(call.call_count, 2)
            self.assertEqual([c.kwargs["indices"] for c in call.call_args_list], [[1, 3], [2]])

    def test_capcut_three_attempts_commit_failure_silence_and_reuse_on_resume(self):
        import json

        logs = []
        progress = []

        def partial(texts, out_dir, indices, on_download, **kwargs):
            if 1 in indices:
                path = out_dir / "success.mp3"
                path.write_bytes(b"real voice")
                on_download(1, path)
            raise RuntimeError("CapCut unavailable")

        def silence(path, duration, kind="fail"):
            path.write_bytes(b"silence")

        with patch.object(capcut, "generate_segments_to_dir", side_effect=partial) as call, patch.object(
            tts, "_create_silence", side_effect=silence,
        ) as silent:
            paths = self.run_tts(engine="capcut", log_fn=lambda text, **kw: logs.append((text, kw)),
                                 progress_callback=lambda done, total: progress.append((done, total)))
            self.assertEqual(call.call_count, 3)
            self.assertEqual([c.kwargs["indices"] for c in call.call_args_list], [[1, 2, 3], [2, 3], [2, 3]])
            self.assertEqual(silent.call_count, 2)
            self.assertEqual(progress[-1], (3, 3))
            self.assertEqual(paths[0].read_bytes(), b"real voice")
            self.assertEqual([tts._read_silence_kind(p) for p in paths], [None, "fail", "fail"])
            self.assertTrue(any("chèn khoảng lặng" in text and kw.get("level") == "warning" for text, kw in logs))
            metadata = [json.loads(p.read_text()) for p in (self.root / "tts/video/checkpoints").rglob("batch.json")]
            self.assertEqual(metadata[0]["files"]["2"]["silence_kind"], "fail")
            self.assertEqual(metadata[0]["failed_indices"], [2, 3])
            self.assertTrue(any("sau 3 lượt" in text for text, _ in logs))

        def finish(texts, out_dir, indices, on_download, **kwargs):
            for index in indices:
                path = out_dir / f"{index}.mp3"
                path.write_bytes(b"recovered voice")
                on_download(index, path)

        with patch.object(capcut, "generate_segments_to_dir", side_effect=finish) as call:
            restored = self.run_tts(engine="capcut")
            self.assertEqual([tts._read_silence_kind(p) for p in restored], [None, "fail", "fail"])
            self.assertEqual([p.read_bytes() for p in restored], [b"real voice", b"silence", b"silence"])
            self.run_tts(engine="capcut")
            call.assert_not_called()

    def test_multi_voice_failed_lines_keep_assignment_and_insert_silence(self):
        def silence(path, duration, kind="fail"):
            path.write_bytes(b"silence")

        with patch.object(capcut, "generate_segments_to_dir", side_effect=RuntimeError("no audio")) as call, patch.object(
            tts, "_create_silence", side_effect=silence,
        ):
            paths = self.run_tts(engine="capcut", voice_map={1: "A", 2: "B", 3: "A"})
            self.assertEqual(call.call_count, 6, "three attempts per voice group")
        self.assertEqual([p.parent.name for p in paths], ["A", "B", "A"])
        self.assertTrue(all(tts._read_silence_kind(p) == "fail" for p in paths))
        with patch.object(capcut, "generate_segments_to_dir") as call:
            restored = self.run_tts(engine="capcut", voice_map={1: "A", 2: "B", 3: "A"})
            call.assert_not_called()
            self.assertTrue(all(tts._read_silence_kind(p) == "fail" for p in restored))

    @staticmethod
    def capcut_finish(texts, out_dir, indices, on_download, **kwargs):
        for index in indices:
            path = out_dir / f"{index}.mp3"
            path.write_bytes(f"voice {index}".encode())
            on_download(index, path)

    def test_capcut_150_line_batches_resume_only_committed_batches(self):
        calls = []

        def interrupt_second(*args, **kwargs):
            calls.append(kwargs["indices"])
            if len(calls) == 2:
                raise JobCancelled()
            self.capcut_finish(*args, **kwargs)

        with patch.object(capcut, "generate_segments_to_dir", side_effect=interrupt_second):
            with self.assertRaises(JobCancelled):
                self.run_tts(engine="capcut", entries=entries(301))
        self.assertEqual([len(batch) for batch in calls], [150, 150])
        self.assertEqual(len(list((self.root / "tts/video/checkpoints").rglob("batch.json"))), 1)
        with patch.object(capcut, "generate_segments_to_dir", side_effect=self.capcut_finish) as call:
            paths = self.run_tts(engine="capcut", entries=entries(301))
            self.assertEqual([c.kwargs["indices"] for c in call.call_args_list],
                             [list(range(151, 301)), [301]])
            self.assertEqual(len(paths), 301)
            self.run_tts(engine="capcut", entries=entries(301))
            self.assertEqual(call.call_count, 2)

    def test_capcut_corruption_and_content_change_invalidate_only_affected_batch(self):
        captions = entries(151)
        with patch.object(capcut, "generate_segments_to_dir", side_effect=self.capcut_finish) as call:
            self.run_tts(engine="capcut", entries=captions)
            next((self.root / "tts/video/checkpoints").rglob("0002.mp3")).write_bytes(b"corrupt")
            call.reset_mock()
            self.run_tts(engine="capcut", entries=captions)
            self.assertEqual([c.kwargs["indices"] for c in call.call_args_list], [list(range(1, 151))])
            captions[150].text = "changed last batch"
            call.reset_mock()
            self.run_tts(engine="capcut", entries=captions)
            self.assertEqual(call.call_args.kwargs["indices"], [151])
            self.assertEqual(call.call_count, 1)

    def test_capcut_cancel_during_commit_leaves_no_reusable_partial_batch(self):
        from app.services import dub_checkpoint as checkpoint

        cancelled = [False]
        original = checkpoint.atomic_bytes

        def stop_during_write(path, content):
            original(path, content)
            if path.name == "0001.mp3":
                cancelled[0] = True

        with patch.object(capcut, "generate_segments_to_dir", side_effect=self.capcut_finish), patch.object(
            checkpoint, "atomic_bytes", side_effect=stop_during_write,
        ):
            with self.assertRaises(JobCancelled):
                self.run_tts(engine="capcut", cancelled_cb=lambda: cancelled[0])
        self.assertEqual(list((self.root / "tts/video/checkpoints").rglob("batch.json")), [])
        with patch.object(capcut, "generate_segments_to_dir", side_effect=self.capcut_finish) as call:
            self.run_tts(engine="capcut")
            self.assertEqual(call.call_args.kwargs["indices"], [1, 2, 3])

    def test_capcut_voice_review_edits_survive_batch_restore(self):
        with patch.object(capcut, "generate_segments_to_dir", side_effect=self.capcut_finish) as call:
            paths = self.run_tts(engine="capcut")
            paths[1].write_bytes(b"manual voice edit")
            restored = self.run_tts(engine="capcut")
            self.assertEqual(restored[1].read_bytes(), b"manual voice edit")
            self.assertEqual(call.call_count, 1)

    def test_capcut_manifest_write_failure_does_not_commit_audio_files(self):
        from app.services import dub_checkpoint as checkpoint

        original = checkpoint.atomic_json

        def fail_manifest(path, value):
            if path.name == "batch.json":
                raise OSError("disk write failed")
            original(path, value)

        with patch.object(capcut, "generate_segments_to_dir", side_effect=self.capcut_finish), patch.object(
            checkpoint, "atomic_json", side_effect=fail_manifest,
        ):
            with self.assertRaisesRegex(OSError, "disk write failed"):
                self.run_tts(engine="capcut")
        self.assertTrue(list((self.root / "tts/video/checkpoints").rglob("*.mp3")))
        self.assertEqual(list((self.root / "tts/video/checkpoints").rglob("batch.json")), [])
        with patch.object(capcut, "generate_segments_to_dir", side_effect=self.capcut_finish) as call:
            self.run_tts(engine="capcut")
            self.assertEqual(call.call_args.kwargs["indices"], [1, 2, 3])

    def test_capcut_multi_voice_batch_waits_for_all_voice_groups(self):
        def interrupt_voice(*args, **kwargs):
            self.assertEqual(list((self.root / "tts/video/checkpoints").rglob("batch.json")), [])
            if kwargs["voice"] == "B":
                raise JobCancelled()
            self.capcut_finish(*args, **kwargs)

        mapping = {1: "A", 2: "B", 3: "A"}
        with patch.object(capcut, "generate_segments_to_dir", side_effect=interrupt_voice):
            with self.assertRaises(JobCancelled):
                self.run_tts(engine="capcut", voice_map=mapping)
        with patch.object(capcut, "generate_segments_to_dir", side_effect=self.capcut_finish) as call:
            self.run_tts(engine="capcut", voice_map=mapping)
            self.assertEqual([c.kwargs["indices"] for c in call.call_args_list], [[1, 3], [2]])

    def test_capcut_blank_lines_and_settings_changes(self):
        captions = entries(3)
        captions[1].text = " "
        with patch.object(capcut, "generate_segments_to_dir", side_effect=self.capcut_finish) as call:
            paths = self.run_tts(engine="capcut", entries=captions)
            self.assertIsNone(paths[1])
            self.assertEqual(call.call_args.kwargs["indices"], [1, 3])
            self.run_tts(engine="capcut", entries=captions)
            self.assertEqual(call.call_count, 1)
            self.run_tts(engine="capcut", entries=captions, voice="other")
            self.run_tts(engine="capcut", entries=captions, voice="other", rate="1.2")
            self.assertEqual(call.call_count, 3)

    def test_capcut_duplicate_silence_is_part_of_reusable_batch(self):
        def silence(path, duration, kind="fail"):
            path.write_bytes(b"silence")

        with patch.object(tts, "_texts_similar", return_value=True), patch.object(
            tts, "_create_silence", side_effect=silence,
        ) as silence, patch.object(capcut, "generate_segments_to_dir", side_effect=self.capcut_finish) as call:
            paths = self.run_tts(engine="capcut")
            self.assertEqual([tts._read_silence_kind(p) for p in paths], [None, "dup", "dup"])
            self.run_tts(engine="capcut")
            self.assertEqual(silence.call_count, 2)
            self.assertEqual(call.call_count, 1)

    def test_capcut_all_completed_batches_are_reused_including_failure_silence(self):
        def fail_last(*args, **kwargs):
            if kwargs["indices"] == [151]:
                raise RuntimeError("unavailable")
            self.capcut_finish(*args, **kwargs)

        def silence(path, duration, kind="fail"):
            path.write_bytes(b"silence")

        with patch.object(capcut, "generate_segments_to_dir", side_effect=fail_last), patch.object(
            tts, "_create_silence", side_effect=silence,
        ):
            paths = self.run_tts(engine="capcut", entries=entries(151))
            self.assertEqual(tts._read_silence_kind(paths[-1]), "fail")
        with patch.object(capcut, "generate_segments_to_dir", side_effect=self.capcut_finish) as call:
            restored = self.run_tts(engine="capcut", entries=entries(151))
            call.assert_not_called()
            self.assertEqual(tts._read_silence_kind(restored[-1]), "fail")

    def test_pause_is_not_converted_to_failure_silence(self):
        with patch.object(capcut, "generate_segments_to_dir", side_effect=JobCancelled), patch.object(
            tts, "_create_silence",
        ) as silence:
            with self.assertRaises(JobCancelled):
                self.run_tts(engine="capcut")
            silence.assert_not_called()

    def test_resume_skips_failed_committed_batch_and_restarts_only_interrupted_batch(self):
        import json

        def pause_after_failed_batch(*args, **kwargs):
            if kwargs["indices"] == [151]:
                raise JobCancelled()
            raise RuntimeError("CapCut unavailable")

        def silence(path, duration, kind="fail"):
            path.write_bytes(b"silence")

        with patch.object(capcut, "generate_segments_to_dir", side_effect=pause_after_failed_batch) as call, patch.object(
            tts, "_create_silence", side_effect=silence,
        ):
            with self.assertRaises(JobCancelled):
                self.run_tts(engine="capcut", entries=entries(151))
            self.assertEqual(call.call_count, 4, "three failed attempts then pause in the next batch")
        manifest = next((self.root / "tts/video/checkpoints").rglob("batch.json"))
        saved = manifest.read_bytes()
        self.assertEqual(len(json.loads(saved)["failed_indices"]), 150)
        with patch.object(capcut, "generate_segments_to_dir", side_effect=self.capcut_finish) as call:
            paths = self.run_tts(engine="capcut", entries=entries(151))
            self.assertEqual(call.call_count, 1)
            self.assertEqual(call.call_args.kwargs["indices"], [151])
            self.assertTrue(all(tts._read_silence_kind(p) == "fail" for p in paths[:150]))
            self.assertIsNone(tts._read_silence_kind(paths[150]))
            self.assertEqual(manifest.read_bytes(), saved, "old manifests are reused without migration")

    def test_corrupt_failure_silence_is_not_reused_as_a_valid_checkpoint(self):
        def silence(path, duration, kind="fail"):
            path.write_bytes(b"silence")

        with patch.object(capcut, "generate_segments_to_dir", side_effect=RuntimeError("unavailable")), patch.object(
            tts, "_create_silence", side_effect=silence,
        ):
            self.run_tts(engine="capcut")
        next((self.root / "tts/video/checkpoints").rglob("0002.mp3")).write_bytes(b"corrupt")
        with patch.object(capcut, "generate_segments_to_dir", side_effect=self.capcut_finish) as call:
            restored = self.run_tts(engine="capcut")
            self.assertEqual(call.call_args.kwargs["indices"], [1, 2, 3])
            self.assertEqual(call.call_count, 1)
            self.assertTrue(all(tts._read_silence_kind(p) is None for p in restored))

    def test_manual_voice_edit_of_failure_silence_keeps_other_failure_markers(self):
        import json

        def silence(path, duration, kind="fail"):
            path.write_bytes(b"silence")

        with patch.object(capcut, "generate_segments_to_dir", side_effect=RuntimeError("unavailable")), patch.object(
            tts, "_create_silence", side_effect=silence,
        ):
            paths = self.run_tts(engine="capcut")
        paths[1].write_bytes(b"manually generated voice")
        with patch.object(capcut, "generate_segments_to_dir") as call:
            restored = self.run_tts(engine="capcut")
            call.assert_not_called()
            self.assertEqual([tts._read_silence_kind(p) for p in restored], ["fail", None, "fail"])
            self.assertEqual(restored[1].read_bytes(), b"manually generated voice")
        manifest = next((self.root / "tts/video/checkpoints").rglob("batch.json"))
        self.assertEqual(json.loads(manifest.read_text())["failed_indices"], [1, 3])

    def test_duplicate_silence_remains_a_reusable_success(self):
        def silence(path, duration, kind="fail"):
            path.write_bytes(b"silence")

        with patch.object(tts, "_texts_similar", return_value=True), patch.object(
            tts, "_create_silence", side_effect=silence,
        ) as silence, patch.object(tts, "_synthesize_with_retry", side_effect=self.synth) as synth:
            paths = self.run_tts()
            self.assertEqual([tts._read_silence_kind(p) for p in paths], [None, "dup", "dup"])
            self.run_tts()
            self.assertEqual(silence.call_count, 2)
            self.assertEqual(synth.call_count, 1)


class CheckpointResetTests(unittest.IsolatedAsyncioTestCase):
    async def test_retry_keeps_good_checkpoints_when_completed_audio_contains_failed_lines(self):
        from app.routers.video import reset_video_from_step

        with tempfile.TemporaryDirectory() as temp, patch.object(settings, "temp_dir", Path(temp)):
            root = Path(temp)
            (root / "videos/video").mkdir(parents=True)
            checkpoint = root / "tts/video/checkpoints/good.json"
            checkpoint.parent.mkdir(parents=True)
            checkpoint.write_text("saved")
            (checkpoint.parent.parent / "full_audio.m4a").write_bytes(b"completed with silence")
            (checkpoint.parent.parent / "full_voice.meta.json").write_text('{"failed_indices": [2]}')
            await reset_video_from_step("video", {"from_step": 8})
            self.assertTrue(checkpoint.exists())
            self.assertFalse((checkpoint.parent.parent / "full_audio.m4a").exists())
            await reset_video_from_step("video", {"from_step": 8, "discard_checkpoint": True})
            self.assertFalse(checkpoint.exists())

    async def test_retry_preserves_but_explicit_fresh_run_discards(self):
        from app.routers.video import reset_video_from_step

        with tempfile.TemporaryDirectory() as temp, patch.object(settings, "temp_dir", Path(temp)):
            root = Path(temp)
            (root / "videos/video").mkdir(parents=True)
            for name, step in (("translated", 7), ("tts", 8)):
                checkpoint = root / name / "video/checkpoints/test.json"
                checkpoint.parent.mkdir(parents=True, exist_ok=True)
                checkpoint.write_text("saved")
                await reset_video_from_step("video", {"from_step": step})
                self.assertTrue(checkpoint.exists())
                await reset_video_from_step("video", {"from_step": step, "discard_checkpoint": True})
                self.assertFalse(checkpoint.exists())


class ApiCheckpointClientTests(unittest.TestCase):
    def test_gemini_pause_does_not_rotate_into_another_request(self):
        from app.services import retry_utils

        cancelled = [False]
        calls = []

        def request(**kwargs):
            calls.append(kwargs)
            cancelled[0] = True
            raise RuntimeError("rate limit")

        with patch.object(retry_utils, "configured_gemini_keys", return_value=["fake"]), patch.object(
            retry_utils, "_should_retry", return_value=True,
        ), patch.object(retry_utils.time, "sleep"):
            with self.assertRaises(JobCancelled):
                retry_utils.gemini_call_rotating(lambda *a, **kw: request,
                                                 _cancelled_cb=lambda: cancelled[0])
        self.assertEqual(len(calls), 1)

    def test_failed_checkpoint_publish_preserves_previous_file(self):
        from app.services import checkpoint

        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "batch.json"
            checkpoint.atomic_json(path, {"previous": True})
            with patch.object(checkpoint.os, "replace", side_effect=OSError("disk")):
                with self.assertRaises(OSError):
                    checkpoint.atomic_json(path, {"new": True})
            self.assertEqual(checkpoint.read_json(path), {"previous": True})
            self.assertEqual(list(Path(temp).iterdir()), [path])

    def test_capcut_restart_404_does_not_poll_until_timeout(self):
        import httpx

        response = httpx.Response(404, request=httpx.Request("GET", "http://test/job"))
        with patch.object(capcut.httpx, "get", return_value=response) as call:
            with self.assertRaises(capcut.CapCutTTSError):
                capcut.poll_job("lost-job", timeout=600)
            self.assertEqual(call.call_count, 1)

    def test_capcut_pause_cancels_remote_job_without_polling(self):
        with patch.object(capcut.httpx, "post") as cancel, patch.object(capcut.httpx, "get") as get:
            with self.assertRaises(JobCancelled):
                capcut.poll_job("job", cancelled_cb=lambda: True)
            self.assertIn("/job/cancel", cancel.call_args.args[0])
            get.assert_not_called()

    def test_incomplete_gemini_response_keeps_original_after_retries(self):
        from app.services import gemini_array

        logs = []
        with patch.object(gemini_array, "gemini_call_rotating", return_value=SimpleNamespace(text="0|Dịch")) as call:
            result = gemini_array.gemini_map_texts(
                ["one", "two"], "prompt", "system", log_fn=lambda text, **kw: logs.append((text, kw)),
            )
        self.assertEqual(result, ["Dịch", "two"])
        self.assertEqual(call.call_count, 3)
        self.assertIn("giữ nguyên văn bản gốc", logs[-1][0])
        self.assertEqual(logs[-1][1]["level"], "warning")
        self.assertNotIn("hỏi lại", logs[-2][0])

    def test_gemini_request_failures_keep_original_without_swallowing_pause(self):
        from app.services import gemini_array

        with patch.object(gemini_array, "gemini_call_rotating", side_effect=RuntimeError("network")) as call:
            self.assertEqual(gemini_array.gemini_map_texts(["one", "two"], "prompt", "system"), ["one", "two"])
            self.assertEqual(call.call_count, 3)
        with patch.object(gemini_array, "gemini_call_rotating", side_effect=JobCancelled) as call:
            with self.assertRaises(JobCancelled):
                gemini_array.gemini_map_texts(["one"], "prompt", "system")
            self.assertEqual(call.call_count, 1)


class DubCheckpointIntegrationTests(unittest.TestCase):
    def test_full_voice_with_failed_silence_is_reused_without_automatic_repair(self):
        import json
        from app.services import dub_service as dub

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source.mp4"
            source.write_bytes(b"video")
            srt = root / "source.srt"
            srt.write_text(entries_to_srt(entries(3)), encoding="utf-8")
            background = root / "background.wav"
            background.write_bytes(b"background")
            voice_dir = root / "tts/video/voice"
            voice_dir.mkdir(parents=True)
            audio_files = [voice_dir / f"{i:04d}.mp3" for i in range(1, 4)]
            for audio in audio_files:
                audio.write_bytes(b"audio")
            marker = audio_files[1].with_name("0002.mp3.silence")
            marker.write_text("fail")
            attempts = []

            def synthesize(*args, **kwargs):
                attempts.append(True)
                return audio_files

            def combine(files, captions, target):
                target.write_bytes(b"full voice")

            def mix(bg, voice, gain, target, **kwargs):
                target.write_bytes(b"mixed")

            with patch.object(settings, "temp_dir", root), patch.object(
                dub, "_video_path", return_value=source,
            ), patch.object(dub, "_merge_audio_path", return_value=None), patch.object(
                dub, "_srt_best_path", return_value=srt,
            ), patch.object(dub, "extract_audio", return_value=background), patch.object(
                dub, "merge_similar_adjacent", side_effect=lambda e: (e, []),
            ), patch.object(dub, "_ensure_free_space"), patch.object(
                dub, "_get_audio_duration", return_value=10,
            ), patch.object(dub, "_mix_background_with_voice", side_effect=mix) as mixed, patch.object(
                dub, "combine_tts_mp3", side_effect=combine,
            ), patch.object(dub, "synthesize_checkpointed", side_effect=synthesize):
                dub.build_full_audio("video", voice_name="voice", tts_engine="capcut", mute_original=False)
                meta = root / "tts/video/full_voice.meta.json"
                self.assertEqual(json.loads(meta.read_text())["failed_indices"], [2])
                dub.build_full_audio("video", voice_name="voice", tts_engine="capcut", mute_original=False)
                self.assertEqual(json.loads(meta.read_text())["failed_indices"], [2])
                self.assertEqual(len(attempts), 1)
                self.assertEqual(mixed.call_count, 1)
                dub.build_full_audio("video", voice_name="voice", tts_engine="capcut", mute_original=False)
                self.assertEqual(len(attempts), 1, "failure metadata must not force a repair pass")
                self.assertEqual(marker.read_text(), "fail")

    def test_resume_after_combine_failure_does_not_regenerate_tts(self):
        from app.services import dub_service as dub

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source.mp4"
            source.write_bytes(b"video")
            srt = root / "source.srt"
            srt.write_text(entries_to_srt(entries(3)), encoding="utf-8")
            background = root / "background.wav"
            background.write_bytes(b"background")

            def combine(files, captions, target):
                target.write_bytes(b"full voice")

            def mix(bg, voice, gain, target, **kwargs):
                target.write_bytes(b"mixed")

            with patch.object(settings, "temp_dir", root), patch.object(settings, "tts_workers", 1), patch.object(
                dub, "_video_path", return_value=source,
            ), patch.object(dub, "_merge_audio_path", return_value=None), patch.object(
                dub, "_srt_best_path", return_value=srt,
            ), patch.object(dub, "extract_audio", return_value=background), patch.object(
                dub, "merge_similar_adjacent", side_effect=lambda e: (e, []),
            ), patch.object(dub, "_ensure_free_space"), patch.object(
                dub, "_get_audio_duration", return_value=10,
            ), patch.object(dub, "_mix_background_with_voice", side_effect=mix), patch.object(
                tts, "_get_tts_client", return_value="token",
            ), patch.object(tts, "_texts_similar", return_value=False), patch(
                "app.services.dub_checkpoint._get_audio_duration", return_value=1,
            ), patch.object(tts, "_synthesize_with_retry", side_effect=DubCheckpointTests.synth) as synth:
                with patch.object(dub, "combine_tts_mp3", side_effect=RuntimeError("ffmpeg failed")):
                    with self.assertRaises(RuntimeError):
                        dub.build_full_audio("video", mute_original=False)
                self.assertFalse((root / "tts/video/full_voice.mp3").exists())
                self.assertFalse((root / "tts/video/full_voice.partial.mp3").exists())
                with patch.object(dub, "combine_tts_mp3", side_effect=combine) as combine_call:
                    result = dub.build_full_audio("video", mute_original=False)
                    self.assertTrue(result.exists())
                    self.assertEqual(synth.call_count, 3)
                    dub.build_full_audio("video", mute_original=False)
                    self.assertEqual(synth.call_count, 3)
                    self.assertEqual(combine_call.call_count, 1)


class CompletedCheckpointResetTests(unittest.IsolatedAsyncioTestCase):
    async def test_completed_step_rerun_discards_old_checkpoints(self):
        from app.routers.video import reset_video_from_step

        with tempfile.TemporaryDirectory() as temp, patch.object(settings, "temp_dir", Path(temp)):
            root = Path(temp)
            (root / "videos/video").mkdir(parents=True)
            for name, final, step in (("translated", "subtitles_vi.srt", 7), ("tts", "full_audio.m4a", 8)):
                checkpoint = root / name / "video/checkpoints/test.json"
                checkpoint.parent.mkdir(parents=True, exist_ok=True)
                checkpoint.write_text("saved")
                (checkpoint.parent.parent / final).write_text("complete")
                await reset_video_from_step("video", {"from_step": step})
                self.assertFalse(checkpoint.exists())


if __name__ == "__main__":
    unittest.main()
