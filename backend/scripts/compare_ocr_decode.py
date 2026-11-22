"""Sequential isolated OCR runs: NVDEC vs matched FFmpeg CPU control."""

import argparse
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.srt_utils import parse_srt
from rapidfuzz.fuzz import ratio


def compare_subtitles(left, right):
    a = Path(left).read_text(encoding="utf-8")
    b = Path(right).read_text(encoding="utf-8")
    ae, be = parse_srt(a), parse_srt(b)
    am = {(e.startLabel, e.endLabel): e.text for e in ae}
    bm = {(e.startLabel, e.endLabel): e.text for e in be}
    shared = am.keys() & bm.keys()
    changed = [{"start": key[0], "end": key[1], "left": am[key], "right": bm[key]}
               for key in sorted(shared) if am[key] != bm[key]]
    return {"exact_srt_match": a == b, "left_entries": len(ae), "right_entries": len(be),
            "text_similarity_percent": ratio("\n".join(e.text for e in ae), "\n".join(e.text for e in be)),
            "shared_timestamps": len(shared), "changed_text_at_shared_timestamps": changed,
            "left_only_timestamps": sorted(am.keys() - bm.keys()),
            "right_only_timestamps": sorted(bm.keys() - am.keys()),
            "note": "Similarity to a reference is not an accuracy score; there is no ground-truth transcript."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("video_id")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--baseline", type=Path, required=True)
    args = parser.parse_args()
    args.output = args.output.resolve()
    args.output.mkdir(parents=True, exist_ok=False)
    reports = {}
    for mode in ("ffmpeg-gpu", "ffmpeg-cpu"):
        print(f"Starting isolated {mode} run", flush=True)
        subprocess.run([sys.executable, str(Path(__file__).with_name("profile_ocr.py")), args.video_id,
                        "--output", str(args.output / mode), "--decode", mode], check=True)
        reports[mode] = json.loads((args.output / mode / "report.json").read_text(encoding="utf-8"))
    baseline = json.loads((args.baseline / "report.json").read_text(encoding="utf-8"))
    result = {"video_id": args.video_id,
              "baseline_decoder": baseline.get("actual_decoder", baseline.get("decode_backend", "historical_reference")),
              "wall_seconds": {"baseline": baseline["wall_seconds"], **{k: v["wall_seconds"] for k, v in reports.items()}},
              "sampled_frames": {"baseline": baseline["worker_totals"]["sampled_frames"],
                                 **{k: v["worker_totals"]["sampled_frames"] for k, v in reports.items()}},
              "gpu_vs_cpu_subtitles": compare_subtitles(args.output / "ffmpeg-cpu/subtitles.srt",
                                                        args.output / "ffmpeg-gpu/subtitles.srt"),
              "gpu_vs_baseline_subtitles": compare_subtitles(args.baseline / "subtitles.srt",
                                                           args.output / "ffmpeg-gpu/subtitles.srt")}
    (args.output / "comparison.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    # Windows terminals may use cp1252. The UTF-8 report above retains Chinese
    # text; escape console output so successful runs do not fail when printing.
    print(json.dumps(result, ensure_ascii=True, indent=2), flush=True)


if __name__ == "__main__":
    main()
