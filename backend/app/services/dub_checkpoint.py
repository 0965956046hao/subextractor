"""Durable TTS results: CapCut batches and Google per-line checkpoints."""

import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from app.config import settings
from app.services.checkpoint import atomic_bytes, atomic_json, fingerprint, read_json
from app.services.job_utils import JobCancelled
from app.services.media_utils import _get_audio_duration


def dub_identity(entries, engine, voice, rate, voice_map):
    return fingerprint({"version": 1, "entries": [(e.start, e.end, e.text) for e in entries],
                        **({"checkpoint_policy": "batch150-v1"} if engine == "capcut" else {}),
                        "engine": engine, "voice": voice, "rate": rate,
                        "voice_map": {str(k): v for k, v in voice_map.items()}})


def synthesize_checkpointed(video_id, entries, engine, voice, rate="1.0", voice_map=None,
                           progress_callback=None, log_fn=None, cancelled_cb=None):
    if engine == "capcut":
        return _synthesize_capcut_batches(video_id, entries, voice, rate, voice_map or {},
                                          progress_callback, log_fn, cancelled_cb)
    from app.services.tts_service import (
        _get_tts_client, _synthesize_with_retry, _create_silence, _texts_similar,
        _clear_silence_marker, _silence_marker_path,
    )

    voice_map = voice_map or {}
    root = settings.temp_dir / "tts" / video_id / "checkpoints"
    files = [None] * len(entries)
    pending = []
    completed = 0
    lock = threading.Lock()
    stopped = threading.Event()

    def check():
        if stopped.is_set() or (cancelled_cb is not None and cancelled_cb()):
            raise JobCancelled()

    def report():
        if progress_callback:
            progress_callback(completed, len(entries))

    def valid(path, meta):
        try:
            data = path.read_bytes()
            return (isinstance(meta, dict) and meta.get("sha256") == fingerprint(data.hex())
                    and meta.get("silence_kind") != "fail"
                    and _get_audio_duration(path) > 0)
        except (OSError, ValueError, RuntimeError):
            return False

    def publish(index, generated, silence_kind=None):
        nonlocal completed
        _, target, _, _ = pending_by_index[index]
        if _get_audio_duration(generated) <= 0:
            raise RuntimeError(f"Audio TTS dòng {index + 1} không hợp lệ")
        data = generated.read_bytes()
        atomic_bytes(target, data)
        atomic_json(target.with_suffix(".json"), {"sha256": fingerprint(data.hex()),
                                                "silence_kind": silence_kind})
        with lock:
            files[index] = target
            completed += 1
            report()

    def project():
        # Preserve the existing per-line audio API/voice-review file layout.
        for i, cached in enumerate(files):
            if cached is None:
                continue
            assigned = voice_map.get(i + 1) or voice_map.get(str(i + 1)) or voice
            alias = root.parent / assigned.replace("-", "_") / f"{i + 1:04d}.mp3"
            data = cached.read_bytes()
            meta = read_json(cached.with_suffix(".json")) or {}
            kind = meta.get("silence_kind")
            if not alias.exists() or alias.read_bytes() != data:
                atomic_bytes(alias, data)
            atomic_json(alias.with_suffix(".checkpoint.json"),
                        {"key": cached.parent.name, "sha256": fingerprint(data.hex()), "silence_kind": kind})
            if kind in ("fail", "dup"):
                atomic_bytes(_silence_marker_path(alias), kind.encode("utf-8"))
            else:
                _clear_silence_marker(alias)
            files[i] = alias

    previous = ""
    for i, entry in enumerate(entries):
        check()
        text = entry.text.strip()
        assigned = voice_map.get(i + 1) or voice_map.get(str(i + 1)) or voice
        # Keep the existing duplicate-line silence policy for single voice only.
        duplicate = not voice_map and bool(previous) and _texts_similar(previous, text)
        key = fingerprint({"version": 1, "text": text, "engine": engine, "voice": assigned,
                           "rate": rate, "duplicate": duplicate,
                           "duration": max(entry.end - entry.start, 0.5) if duplicate else None})
        target = root / key / f"{i + 1:04d}.mp3"
        # Voice-review/regenerate writes to the public per-line path. Accept
        # such edits only if that path was projected for this exact identity;
        # never import unverified legacy audio or audio from another engine.
        alias = root.parent / assigned.replace("-", "_") / f"{i + 1:04d}.mp3"
        marker = read_json(alias.with_suffix(".checkpoint.json"))
        if isinstance(marker, dict) and marker.get("key") == key and alias.exists():
            data = alias.read_bytes()
            checksum = fingerprint(data.hex())
            if checksum != marker.get("sha256") and _get_audio_duration(alias) > 0:
                atomic_bytes(target, data)
                atomic_json(target.with_suffix(".json"), {"sha256": checksum})
        if not text:
            completed += 1
        elif valid(target, read_json(target.with_suffix(".json"))):
            files[i] = target
            completed += 1
        else:
            pending.append((i, target, assigned, duplicate))
        previous = text
    pending_by_index = {p[0]: p for p in pending}
    report()
    if log_fn:
        log_fn(f"Checkpoint lồng tiếng: khôi phục {completed}/{len(entries)} dòng; còn {len(pending)} dòng.")

    # Attempt-specific scratch paths prevent interrupted writes from becoming
    # checkpoints. Only validated audio plus its checksum is reusable.
    import tempfile
    with tempfile.TemporaryDirectory(prefix="tts_", dir=_scratch_parent(root)) as temporary:
        scratch = Path(temporary)
        for i, _, _, duplicate in pending:
            if duplicate:
                check()
                path = scratch / f"{i + 1:04d}.mp3"
                _create_silence(path, max(entries[i].end - entries[i].start, 0.5), kind="dup")
                publish(i, path, silence_kind="dup")
        real = [p for p in pending if not p[3]]
        if engine == "google" and real:
            token = _get_tts_client()

            def synthesize(item):
                i, _, assigned, _ = item
                check()
                try:
                    path = _synthesize_with_retry(token, entries[i], scratch, i + 1,
                                                  voice_name=assigned, log_fn=log_fn,
                                                  cancelled_cb=lambda: stopped.is_set() or (
                                                      cancelled_cb is not None and cancelled_cb()))
                    publish(i, path)
                    check()
                except BaseException:
                    stopped.set()
                    raise

            # Each worker checks cancellation before starting the next entry.
            with ThreadPoolExecutor(max_workers=max(1, settings.tts_workers)) as pool:
                futures = [pool.submit(synthesize, item) for item in real]
                errors = []
                for future in futures:
                    try:
                        future.result()
                    except Exception as exc:
                        errors.append(exc)
                if errors:
                    raise next((exc for exc in errors if not isinstance(exc, JobCancelled)), errors[0])
        check()
    project()
    return files


def _scratch_parent(root):
    root.mkdir(parents=True, exist_ok=True)
    return str(root)


def _synthesize_capcut_batches(video_id, entries, voice, rate, voice_map,
                               progress_callback, log_fn, cancelled_cb):
    """Commit one manifest after all 150 lines are staged; never resume partial batches."""
    import tempfile

    from app.services.capcut_tts_client import generate_segments_to_dir
    from app.services.tts_service import (
        _clear_silence_marker, _create_silence, _silence_marker_path, _texts_similar,
    )

    root = settings.temp_dir / "tts" / video_id / "checkpoints" / "capcut_batches_v1"
    root.mkdir(parents=True, exist_ok=True)
    files = [None] * len(entries)
    rows = []
    previous = ""
    for i, entry in enumerate(entries):
        text = entry.text.strip()
        assigned = voice_map.get(i + 1) or voice_map.get(str(i + 1)) or voice
        duplicate = not voice_map and bool(previous) and _texts_similar(previous, text)
        rows.append({"index": i + 1, "text": text, "voice": assigned,
                     "duplicate": duplicate, "start": entry.start, "end": entry.end})
        previous = text

    def check():
        if cancelled_cb is not None and cancelled_cb():
            raise JobCancelled()

    def report(done):
        if progress_callback:
            progress_callback(done, len(entries))

    def checksum(path):
        return fingerprint(path.read_bytes().hex())

    for offset in range(0, len(rows), 150):
        check()
        batch = rows[offset:offset + 150]
        key = fingerprint({"version": 1, "engine": "capcut", "rate": rate, "rows": batch})
        directory = root / key
        manifest_path = directory / "batch.json"
        manifest = read_json(manifest_path)
        records = manifest.get("files") if isinstance(manifest, dict) else None
        # Committed failure silence is a finished fallback, not unfinished work.
        # Keep failure metadata for review, but never retry it just on resume.
        reusable = (isinstance(records, dict) and manifest.get("identity") == key
                    and set(records) == {str(row["index"]) for row in batch if row["text"]})
        if reusable:
            for record_index, record in records.items():
                check()
                path = directory / f"{int(record_index):04d}.mp3"
                try:
                    valid = (isinstance(record, dict) and checksum(path) == record.get("sha256")
                             and _get_audio_duration(path) > 0)
                except OSError:
                    valid = False
                if not valid:
                    reusable = False
                    break

        if not reusable:
            if log_fn:
                log_fn(f"CapCut batch {offset + 1}-{offset + len(batch)}: tạo lại toàn bộ batch (tối đa 150 dòng).")
            # Only this attempt's files can satisfy retries. Legacy per-line
            # checkpoints and uncommitted batch files are deliberately ignored.
            with tempfile.TemporaryDirectory(prefix="batch_", dir=root) as temporary:
                scratch = Path(temporary)
                staged = {}
                kinds = {}
                groups = {}
                for row in batch:
                    check()
                    index = row["index"]
                    if not row["text"]:
                        continue
                    if row["duplicate"]:
                        path = scratch / f"duplicate_{index:04d}.mp3"
                        _create_silence(path, max(row["end"] - row["start"], 0.5), kind="dup")
                        staged[index] = path
                        kinds[index] = "dup"
                    else:
                        groups.setdefault(row["voice"], []).append(row)

                def downloaded(index, path):
                    check()
                    if _get_audio_duration(path) <= 0:
                        raise RuntimeError(f"Audio TTS dòng {index} không hợp lệ")
                    # In-memory bookkeeping only: no durable checkpoint yet.
                    staged[index] = path
                    report(offset + len(staged))

                for assigned, group in groups.items():
                    remaining = group
                    for attempt in range(3):
                        check()
                        if not remaining:
                            break
                        try:
                            generate_segments_to_dir(
                                [row["text"] for row in remaining], scratch,
                                voice=assigned, rate=rate, prefix="checkpoint",
                                indices=[row["index"] for row in remaining], log_fn=log_fn,
                                cancelled_cb=cancelled_cb, on_download=downloaded,
                            )
                        except JobCancelled:
                            raise
                        except Exception as exc:
                            if log_fn:
                                log_fn(f"CapCut batch: lượt {attempt + 1} lỗi: {exc}", level="warning")
                        remaining = [row for row in remaining if row["index"] not in staged]
                    for row in remaining:
                        check()
                        index = row["index"]
                        path = scratch / f"silence_{index:04d}.mp3"
                        duration = max(row["end"] - row["start"], 0.5)
                        _create_silence(path, duration, kind="fail")
                        staged[index] = path
                        kinds[index] = "fail"
                        if log_fn:
                            log_fn(f"Dòng {index}/{len(entries)}: CapCut lỗi sau 3 lượt — "
                                   f"chèn khoảng lặng {duration:.2f}s, tiếp tục; batch đã lưu sẽ được dùng lại khi tiếp tục.",
                                   level="warning")
                records = {}
                for index, path in staged.items():
                    check()
                    # Speech was validated by the download callback already.
                    if index in kinds and _get_audio_duration(path) <= 0:
                        raise RuntimeError(f"Audio TTS dòng {index} không hợp lệ")
                    data = path.read_bytes()
                    atomic_bytes(directory / f"{index:04d}.mp3", data)
                    records[str(index)] = {"sha256": fingerprint(data.hex()),
                                           "silence_kind": kinds.get(index)}
                check()
                manifest = {"identity": key, "files": records,
                            "failed_indices": [i for i, kind in kinds.items() if kind == "fail"]}
                # The manifest is the sole commit point. Any interruption before
                # this write forces the complete batch to be generated again.
                atomic_json(manifest_path, manifest)
        elif log_fn:
            log_fn(f"CapCut checkpoint: khôi phục batch {offset + 1}-{offset + len(batch)}.")

        for row in batch:
            check()
            index = row["index"]
            if not row["text"]:
                continue
            cached = directory / f"{index:04d}.mp3"
            record = records[str(index)]
            alias = root.parent.parent / row["voice"].replace("-", "_") / f"{index:04d}.mp3"
            marker = read_json(alias.with_suffix(".checkpoint.json"))
            # Preserve voice-review edits only for a fully reusable batch with
            # matching provenance. A partial/corrupt batch must be retried whole.
            if (reusable and isinstance(marker, dict) and marker.get("key") == key
                    and alias.exists() and checksum(alias) != marker.get("sha256")
                    and _get_audio_duration(alias) > 0):
                atomic_bytes(cached, alias.read_bytes())
                record.update(sha256=checksum(cached), silence_kind=None)
                manifest["failed_indices"] = sorted(int(i) for i, rec in records.items()
                                                    if rec.get("silence_kind") == "fail")
                atomic_json(manifest_path, manifest)
            data = cached.read_bytes()
            if not alias.exists() or alias.read_bytes() != data:
                atomic_bytes(alias, data)
            atomic_json(alias.with_suffix(".checkpoint.json"), {"key": key, **record})
            kind = record.get("silence_kind")
            if kind in ("dup", "fail"):
                atomic_bytes(_silence_marker_path(alias), kind.encode("utf-8"))
            else:
                _clear_silence_marker(alias)
            files[index - 1] = alias
        report(offset + len(batch))
    check()
    return files
