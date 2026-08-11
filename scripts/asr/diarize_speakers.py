#!/usr/bin/env python3
"""
Speaker diarization for ProfessorDubbedPro.

Clusters existing ASR cue time ranges into Speaker 1..N using MFCC embeddings,
estimates gender from pitch, and writes a short reference WAV per speaker.

Usage:
  python diarize_speakers.py --wav audio.wav --segments cues.json --out result.json --refs-dir ./refs

cues.json:
  [{ "id": "cue-1", "startMs": 0, "endMs": 1200 }, ...]

result.json:
  {
    "ok": true,
    "speakers": [{ "id": "Speaker 1", "gender": "male", "refWavPath": "...", "cueCount": 3 }],
    "assignments": [{ "cueId": "cue-1", "speaker": "Speaker 1" }]
  }
"""

from __future__ import annotations

import argparse
import json
import sys
import traceback
from pathlib import Path
from typing import Any


def _log(msg: str) -> None:
	print(f"[diarize] {msg}", flush=True)


def _load_wav(path: Path):
	import librosa
	import numpy as np

	y, sr = librosa.load(str(path), sr=16000, mono=True)
	if y is None or len(y) < 1600:
		raise ValueError(f"Audio too short or empty: {path}")
	return np.asarray(y, dtype=np.float32), int(sr)


def _slice(y, sr: int, start_ms: int, end_ms: int):
	import numpy as np

	s = max(0, int(round(start_ms * sr / 1000.0)))
	e = min(len(y), int(round(end_ms * sr / 1000.0)))
	if e <= s + int(0.15 * sr):
		return None
	return y[s:e]


def _embed(chunk, sr: int):
	"""Compact MFCC mean+std embedding for clustering."""
	import librosa
	import numpy as np

	if chunk is None or len(chunk) < int(0.2 * sr):
		return None
	# Trim silence edges for cleaner speaker traits.
	trimmed, _ = librosa.effects.trim(chunk, top_db=28)
	if len(trimmed) < int(0.15 * sr):
		trimmed = chunk
	mfcc = librosa.feature.mfcc(y=trimmed, sr=sr, n_mfcc=20)
	delta = librosa.feature.delta(mfcc)
	vec = np.concatenate([mfcc.mean(axis=1), mfcc.std(axis=1), delta.mean(axis=1)])
	n = np.linalg.norm(vec) + 1e-8
	return (vec / n).astype(np.float32)


def _estimate_gender(chunk, sr: int) -> str:
	import librosa
	import numpy as np

	if chunk is None or len(chunk) < int(0.25 * sr):
		return "neutral"
	try:
		f0, voiced_flag, _ = librosa.pyin(
			chunk,
			fmin=librosa.note_to_hz("C2"),
			fmax=librosa.note_to_hz("C5"),
			sr=sr,
		)
		vals = f0[voiced_flag] if voiced_flag is not None else f0
		vals = vals[~np.isnan(vals)] if vals is not None else np.array([])
		if len(vals) < 8:
			# Spectral centroid fallback
			cent = float(np.mean(librosa.feature.spectral_centroid(y=chunk, sr=sr)))
			return "female" if cent > 1800 else "male" if cent < 1400 else "neutral"
		med = float(np.median(vals))
		if med >= 180:
			return "female"
		if med <= 145:
			return "male"
		return "neutral"
	except Exception:
		return "neutral"


def _choose_k(n: int, requested: int | None) -> int:
	if requested is not None and requested >= 1:
		return max(1, min(requested, n))
	# Heuristic: prefer 2 speakers when enough cues, else 1.
	if n <= 1:
		return 1
	if n <= 3:
		return min(2, n)
	return min(4, max(2, n // 4))


def _cluster(embeddings, k: int):
	import numpy as np
	from sklearn.cluster import AgglomerativeClustering

	X = np.stack(embeddings, axis=0)
	if k <= 1 or len(embeddings) == 1:
		return [0] * len(embeddings)
	model = AgglomerativeClustering(n_clusters=k, metric="cosine", linkage="average")
	return model.fit_predict(X).tolist()


def _write_ref(path: Path, chunk, sr: int, max_sec: float = 12.0) -> None:
	import numpy as np
	import soundfile as sf

	path.parent.mkdir(parents=True, exist_ok=True)
	max_n = int(max_sec * sr)
	audio = chunk
	if len(audio) > max_n:
		# Prefer middle slice (often cleaner than cold open).
		start = max(0, (len(audio) - max_n) // 2)
		audio = audio[start : start + max_n]
	# Fade edges
	fade = min(int(0.03 * sr), len(audio) // 4)
	if fade > 0:
		audio = audio.copy()
		audio[:fade] *= np.linspace(0, 1, fade, dtype=np.float32)
		audio[-fade:] *= np.linspace(1, 0, fade, dtype=np.float32)
	sf.write(str(path), audio, sr, subtype="PCM_16")


def run(wav_path: Path, segments: list[dict], out_path: Path, refs_dir: Path, max_speakers: int | None) -> dict:
	import numpy as np

	y, sr = _load_wav(wav_path)
	items: list[dict[str, Any]] = []
	for seg in segments:
		cue_id = str(seg.get("id") or "").strip()
		if not cue_id:
			continue
		start_ms = int(seg.get("startMs") or 0)
		end_ms = int(seg.get("endMs") or 0)
		if end_ms <= start_ms:
			continue
		chunk = _slice(y, sr, start_ms, end_ms)
		emb = _embed(chunk, sr)
		if emb is None or chunk is None:
			continue
		items.append(
			{
				"cueId": cue_id,
				"startMs": start_ms,
				"endMs": end_ms,
				"durMs": end_ms - start_ms,
				"chunk": chunk,
				"emb": emb,
			}
		)

	if not items:
		raise ValueError("No usable cue audio slices for diarization (need timed cues + speech).")

	k = _choose_k(len(items), max_speakers)
	labels = _cluster([it["emb"] for it in items], k)
	_log(f"Clustered {len(items)} cues into {k} speaker(s)")

	# Remap cluster ids by first appearance → Speaker 1..N
	order: list[int] = []
	for lab in labels:
		if lab not in order:
			order.append(lab)
	lab_to_speaker = {lab: f"Speaker {i + 1}" for i, lab in enumerate(order)}

	# Build per-speaker pools
	pools: dict[str, list[dict]] = {}
	for it, lab in zip(items, labels):
		spk = lab_to_speaker[lab]
		pools.setdefault(spk, []).append(it)

	speakers_out: list[dict] = []
	assignments: list[dict] = []
	for spk, pool in pools.items():
		# Gender from longest chunks
		pool_sorted = sorted(pool, key=lambda x: x["durMs"], reverse=True)
		gender_votes: list[str] = []
		for it in pool_sorted[:3]:
			gender_votes.append(_estimate_gender(it["chunk"], sr))
		gender = "neutral"
		if gender_votes.count("female") >= gender_votes.count("male") and gender_votes.count("female") > 0:
			gender = "female"
		elif gender_votes.count("male") > 0:
			gender = "male"

		# Reference = concat top chunks up to ~12s
		parts = []
		total = 0
		target = int(12 * sr)
		for it in pool_sorted:
			parts.append(it["chunk"])
			total += len(it["chunk"])
			if total >= target:
				break
		ref_audio = np.concatenate(parts) if parts else pool_sorted[0]["chunk"]
		safe = spk.lower().replace(" ", "-")
		ref_path = refs_dir / f"{safe}.wav"
		_write_ref(ref_path, ref_audio, sr)
		speakers_out.append(
			{
				"id": spk,
				"gender": gender,
				"refWavPath": str(ref_path.resolve()),
				"cueCount": len(pool),
			}
		)
		for it in pool:
			assignments.append({"cueId": it["cueId"], "speaker": spk})

	# Cues that failed embedding keep Speaker 1 if any, else first speaker
	fallback = speakers_out[0]["id"] if speakers_out else "Speaker 1"
	assigned_ids = {a["cueId"] for a in assignments}
	for seg in segments:
		cid = str(seg.get("id") or "").strip()
		if cid and cid not in assigned_ids:
			assignments.append({"cueId": cid, "speaker": fallback})

	speakers_out.sort(key=lambda s: s["id"])
	return {
		"ok": True,
		"speakerCount": len(speakers_out),
		"speakers": speakers_out,
		"assignments": assignments,
	}


def main() -> int:
	ap = argparse.ArgumentParser()
	ap.add_argument("--wav", required=True)
	ap.add_argument("--segments", required=True, help="JSON list of {id,startMs,endMs}")
	ap.add_argument("--out", required=True)
	ap.add_argument("--refs-dir", required=True)
	ap.add_argument("--max-speakers", type=int, default=0, help="0 = auto")
	args = ap.parse_args()

	try:
		segs = json.loads(Path(args.segments).read_text(encoding="utf-8"))
		if not isinstance(segs, list):
			raise ValueError("segments JSON must be a list")
		max_spk = args.max_speakers if args.max_speakers and args.max_speakers > 0 else None
		result = run(
			Path(args.wav),
			segs,
			Path(args.out),
			Path(args.refs_dir),
			max_spk,
		)
		Path(args.out).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
		_log(f"Wrote {args.out} · {result['speakerCount']} speakers")
		sys.stdout.write(json.dumps({"ok": True, "speakerCount": result["speakerCount"]}) + "\n")
		return 0
	except Exception as e:
		traceback.print_exc()
		err = {"ok": False, "error": f"{type(e).__name__}: {e}"}
		try:
			Path(args.out).write_text(json.dumps(err, ensure_ascii=False, indent=2), encoding="utf-8")
		except Exception:
			pass
		sys.stdout.write(json.dumps(err) + "\n")
		return 1


if __name__ == "__main__":
	sys.exit(main())
