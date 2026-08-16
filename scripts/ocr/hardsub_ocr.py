#!/usr/bin/env python3
"""
Hardsub OCR for ProfessorDubbedPro — sample bottom band of a video and emit timed cues.

Progress lines: PROGRESS <0-100> <message>
Final JSON on stdout (last line after RESULT).
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path


def emit_progress(pct: int, msg: str) -> None:
    pct = max(0, min(100, int(pct)))
    print(f"PROGRESS {pct} {msg}", flush=True)


def run_ffmpeg_frames(
    ffmpeg: str,
    video: str,
    out_dir: Path,
    interval_s: float,
    crop_bottom_pct: float,
) -> list[tuple[float, Path]]:
    """Extract JPEG frames from the bottom subtitle band."""
    out_dir.mkdir(parents=True, exist_ok=True)
    pattern = str(out_dir / "frame_%06d.jpg")
    # crop=w:h:x:y — keep bottom band of the frame
    crop = f"crop=iw:ih*{crop_bottom_pct / 100.0}:0:ih*(1-{crop_bottom_pct / 100.0})"
    vf = f"fps=1/{max(0.2, interval_s)},{crop}"
    cmd = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        video,
        "-vf",
        vf,
        "-q:v",
        "3",
        pattern,
    ]
    subprocess.run(cmd, check=True)
    frames: list[tuple[float, Path]] = []
    files = sorted(out_dir.glob("frame_*.jpg"))
    for i, path in enumerate(files):
        frames.append((i * interval_s, path))
    return frames


def ocr_frames(frames: list[tuple[float, Path]], hold_s: float) -> list[dict]:
    try:
        from rapidocr_onnxruntime import RapidOCR
    except ImportError as e:
        raise SystemExit(
            "RapidOCR not installed. Run: pnpm ocr:setup\n" + str(e)
        ) from e

    engine = RapidOCR()
    cues: list[dict] = []
    last_text = ""
    last_start = 0.0

    total = max(1, len(frames))
    for i, (t, path) in enumerate(frames):
        if i % 3 == 0 or i + 1 == total:
            emit_progress(10 + int(80 * i / total), f"OCR frame {i + 1}/{total}")
        result, _ = engine(str(path))
        text = ""
        if result:
            lines = [str(item[1]).strip() for item in result if item and len(item) > 1]
            text = " ".join(l for l in lines if l).strip()
        if text == last_text:
            continue
        if last_text:
            end = max(last_start + 0.4, t)
            cues.append(
                {
                    "start_ms": int(round(last_start * 1000)),
                    "end_ms": int(round(end * 1000)),
                    "text": last_text,
                }
            )
        last_text = text
        last_start = t

    if last_text:
        end = last_start + max(hold_s, 1.2)
        cues.append(
            {
                "start_ms": int(round(last_start * 1000)),
                "end_ms": int(round(end * 1000)),
                "text": last_text,
            }
        )
    return cues


def cues_to_srt(cues: list[dict]) -> str:
    def ts(ms: int) -> str:
        h = ms // 3_600_000
        m = (ms % 3_600_000) // 60_000
        s = (ms % 60_000) // 1000
        ms3 = ms % 1000
        return f"{h:02d}:{m:02d}:{s:02d},{ms3:03d}"

    blocks = []
    for i, c in enumerate(cues, 1):
        blocks.append(
            f"{i}\n{ts(c['start_ms'])} --> {ts(c['end_ms'])}\n{c['text']}\n"
        )
    return "\n".join(blocks)


def main() -> int:
    parser = argparse.ArgumentParser(description="Hardsub OCR → timed cues")
    parser.add_argument("--video", required=True)
    parser.add_argument("--ffmpeg", required=True)
    parser.add_argument("--interval", type=float, default=1.0, help="Seconds between samples")
    parser.add_argument(
        "--crop-bottom",
        type=float,
        default=22.0,
        help="Percent of frame height from bottom to OCR",
    )
    parser.add_argument("--hold", type=float, default=1.5)
    parser.add_argument("--srt-out", default="")
    args = parser.parse_args()

    video = Path(args.video)
    if not video.is_file():
        print(f"Video not found: {video}", file=sys.stderr)
        return 2

    emit_progress(2, "Extracting subtitle-band frames…")
    with tempfile.TemporaryDirectory(prefix="pdp-ocr-") as tmp:
        frames = run_ffmpeg_frames(
            args.ffmpeg,
            str(video),
            Path(tmp),
            max(0.25, float(args.interval)),
            max(8.0, min(45.0, float(args.crop_bottom))),
        )
        if not frames:
            emit_progress(100, "No frames")
            print("RESULT " + json.dumps({"engine": "ocr", "segments": [], "srt": ""}), flush=True)
            return 0

        emit_progress(10, f"OCR {len(frames)} frames…")
        cues = ocr_frames(frames, float(args.hold))

    srt = cues_to_srt(cues)
    if args.srt_out:
        Path(args.srt_out).write_text(srt, encoding="utf-8")

    emit_progress(100, f"OCR done — {len(cues)} cues")
    payload = {
        "engine": "rapidocr",
        "segments": [{"start_ms": c["start_ms"], "end_ms": c["end_ms"], "text": c["text"]} for c in cues],
        "srt": srt,
    }
    print("RESULT " + json.dumps(payload, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    # Avoid OpenMP / BLAS thread storms on Windows.
    os.environ.setdefault("OMP_NUM_THREADS", "1")
    raise SystemExit(main())
