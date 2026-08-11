#!/usr/bin/env python3
"""
Local VoxCPM2 HTTP sidecar for ProfessorDubbedPro.

Endpoints:
  GET  /health              → { ok, loaded, loading, model, sampleRate, cached }
  POST /load                → start load in background (poll /health for loaded)
  POST /unload              → free VRAM
  POST /synthesize          → { text, voicePrompt?, cfg?, timesteps?, outPath }

Env:
  PDP_VOXCPM_PORT     default 18765
  PDP_VOXCPM_MODEL    default openbmb/VoxCPM2
  PDP_VOXCPM_DEVICE   cuda | cpu | auto (default auto)
  PDP_VOXCPM_DENOISER 1|0 — ZipEnhancer denoiser (default 0; avoids ModelScope download)
"""

from __future__ import annotations

import json
import os
import sys
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Optional

PORT = int(os.environ.get("PDP_VOXCPM_PORT", "18765"))
MODEL_ID = os.environ.get("PDP_VOXCPM_MODEL", "openbmb/VoxCPM2").strip() or "openbmb/VoxCPM2"
DEVICE_PREF = os.environ.get("PDP_VOXCPM_DEVICE", "auto").strip().lower()
LOAD_DENOISER = os.environ.get("PDP_VOXCPM_DENOISER", "0").strip().lower() in (
	"1",
	"true",
	"yes",
	"on",
)

_lock = threading.Lock()
_model = None
_sample_rate = 48000
_load_error: Optional[str] = None
_cache_path: Optional[str] = None
_loading = False
_device_name = "unknown"
_weights_cached = False
_load_stage = "idle"
_load_progress = 0


def _set_load_progress(stage: str, progress: int) -> None:
	global _load_stage, _load_progress
	_load_stage = stage
	_load_progress = max(0, min(100, int(progress)))
	_log(f"Load stage: {stage} ({_load_progress}%)")


def _log(msg: str) -> None:
	print(f"[voxcpm] {msg}", flush=True)


def _pick_device() -> str:
	if DEVICE_PREF in ("cuda", "cpu"):
		return DEVICE_PREF
	try:
		import torch

		return "cuda" if torch.cuda.is_available() else "cpu"
	except Exception:
		return "cpu"


def _local_snapshot_path(model_id: str) -> Optional[str]:
	"""Return HF snapshot dir if weights are fully cached locally (no Hub call that downloads)."""
	if os.path.isdir(model_id):
		weights = Path(model_id) / "model.safetensors"
		if weights.exists():
			return model_id
		return None
	try:
		from huggingface_hub import snapshot_download

		path = snapshot_download(repo_id=model_id, local_files_only=True)
		weights = Path(path) / "model.safetensors"
		if not weights.exists():
			return None
		try:
			real = weights.resolve(strict=True)
			if real.stat().st_size < 100_000_000:
				_log(f"Local weights look incomplete ({real.stat().st_size} bytes)")
				return None
		except OSError as e:
			_log(f"Cannot resolve local weights: {e}")
			return None
		return path
	except Exception as e:
		_log(f"Local cache not ready: {type(e).__name__}: {e}")
		return None


def ensure_loaded() -> Any:
	global _model, _sample_rate, _load_error, _cache_path, _weights_cached
	with _lock:
		if _model is not None:
			_set_load_progress("ready", 100)
			return _model
		_load_error = None
		device = _device_name if _device_name != "unknown" else _pick_device()
		token_set = bool(
			os.environ.get("HF_TOKEN")
			or os.environ.get("HUGGING_FACE_HUB_TOKEN")
			or os.environ.get("HF_HUB_TOKEN")
		)
		_log(f"Loading {MODEL_ID} on {device}…")
		_log(f"HF token present: {token_set}")
		try:
			_set_load_progress("resolving_cache", 8)
			from voxcpm import VoxCPM

			_set_load_progress("importing", 18)
			local = _cache_path or _local_snapshot_path(MODEL_ID)
			if local:
				_cache_path = local
				_weights_cached = True
				_log(f"Using local cache only (no re-download): {local}")
				_set_load_progress("loading_weights", 35)
				_model = VoxCPM.from_pretrained(
					local,
					local_files_only=True,
					load_denoiser=LOAD_DENOISER,
					device=device if device != "auto" else None,
				)
			else:
				_log("Cache incomplete — downloading from Hugging Face (~5GB, one-time)…")
				_set_load_progress("downloading", 25)
				_model = VoxCPM.from_pretrained(
					MODEL_ID,
					local_files_only=False,
					load_denoiser=LOAD_DENOISER,
					device=device if device != "auto" else None,
				)
				_cache_path = _local_snapshot_path(MODEL_ID) or MODEL_ID
				_weights_cached = _cache_path is not None
			_set_load_progress("to_gpu", 85)
			sr = getattr(getattr(_model, "tts_model", None), "sample_rate", None)
			if isinstance(sr, int) and sr > 0:
				_sample_rate = sr
			_set_load_progress("ready", 100)
			_log(f"Model ready · sample_rate={_sample_rate}")
			return _model
		except Exception as e:
			_load_error = f"{type(e).__name__}: {e}"
			_set_load_progress("error", _load_progress)
			_log(f"Load failed: {_load_error}")
			traceback.print_exc()
			raise


def _soft_progress_ticker() -> None:
	"""Nudge the progress bar while torch load blocks (no real byte %)."""
	import time

	while _loading and _model is None and _load_error is None:
		time.sleep(2.0)
		if _load_stage in ("loading_weights", "downloading", "importing", "to_gpu"):
			# Cap before "ready" so completion still feels distinct.
			if _load_progress < 82:
				_set_load_progress(_load_stage, _load_progress + 3)


def _load_in_background() -> None:
	global _loading
	try:
		_set_load_progress("starting", 2)
		threading.Thread(target=_soft_progress_ticker, name="voxcpm-progress", daemon=True).start()
		ensure_loaded()
	except Exception:
		pass
	finally:
		_loading = False


def start_load_async() -> dict:
	"""Kick off load without blocking the HTTP thread (keeps /health alive)."""
	global _loading, _load_error
	if _model is not None:
		_set_load_progress("ready", 100)
		return {
			"ok": True,
			"loaded": True,
			"loading": False,
			"model": MODEL_ID,
			"sampleRate": _sample_rate,
			"loadStage": _load_stage,
			"loadProgress": 100,
		}
	if _loading:
		return {
			"ok": True,
			"loaded": False,
			"loading": True,
			"model": MODEL_ID,
			"sampleRate": _sample_rate,
			"loadStage": _load_stage,
			"loadProgress": _load_progress,
		}
	_load_error = None
	_loading = True
	_set_load_progress("queued", 1)
	threading.Thread(target=_load_in_background, name="voxcpm-load", daemon=True).start()
	return {
		"ok": True,
		"loaded": False,
		"loading": True,
		"started": True,
		"model": MODEL_ID,
		"sampleRate": _sample_rate,
		"loadStage": _load_stage,
		"loadProgress": _load_progress,
	}


def unload_model() -> None:
	global _model, _loading
	with _lock:
		_model = None
		_loading = False
		_set_load_progress("idle", 0)
		try:
			import torch
			import gc

			gc.collect()
			if torch.cuda.is_available():
				torch.cuda.empty_cache()
		except Exception:
			pass
		_log("Model unloaded")


def synthesize(
	text: str,
	voice_prompt: str,
	out_path: Path,
	cfg: float,
	timesteps: int,
	reference_wav: str = "",
) -> dict:
	import numpy as np
	import soundfile as sf

	model = ensure_loaded()
	prompt = (voice_prompt or "").strip().strip("()")
	speak = (text or "").strip()
	ref = (reference_wav or "").strip()
	ref_ok = bool(ref) and Path(ref).is_file()

	# Clone mode: reference drives timbre; keep Khmer text clean so script/question
	# intonation follows the translation (no heavy English voice-design prefix).
	if ref_ok:
		full_text = speak
		_log(f"Synthesize · clone ref={Path(ref).name} · chars={len(speak)}")
	else:
		full_text = f"({prompt}){speak}" if prompt else speak
		_log(f"Synthesize · design prompt={prompt[:80]!r} · chars={len(speak)}")

	timesteps = max(6, min(20, int(timesteps)))
	cfg = float(cfg) if cfg else (2.0 if ref_ok else 2.5)
	cfg = max(1.5, min(3.0, cfg))

	gen_kwargs = {
		"text": full_text,
		"cfg_value": cfg,
		"inference_timesteps": timesteps,
		"normalize": False,
	}
	if ref_ok:
		gen_kwargs["reference_wav_path"] = ref

	with _lock:
		wav = model.generate(**gen_kwargs)

	arr = np.asarray(wav, dtype=np.float32)
	if arr.ndim > 1:
		arr = arr.reshape(-1)
	out_path.parent.mkdir(parents=True, exist_ok=True)
	sf.write(str(out_path), arr, _sample_rate)
	duration_ms = int(round(1000.0 * (len(arr) / float(_sample_rate))))
	byte_length = out_path.stat().st_size
	return {
		"ok": True,
		"filePath": str(out_path.resolve()),
		"byteLength": byte_length,
		"durationMs": duration_ms,
		"sampleRate": _sample_rate,
		"model": MODEL_ID,
		"cloned": ref_ok,
	}


class Handler(BaseHTTPRequestHandler):
	protocol_version = "HTTP/1.1"
	# Avoid hanging forever if a client disconnects mid-load poll storm.
	timeout = 30

	def log_message(self, fmt: str, *args: Any) -> None:
		# Health is polled while Load Model waits — don't spam the app console.
		try:
			msg = fmt % args
		except Exception:
			msg = fmt
		if "GET /health" in msg:
			return
		_log(msg)

	def _send(self, code: int, payload: dict) -> None:
		body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
		self.send_response(code)
		self.send_header("Content-Type", "application/json; charset=utf-8")
		self.send_header("Content-Length", str(len(body)))
		self.send_header("Connection", "close")
		self.end_headers()
		self.wfile.write(body)

	def _read_json(self) -> dict:
		length = int(self.headers.get("Content-Length", "0") or 0)
		raw = self.rfile.read(length) if length > 0 else b"{}"
		if not raw:
			return {}
		return json.loads(raw.decode("utf-8"))

	def do_GET(self) -> None:  # noqa: N802
		if self.path.split("?")[0] != "/health":
			self._send(404, {"ok": False, "error": "not found"})
			return
		# Keep this path cheap — never call Hugging Face / torch here.
		self._send(
			200,
			{
				"ok": True,
				"loaded": _model is not None,
				"loading": _loading,
				"model": MODEL_ID,
				"sampleRate": _sample_rate,
				"loadError": _load_error,
				"device": _device_name,
				"cached": _weights_cached or _cache_path is not None,
				"loadStage": _load_stage,
				"loadProgress": _load_progress if (_loading or _model is not None) else 0,
			},
		)

	def do_POST(self) -> None:  # noqa: N802
		path = self.path.split("?")[0]
		try:
			if path == "/load":
				self._send(200, start_load_async())
				return
			if path == "/unload":
				unload_model()
				self._send(200, {"ok": True, "loaded": False, "loading": False})
				return
			if path == "/synthesize":
				data = self._read_json()
				text = str(data.get("text") or "").strip()
				if not text:
					self._send(400, {"ok": False, "error": "text is empty"})
					return
				out = str(data.get("outPath") or "").strip()
				if not out:
					self._send(400, {"ok": False, "error": "outPath is required"})
					return
				voice_prompt = str(data.get("voicePrompt") or "")
				reference_wav = str(data.get("referenceWavPath") or "")
				cfg = float(data.get("cfg") or 2.0)
				timesteps = int(data.get("timesteps") or 10)
				result = synthesize(text, voice_prompt, Path(out), cfg, timesteps, reference_wav)
				self._send(200, result)
				return
			self._send(404, {"ok": False, "error": "not found"})
		except Exception as e:
			msg = f"{type(e).__name__}: {e}"
			_log(msg)
			traceback.print_exc()
			lower = msg.lower()
			if "out of memory" in lower or ("cuda" in lower and "memory" in lower):
				msg = (
					"VoxCPM ran out of GPU memory (RTX 1070 8GB is tight for VoxCPM2). "
					"Unload other GPU apps, or switch TTS engine to Edge TTS.\n" + msg
				)
			self._send(500, {"ok": False, "error": msg})


def main() -> int:
	global _device_name, _weights_cached, _cache_path
	_device_name = _pick_device()
	_cache_path = _local_snapshot_path(MODEL_ID)
	_weights_cached = _cache_path is not None
	_log(f"Listening on http://127.0.0.1:{PORT} · model={MODEL_ID} · device={_device_name}")
	_log(f"Weights cached locally: {_weights_cached}")
	server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
	try:
		server.serve_forever()
	except KeyboardInterrupt:
		_log("Shutting down")
	return 0


if __name__ == "__main__":
	sys.exit(main())
