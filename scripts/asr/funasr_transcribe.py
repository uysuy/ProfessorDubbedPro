#!/usr/bin/env python3
"""
FunASR / SenseVoice transcription sidecar for ProfessorDubbedPro.

Progress lines on stderr (unbuffered):
  PROGRESS <0-100> <message>
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import traceback
from pathlib import Path

# Unbuffered stdio as early as possible (Windows pipe safety).
os.environ.setdefault("PYTHONUNBUFFERED", "1")
os.environ.setdefault("PYTHONIOENCODING", "utf-8")
os.environ.setdefault("FUNASR_DISABLE_UPDATE", "1")
# Quiet FunASR registry dumps — they can flood the parent stderr pipe and deadlock.
os.environ.setdefault("FUNASR_DISABLE_LOG", "1")
os.environ["TQDM_DISABLE"] = "1"


def progress(pct: int, message: str) -> None:
    pct = max(0, min(100, int(pct)))
    sys.stderr.write(f"PROGRESS {pct} {message}\n")
    sys.stderr.flush()


# Emit before heavy imports so the UI leaves 22% immediately.
progress(1, "FunASR process started…")


def clean_text(raw: str) -> str:
    if not raw:
        return ""
    try:
        from funasr.utils.postprocess_utils import rich_transcription_postprocess

        text = rich_transcription_postprocess(raw)
    except Exception:
        text = raw
    # Drop SenseVoice tag tokens and event/emotion glyphs (🎼 😡 etc.) —
    # those are model metadata, not spoken dialogue for dubbing scripts.
    text = re.sub(r"<\|[^|>]+\|>", "", text)
    text = re.sub(
        r"["
        r"\U0001F3B5\U0001F3B6\U0001F3BC\U0001F3A4"  # music notes / mic
        r"\U0001F600-\U0001F64F"  # emoticons
        r"\U0001F910-\U0001F92F"
        r"\U0001F300-\U0001F5FF"
        r"\u266A\u266B\u266C"  # ♪♫♬
        r"]+",
        "",
        text,
    )
    text = text.replace("🎼", "").replace("🎵", "").replace("🎶", "")
    text = re.sub(r"\s+", " ", text).strip()
    text = text.strip(" \t.,，、；;：:·•")
    text = fix_common_asr_mishears(text)
    return text.strip()


def fix_common_asr_mishears(text: str) -> str:
    """High-confidence Mandarin ASR fixes (SenseVoice / short-video speech)."""
    if not text:
        return text
    fixes = (
        ("所有电费，男的也会", "总有一天废，男的也会"),
        ("所有电费,男的也会", "总有一天废,男的也会"),
        ("总有电费，男的也会", "总有一天废，男的也会"),
        ("总有电费,男的也会", "总有一天废,男的也会"),
        ("所有电费男的也会", "总有一天废男的也会"),
        ("转换身单", "转换升单"),
        ("薪髓", "薪水"),
    )
    out = text
    for a, b in fixes:
        if a in out:
            out = out.replace(a, b)
    return out


# Domain lexicon bias for Mandarin short-video / salon sales talk (FunASR hotword when supported).
DEFAULT_HOTWORDS = (
    "小三 保底 底薪 升单 美容院 店长 老顾客 新顾客 起盘 老店新开 价值转换 "
    "总有一天废 提成 业绩 客单价 打工人 内卷 躺平 渣男 备胎 绿茶 海王"
)


def pick_device(requested: str) -> str:
    req = (requested or "auto").strip().lower()
    if req in ("cpu", "cuda", "cuda:0"):
        return "cpu" if req == "cpu" else "cuda:0"
    try:
        import torch

        if torch.cuda.is_available():
            return "cuda:0"
    except Exception:
        pass
    return "cpu"


def resolve_model_id(name: str) -> str:
    key = (name or "sensevoice").strip().lower()
    if key in ("nano", "fun-asr-nano", "funasr-nano", "fun_asr_nano"):
        return "FunAudioLLM/Fun-ASR-Nano-2512"
    if key in ("paraformer", "paraformer-zh", "seaco"):
        # Strong Mandarin ASR + timestamps (downloads on first use).
        return "iic/speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch"
    return "iic/SenseVoiceSmall"


def ms_from_value(v) -> int | None:
    if v is None:
        return None
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    if 0 < abs(x) < 400 and ("." in str(v)):
        return int(round(x * 1000))
    return int(round(x))


def segment_from_dict(item: dict) -> dict | None:
    text = clean_text(
        str(item.get("text") or item.get("sentence") or item.get("raw_text") or "")
    )
    if not text:
        return None

    start = None
    end = None
    for sk, ek in (
        ("start", "end"),
        ("start_ms", "end_ms"),
        ("begin_time", "end_time"),
        ("timestamp_start", "timestamp_end"),
    ):
        if sk in item or ek in item:
            start = ms_from_value(item.get(sk))
            end = ms_from_value(item.get(ek))
            break

    ts = item.get("timestamp")
    if (start is None or end is None) and isinstance(ts, (list, tuple)) and ts:
        first = ts[0]
        last = ts[-1]
        if isinstance(first, (list, tuple)) and len(first) >= 2:
            start = ms_from_value(first[0]) if start is None else start
            end = ms_from_value(
                last[1] if isinstance(last, (list, tuple)) and len(last) >= 2 else first[1]
            )

    if start is None:
        start = 0
    if end is None or end <= start:
        end = start + max(400, min(8000, len(text) * 180))

    return {"start_ms": int(start), "end_ms": int(end), "text": text}


def extract_segments(result) -> list[dict]:
    if result is None:
        return []
    items = result if isinstance(result, list) else [result]
    out: list[dict] = []
    for block in items:
        if not isinstance(block, dict):
            continue
        sentence_info = block.get("sentence_info")
        if isinstance(sentence_info, list) and sentence_info:
            for s in sentence_info:
                if isinstance(s, dict):
                    seg = segment_from_dict(s)
                    if seg:
                        out.append(seg)
            if out:
                return out
        segs = block.get("segments") or block.get("sentence") or block.get("sentences")
        if isinstance(segs, list) and segs:
            for s in segs:
                if isinstance(s, dict):
                    seg = segment_from_dict(s)
                    if seg:
                        out.append(seg)
            if out:
                return out
        text = clean_text(str(block.get("text") or ""))
        if text:
            out.append(
                {
                    "start_ms": ms_from_value(block.get("start")) or 0,
                    "end_ms": ms_from_value(block.get("end")) or max(1000, len(text) * 180),
                    "text": text,
                }
            )
    return out


_SENTENCE_SPLIT = re.compile(r"(?<=[。！？；…!?])\s*")


def split_long_segments(segments: list[dict], max_chars: int = 42) -> list[dict]:
    final: list[dict] = []
    for seg in segments:
        text = seg["text"].strip()
        start = int(seg["start_ms"])
        end = int(seg["end_ms"])
        if len(text) <= max_chars or end <= start:
            final.append({"start_ms": start, "end_ms": max(end, start + 200), "text": text})
            continue
        parts = [p.strip() for p in _SENTENCE_SPLIT.split(text) if p and p.strip()]
        if len(parts) <= 1:
            parts = []
            buf = ""
            for ch in text:
                buf += ch
                if len(buf) >= max_chars and ch in "，、, ":
                    parts.append(buf.strip())
                    buf = ""
            if buf.strip():
                parts.append(buf.strip())
        if len(parts) <= 1:
            final.append({"start_ms": start, "end_ms": max(end, start + 200), "text": text})
            continue
        weights = [max(1, len(p)) for p in parts]
        total = sum(weights)
        span = max(200 * len(parts), end - start)
        cursor = start
        for i, part in enumerate(parts):
            if i + 1 == len(parts):
                part_end = max(end, cursor + 200)
            else:
                slice_ms = int(round(span * (weights[i] / total)))
                part_end = cursor + max(180, slice_ms)
            final.append({"start_ms": cursor, "end_ms": part_end, "text": part})
            cursor = part_end
    return final


def merge_tiny_gaps(segments: list[dict], gap_ms: int = 80) -> list[dict]:
    if not segments:
        return []
    ordered = sorted(segments, key=lambda s: (s["start_ms"], s["end_ms"]))
    out = [ordered[0].copy()]
    for seg in ordered[1:]:
        prev = out[-1]
        if seg["start_ms"] <= prev["end_ms"] + gap_ms and seg["text"] == prev["text"]:
            prev["end_ms"] = max(prev["end_ms"], seg["end_ms"])
            continue
        if seg["start_ms"] < prev["end_ms"]:
            seg = {**seg, "start_ms": prev["end_ms"]}
            if seg["end_ms"] <= seg["start_ms"]:
                seg["end_ms"] = seg["start_ms"] + 200
        out.append(seg)
    return out


def transcribe(wav: Path, language: str, model_name: str, device: str) -> dict:
    progress(4, "Importing PyTorch / FunASR (may take a minute)…")
    from funasr import AutoModel

    model_id = resolve_model_id(model_name)
    device = pick_device(device)
    lang = (language or "zh").strip().lower()
    if lang in ("chinese", "zh-cn", "zh-hans", "cmn"):
        lang = "zh"
    if lang in ("auto", ""):
        lang = "zh"

    is_sensevoice = "SenseVoice" in model_id or model_id.startswith("iic/SenseVoice")
    is_paraformer = "paraformer" in model_id.lower()

    progress(10, f"Loading model {model_id} on {device}…")
    # Keep logs/pbars off: FunASR registry tables are huge and can deadlock Windows pipes.
    kwargs = {
        "model": model_id,
        "vad_model": "fsmn-vad",
        # ~25s max speech chunk — balances Mandarin phrase cuts vs word errors.
        "vad_kwargs": {"max_single_segment_time": 25000},
        "device": device,
        "disable_update": True,
        "disable_pbar": True,
        "disable_log": True,
    }
    if is_paraformer:
        kwargs["punc_model"] = "ct-punc"

    try:
        model = AutoModel(**kwargs)
    except Exception as first_err:
        if is_sensevoice:
            progress(12, "Retrying with HuggingFace SenseVoiceSmall…")
            kwargs["model"] = "FunAudioLLM/SenseVoiceSmall"
            try:
                model = AutoModel(**kwargs)
                model_id = kwargs["model"]
                is_sensevoice = True
            except Exception:
                raise first_err from None
        else:
            raise

    progress(30, "Running VAD + Chinese ASR on spoken audio…")
    gen_kwargs = {
        "input": str(wav),
        "cache": {},
        "use_itn": True,
        "batch_size_s": 60,
        "merge_vad": True,
        "merge_length_s": 12,
        "sentence_timestamp": True,
    }
    if is_sensevoice:
        gen_kwargs["language"] = lang
        gen_kwargs["ban_emo_unk"] = True
    if is_paraformer:
        gen_kwargs["hotword"] = DEFAULT_HOTWORDS
    gen_kwargs = {k: v for k, v in gen_kwargs.items() if v is not None}

    try:
        result = model.generate(**gen_kwargs)
    except TypeError:
        gen_kwargs.pop("hotword", None)
        gen_kwargs.pop("ban_emo_unk", None)
        result = model.generate(**gen_kwargs)

    progress(80, "Parsing timed segments…")
    segments = extract_segments(result)
    segments = merge_tiny_gaps(segments)
    segments = split_long_segments(segments)
    segments = [
        s
        for s in segments
        if s["text"]
        and not re.fullmatch(r"[<|/>\s\W]+", s["text"], flags=re.UNICODE)
        and len(re.sub(r"\W+", "", s["text"], flags=re.UNICODE)) >= 1
    ]

    progress(95, f"Prepared {len(segments)} segment(s)")
    return {
        "engine": "funasr",
        "model": model_id,
        "language": lang,
        "device": device,
        "segments": segments,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="FunASR transcription sidecar")
    parser.add_argument("--wav", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--language", default="zh")
    parser.add_argument("--model", default="sensevoice")
    parser.add_argument("--device", default="cpu", help="cpu recommended for reliability")
    args = parser.parse_args()

    wav = Path(args.wav)
    out = Path(args.out)
    if not wav.is_file():
        sys.stderr.write(f"ERROR WAV not found: {wav}\n")
        sys.stderr.flush()
        return 2

    try:
        payload = transcribe(wav, args.language, args.model, args.device)
        if not payload["segments"]:
            sys.stderr.write("ERROR FunASR returned no speech segments.\n")
            sys.stderr.flush()
            return 3
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        progress(100, "Done")
        # Keep stdout tiny — parent may discard it (avoid Windows pipe deadlock).
        sys.stdout.write(f'{{"ok":true,"segments":{len(payload["segments"])}}}\n')
        sys.stdout.flush()
        return 0
    except Exception as exc:
        sys.stderr.write(f"ERROR {exc}\n")
        traceback.print_exc(file=sys.stderr)
        sys.stderr.flush()
        return 1


if __name__ == "__main__":
    sys.exit(main())
