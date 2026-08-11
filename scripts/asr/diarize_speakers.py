#!/usr/bin/env python3
"""
Speaker diarization for ProfessorDubbedPro.

Clusters existing ASR cue time ranges into Speaker 1..N using neural speaker
embeddings (SpeechBrain ECAPA-TDNN, with MFCC fallback), estimates gender from
pitch, and writes a short *video* reference WAV per speaker (diagnostics only —
Khmer voice lock happens in the app via preset synthesis).

Usage:
  python diarize_speakers.py --wav audio.wav --segments cues.json --out result.json --refs-dir ./refs

cues.json:
  [{ "id": "cue-1", "startMs": 0, "endMs": 1200 }, ...]

result.json:
  {
    "ok": true,
    "speakers": [{
      "id": "Speaker 1",
      "gender": "male",
      "videoRefWavPath": "...",
      "refWavPath": "",
      "cueCount": 3
    }],
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


_ECAPA = None
_ECAPA_FAILED = False


def _patch_torchaudio_for_speechbrain() -> None:
	"""SpeechBrain 1.0 still calls torchaudio.list_audio_backends (removed in newer torchaudio)."""
	try:
		import torchaudio

		if not hasattr(torchaudio, "list_audio_backends"):
			torchaudio.list_audio_backends = lambda: ["soundfile"]  # type: ignore[attr-defined]
	except Exception:
		pass


def _patch_hf_hub_for_speechbrain() -> None:
	"""SpeechBrain 1.0 passes use_auth_token=; newer huggingface_hub only accepts token=."""
	try:
		import huggingface_hub
		import inspect

		sig = inspect.signature(huggingface_hub.hf_hub_download)
		if "use_auth_token" in sig.parameters:
			return
		_orig = huggingface_hub.hf_hub_download

		def _wrapped(*args, use_auth_token=None, token=None, **kwargs):
			if token is None and use_auth_token is not None and use_auth_token is not False:
				token = None if use_auth_token is True else use_auth_token
			return _orig(*args, token=token, **kwargs)

		huggingface_hub.hf_hub_download = _wrapped  # type: ignore[assignment]
	except Exception:
		pass


def _get_ecapa():
	"""Lazy-load SpeechBrain ECAPA encoder (CPU)."""
	global _ECAPA, _ECAPA_FAILED
	if _ECAPA is not None:
		return _ECAPA
	if _ECAPA_FAILED:
		return None
	try:
		_patch_torchaudio_for_speechbrain()
		_patch_hf_hub_for_speechbrain()
		from huggingface_hub import snapshot_download
		from speechbrain.inference.speaker import EncoderClassifier

		_log("Loading SpeechBrain ECAPA-TDNN speaker encoder…")
		# Prefer a local snapshot — avoids SpeechBrain fetching non-existent custom.py.
		local_dir = snapshot_download(
			repo_id="speechbrain/spkrec-ecapa-voxceleb",
			allow_patterns=[
				"hyperparams.yaml",
				"embedding_model.ckpt",
				"mean_var_norm_emb.ckpt",
				"classifier.ckpt",
				"label_encoder.txt",
			],
		)
		_ECAPA = EncoderClassifier.from_hparams(
			source=local_dir,
			savedir=local_dir,
			run_opts={"device": "cpu"},
		)
		_log("ECAPA encoder ready")
		return _ECAPA
	except Exception as e:
		_ECAPA_FAILED = True
		_log(f"ECAPA unavailable ({type(e).__name__}: {e}) — using MFCC fallback")
		return None


def _embed_mfcc(chunk, sr: int):
	"""Compact MFCC mean+std embedding (fallback)."""
	import librosa
	import numpy as np

	if chunk is None or len(chunk) < int(0.2 * sr):
		return None
	trimmed, _ = librosa.effects.trim(chunk, top_db=28)
	if len(trimmed) < int(0.15 * sr):
		trimmed = chunk
	mfcc = librosa.feature.mfcc(y=trimmed, sr=sr, n_mfcc=20)
	delta = librosa.feature.delta(mfcc)
	vec = np.concatenate([mfcc.mean(axis=1), mfcc.std(axis=1), delta.mean(axis=1)])
	n = np.linalg.norm(vec) + 1e-8
	return (vec / n).astype(np.float32)


def _embed_neural(chunk, sr: int):
	import numpy as np
	import torch

	encoder = _get_ecapa()
	if encoder is None:
		return None
	if chunk is None or len(chunk) < int(0.25 * sr):
		return None
	# Prefer a mid slice up to ~4s for embedding stability.
	max_n = int(4.0 * sr)
	audio = chunk
	if len(audio) > max_n:
		start = max(0, (len(audio) - max_n) // 2)
		audio = audio[start : start + max_n]
	wav = torch.from_numpy(np.asarray(audio, dtype=np.float32)).unsqueeze(0)
	with torch.no_grad():
		emb = encoder.encode_batch(wav)
	vec = emb.squeeze().detach().cpu().numpy().astype(np.float32)
	if vec.ndim > 1:
		vec = vec.reshape(-1)
	n = float(np.linalg.norm(vec)) + 1e-8
	return (vec / n).astype(np.float32)


def _embed(chunk, sr: int):
	neural = _embed_neural(chunk, sr)
	if neural is not None:
		return neural
	return _embed_mfcc(chunk, sr)


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


def _cluster(embeddings, k: int):
	import numpy as np
	from sklearn.cluster import AgglomerativeClustering

	X = np.stack(embeddings, axis=0)
	if k <= 1 or len(embeddings) == 1:
		return [0] * len(embeddings)
	model = AgglomerativeClustering(n_clusters=k, metric="cosine", linkage="average")
	return model.fit_predict(X).tolist()


def _choose_k_auto(embeddings) -> int:
	"""Pick k via cosine silhouette over 1..min(8, n)."""
	import numpy as np
	from sklearn.metrics import silhouette_score

	n = len(embeddings)
	if n <= 1:
		return 1
	X = np.stack(embeddings, axis=0)
	max_k = min(8, n)
	best_k = 1
	best_score = -1.0
	for k in range(2, max_k + 1):
		labels = _cluster(embeddings, k)
		# Need at least 2 distinct labels for silhouette.
		if len(set(labels)) < 2:
			continue
		try:
			score = float(silhouette_score(X, labels, metric="cosine"))
		except Exception:
			continue
		# Prefer slightly fewer speakers on near-ties (avoid over-split).
		if score > best_score + 0.02 or (abs(score - best_score) <= 0.02 and k < best_k):
			best_score = score
			best_k = k
	# If silhouette never beats a weak threshold and n is large, still allow 2+.
	if best_k == 1 and n >= 4 and best_score < 0.05:
		best_k = min(2, n)
	_log(f"Auto-K chose {best_k} (silhouette={best_score:.3f}, n={n})")
	return best_k


def _choose_k(n: int, embeddings, requested: int | None) -> int:
	if requested is not None and requested >= 1:
		return max(1, min(requested, n))
	return _choose_k_auto(embeddings)


def _write_ref(path: Path, chunk, sr: int, max_sec: float = 12.0) -> None:
	import numpy as np
	import soundfile as sf

	path.parent.mkdir(parents=True, exist_ok=True)
	max_n = int(max_sec * sr)
	audio = chunk
	if len(audio) > max_n:
		start = max(0, (len(audio) - max_n) // 2)
		audio = audio[start : start + max_n]
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

	embs = [it["emb"] for it in items]
	k = _choose_k(len(items), embs, max_speakers)
	labels = _cluster(embs, k)
	_log(f"Clustered {len(items)} cues into {k} speaker(s)")

	order: list[int] = []
	for lab in labels:
		if lab not in order:
			order.append(lab)
	lab_to_speaker = {lab: f"Speaker {i + 1}" for i, lab in enumerate(order)}

	pools: dict[str, list[dict]] = {}
	for it, lab in zip(items, labels):
		spk = lab_to_speaker[lab]
		pools.setdefault(spk, []).append(it)

	speakers_out: list[dict] = []
	assignments: list[dict] = []
	for spk, pool in pools.items():
		pool_sorted = sorted(pool, key=lambda x: x["durMs"], reverse=True)
		gender_votes: list[str] = []
		for it in pool_sorted[:3]:
			gender_votes.append(_estimate_gender(it["chunk"], sr))
		gender = "neutral"
		if gender_votes.count("female") >= gender_votes.count("male") and gender_votes.count("female") > 0:
			gender = "female"
		elif gender_votes.count("male") > 0:
			gender = "male"

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
		ref_path = refs_dir / f"video-{safe}.wav"
		_write_ref(ref_path, ref_audio, sr)
		speakers_out.append(
			{
				"id": spk,
				"gender": gender,
				"videoRefWavPath": str(ref_path.resolve()),
				"refWavPath": "",
				"cueCount": len(pool),
			}
		)
		for it in pool:
			assignments.append({"cueId": it["cueId"], "speaker": spk})

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
