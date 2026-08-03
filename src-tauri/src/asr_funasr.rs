//! FunASR (SenseVoice) Python sidecar for Chinese speech-to-text.
//! Preferred engine for `zh` — Whisper remains the fallback.

use serde::Deserialize;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

use crate::transcribe::{emit_progress, TranscriptSegment};

#[derive(Debug, Deserialize)]
struct FunAsrFileResult {
	#[serde(default)]
	#[allow(dead_code)]
	engine: String,
	#[serde(default)]
	model: String,
	#[serde(default)]
	language: String,
	#[serde(default)]
	segments: Vec<FunAsrSeg>,
}

#[derive(Debug, Deserialize)]
struct FunAsrSeg {
	start_ms: u64,
	end_ms: u64,
	text: String,
}

fn project_root() -> PathBuf {
	PathBuf::from(env!("CARGO_MANIFEST_DIR"))
		.parent()
		.map(|p| p.to_path_buf())
		.unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")))
}

/// Locate the FunASR transcription script.
pub fn find_funasr_script(app: &AppHandle) -> Result<PathBuf, String> {
	let mut candidates: Vec<PathBuf> = Vec::new();
	candidates.push(project_root().join("scripts").join("asr").join("funasr_transcribe.py"));
	if let Ok(resource) = app.path().resource_dir() {
		candidates.push(resource.join("scripts").join("asr").join("funasr_transcribe.py"));
		candidates.push(resource.join("funasr_transcribe.py"));
	}
	if let Ok(exe) = std::env::current_exe() {
		if let Some(dir) = exe.parent() {
			candidates.push(dir.join("scripts").join("asr").join("funasr_transcribe.py"));
		}
	}
	for p in &candidates {
		if p.is_file() {
			return Ok(p.clone());
		}
	}
	Err(
		"FunASR script not found (scripts/asr/funasr_transcribe.py).\nRun: pnpm funasr:setup"
			.into(),
	)
}

/// Prefer project `.venv-funasr`, then PDP_FUNASR_PYTHON, then system Python.
pub fn find_funasr_python() -> Result<PathBuf, String> {
	if let Ok(custom) = std::env::var("PDP_FUNASR_PYTHON") {
		let p = PathBuf::from(custom.trim());
		if p.is_file() {
			return Ok(p);
		}
	}

	let root = project_root();
	#[cfg(windows)]
	let venv_py = root.join(".venv-funasr").join("Scripts").join("python.exe");
	#[cfg(not(windows))]
	let venv_py = root.join(".venv-funasr").join("bin").join("python");
	if venv_py.is_file() {
		return Ok(venv_py);
	}

	#[cfg(windows)]
	{
		if let Ok(path) = which::which("py") {
			return Ok(path);
		}
	}
	if let Ok(path) = which::which("python") {
		return Ok(path);
	}
	if let Ok(path) = which::which("python3") {
		return Ok(path);
	}

	Err(
		"FunASR Python not found.\nRun: pnpm funasr:setup\nOr set PDP_FUNASR_PYTHON to a Python with funasr installed."
			.into(),
	)
}

pub fn funasr_available(app: &AppHandle) -> bool {
	find_funasr_script(app).is_ok() && find_funasr_python().is_ok()
}

fn parse_progress_line(line: &str) -> Option<(u32, String)> {
	let line = line.trim();
	let rest = line.strip_prefix("PROGRESS ")?;
	let mut parts = rest.splitn(2, char::is_whitespace);
	let pct: u32 = parts.next()?.parse().ok()?;
	let msg = parts.next().unwrap_or("").trim().to_string();
	Some((pct, msg))
}

/// Parse tqdm / modelscope bars like `model.pt:  45%|…| 193M/428M`.
fn parse_download_bar(line: &str) -> Option<(u64, u64, String)> {
	let line = line.trim();
	if !line.contains('%') {
		return None;
	}
	let label = line
		.split(':')
		.next()
		.unwrap_or("model")
		.trim()
		.trim_start_matches(|c: char| c == '\u{1b}' || c.is_control())
		.chars()
		.take(24)
		.collect::<String>();
	// Prefer `193M/428M` style.
	if let Some((a, b)) = line.split_once('/') {
		let left = a
			.split_whitespace()
			.last()
			.unwrap_or("")
			.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '.');
		let right = b
			.split_whitespace()
			.next()
			.unwrap_or("")
			.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '.');
		if let (Some(done), Some(total)) = (parse_size_token(left), parse_size_token(right)) {
			if total > 0 {
				return Some((done, total, label));
			}
		}
	}
	None
}

fn parse_size_token(raw: &str) -> Option<u64> {
	let s = raw.trim().to_ascii_uppercase();
	if s.is_empty() {
		return None;
	}
	let mult = if s.ends_with('G') {
		1024u64 * 1024 * 1024
	} else if s.ends_with('M') {
		1024 * 1024
	} else if s.ends_with('K') {
		1024
	} else if s.chars().all(|c| c.is_ascii_digit()) {
		1
	} else {
		return None;
	};
	let num: f64 = s
		.trim_end_matches(|c: char| matches!(c, 'G' | 'M' | 'K' | 'B'))
		.parse()
		.ok()?;
	Some((num * mult as f64) as u64)
}

/// Run FunASR SenseVoice (or Nano) on a prepared WAV. Returns segments + model label.
pub fn run_funasr(
	app: &AppHandle,
	wav: &Path,
	out_json: &Path,
	language: &str,
	model: &str,
	cancel: &Arc<AtomicBool>,
) -> Result<(Vec<TranscriptSegment>, String, String), String> {
	let python = find_funasr_python()?;
	let script = find_funasr_script(app)?;

	if out_json.exists() {
		let _ = fs::remove_file(out_json);
	}

	emit_progress(app, "funasr", "Starting FunASR (SenseVoice)…", 25);

	let model = if model.trim().is_empty() {
		"sensevoice"
	} else {
		model.trim()
	};
	let lang = if language.trim().is_empty() {
		"zh"
	} else {
		language.trim()
	};

	// Write FunASR stderr to a file (not a pipe). FunASR can dump multi-MB registry
	// tables; a filled Windows pipe deadlocks the child forever at ~22%.
	let err_log = out_json.with_extension("funasr.stderr.log");
	if err_log.exists() {
		let _ = fs::remove_file(&err_log);
	}
	let err_file = fs::File::create(&err_log)
		.map_err(|e| format!("Cannot create FunASR log file: {e}"))?;

	let mut cmd = Command::new(&python);
	#[cfg(windows)]
	{
		if python
			.file_name()
			.and_then(|s| s.to_str())
			.map(|s| s.eq_ignore_ascii_case("py.exe") || s.eq_ignore_ascii_case("py"))
			.unwrap_or(false)
		{
			cmd.arg("-3");
		}
		use std::os::windows::process::CommandExt;
		const CREATE_NO_WINDOW: u32 = 0x0800_0000;
		cmd.creation_flags(CREATE_NO_WINDOW);
	}

	cmd.env("PYTHONUNBUFFERED", "1");
	cmd.env("PYTHONIOENCODING", "utf-8");
	cmd.env("FUNASR_DISABLE_UPDATE", "1");
	cmd.env("TQDM_DISABLE", "1");

	cmd.args([
		"-u",
		script.to_string_lossy().as_ref(),
		"--wav",
		&wav.to_string_lossy(),
		"--out",
		&out_json.to_string_lossy(),
		"--language",
		lang,
		"--model",
		model,
		// Prefer CUDA when available; Python falls back to CPU.
		"--device",
		"auto",
	])
	.stdout(Stdio::null())
	.stderr(Stdio::from(err_file));

	let mut child = cmd
		.spawn()
		.map_err(|e| format!("Failed to start FunASR Python: {e}\nRun: pnpm funasr:setup"))?;

	let app_progress = app.clone();
	let reader_cancel = Arc::clone(cancel);
	let reader_stop = Arc::new(AtomicBool::new(false));
	let reader_stop_flag = Arc::clone(&reader_stop);
	let stderr_buf = Arc::new(std::sync::Mutex::new(String::new()));
	let stderr_buf_writer = Arc::clone(&stderr_buf);
	let last_sidecar_pct = Arc::new(AtomicU32::new(0));
	let last_sidecar_pct_reader = Arc::clone(&last_sidecar_pct);
	let got_progress = Arc::new(AtomicBool::new(false));
	let got_progress_reader = Arc::clone(&got_progress);
	let err_log_reader = err_log.clone();

	let progress_thread = std::thread::spawn(move || {
		let mut offset: u64 = 0;
		let mut carry = String::new();
		loop {
			let stopping =
				reader_cancel.load(Ordering::Relaxed) || reader_stop_flag.load(Ordering::Relaxed);
			match fs::OpenOptions::new().read(true).open(&err_log_reader) {
				Ok(mut f) => {
					use std::io::Seek;
					if f.seek(std::io::SeekFrom::Start(offset)).is_ok() {
						let mut chunk = Vec::new();
						if f.read_to_end(&mut chunk).is_ok() && !chunk.is_empty() {
							offset += chunk.len() as u64;
							got_progress_reader.store(true, Ordering::Relaxed);
							let text = String::from_utf8_lossy(&chunk);
							carry.push_str(&text);
							carry = carry.replace('\r', "\n");
							while let Some(idx) = carry.find('\n') {
								let mut line = carry[..idx].to_string();
								carry = carry[idx + 1..].to_string();
								if line.len() > 500 {
									line.truncate(500);
								}
								if let Ok(mut acc) = stderr_buf_writer.lock() {
									if acc.len() < 24_000 {
										acc.push_str(&line);
										acc.push('\n');
									}
								}
								let line = line.trim();
								if line.is_empty() {
									continue;
								}
								if let Some((pct, msg)) = parse_progress_line(line) {
									last_sidecar_pct_reader.store(pct.max(1), Ordering::Relaxed);
									let mapped = 25 + ((pct as f32 / 100.0) * 65.0) as u32;
									emit_progress(
										&app_progress,
										"funasr",
										if msg.is_empty() {
											"FunASR transcribing…"
										} else {
											&msg
										},
										mapped.min(90),
									);
									continue;
								}
								if let Some((done, total, label)) = parse_download_bar(line) {
									let pct = if total > 0 {
										((done as f32 / total as f32) * 100.0).round() as u32
									} else {
										0
									};
									let mapped = 28 + ((pct as f32 / 100.0) * 35.0) as u32;
									last_sidecar_pct_reader
										.store((15 + pct / 2).max(1), Ordering::Relaxed);
									emit_progress(
										&app_progress,
										"funasr",
										&format!("Downloading {label}… {pct}%"),
										mapped.min(70),
									);
								}
							}
							if carry.len() > 64 * 1024 {
								carry.clear();
							}
						} else if stopping {
							break;
						}
					} else if stopping {
						break;
					}
				}
				Err(_) => {
					if stopping {
						break;
					}
				}
			}
			if stopping {
				break;
			}
			std::thread::sleep(Duration::from_millis(250));
		}
	});

	let started = Instant::now();
	let mut last_heartbeat = Instant::now();
	let mut last_activity = Instant::now();
	const MAX_WAIT: Duration = Duration::from_secs(20 * 60);
	// First-run model download can exceed 5 minutes; only abort if truly silent.
	const NO_ACTIVITY_ABORT: Duration = Duration::from_secs(8 * 60);

	loop {
		if cancel.load(Ordering::Relaxed) {
			let _ = child.kill();
			reader_stop.store(true, Ordering::Relaxed);
			let _ = progress_thread.join();
			let _ = fs::remove_file(&err_log);
			return Err("Transcription cancelled.".into());
		}

		let elapsed = started.elapsed();
		if elapsed > MAX_WAIT {
			let _ = child.kill();
			reader_stop.store(true, Ordering::Relaxed);
			let _ = progress_thread.join();
			let _ = fs::remove_file(&err_log);
			return Err(format!(
				"FunASR timed out after {}s (model download/load). Falling back.",
				elapsed.as_secs()
			));
		}

		if got_progress.load(Ordering::Relaxed) {
			last_activity = Instant::now();
			got_progress.store(false, Ordering::Relaxed);
		} else if last_activity.elapsed() > NO_ACTIVITY_ABORT {
			let _ = child.kill();
			reader_stop.store(true, Ordering::Relaxed);
			let _ = progress_thread.join();
			let _ = fs::remove_file(&err_log);
			return Err(format!(
				"FunASR produced no output for {}s. Falling back to Whisper.",
				NO_ACTIVITY_ABORT.as_secs()
			));
		}

		if last_heartbeat.elapsed() >= Duration::from_secs(2) {
			last_heartbeat = Instant::now();
			let side = last_sidecar_pct.load(Ordering::Relaxed);
			let mapped = if side > 0 {
				25 + ((side as f32 / 100.0) * 65.0) as u32
			} else {
				// Keep the bar moving even while torch/funasr imports (no PROGRESS yet).
				25 + ((elapsed.as_secs() as u32 / 4).min(20))
			};
			let msg = if side > 0 {
				format!("FunASR working… {}s", elapsed.as_secs())
			} else if elapsed.as_secs() < 45 {
				format!(
					"Loading FunASR libraries… {}s (SenseVoice is cached)",
					elapsed.as_secs()
				)
			} else {
				format!(
					"FunASR still running… {}s (long videos take a while on CPU)",
					elapsed.as_secs()
				)
			};
			emit_progress(app, "funasr", &msg, mapped.min(88));
		}

		match child.try_wait() {
			Ok(Some(_)) => break,
			Ok(None) => std::thread::sleep(Duration::from_millis(200)),
			Err(e) => {
				let _ = child.kill();
				reader_stop.store(true, Ordering::Relaxed);
				let _ = progress_thread.join();
				let _ = fs::remove_file(&err_log);
				return Err(format!("FunASR process error: {e}"));
			}
		}
	}

	let status = child
		.wait()
		.map_err(|e| format!("FunASR wait failed: {e}"))?;
	reader_stop.store(true, Ordering::Relaxed);
	let _ = progress_thread.join();

	let err_tail = stderr_buf
		.lock()
		.map(|b| b.clone())
		.unwrap_or_default();
	let _ = fs::remove_file(&err_log);

	if !status.success() {
		let detail = err_tail
			.lines()
			.rev()
			.find(|l| l.starts_with("ERROR") || l.to_ascii_lowercase().contains("error"))
			.unwrap_or(err_tail.lines().last().unwrap_or("unknown error"));
		return Err(format!(
			"FunASR failed: {detail}\nIf packages are missing, run: pnpm funasr:setup"
		));
	}

	if !out_json.is_file() {
		return Err(format!(
			"FunASR finished but wrote no output JSON. Log tail:\n{}",
			err_tail.chars().rev().take(800).collect::<String>().chars().rev().collect::<String>()
		));
	}

	let raw = fs::read_to_string(out_json).map_err(|e| format!("Read FunASR JSON: {e}"))?;
	let parsed: FunAsrFileResult =
		serde_json::from_str(&raw).map_err(|e| format!("Parse FunASR JSON: {e}"))?;

	let mut segments: Vec<TranscriptSegment> = Vec::with_capacity(parsed.segments.len());
	for s in parsed.segments {
		let text = s.text.trim().to_string();
		if text.is_empty() {
			continue;
		}
		let start = s.start_ms;
		let end = s.end_ms.max(start + 120);
		segments.push(TranscriptSegment {
			start_ms: start,
			end_ms: end,
			text,
		});
	}

	if segments.is_empty() {
		return Err("FunASR returned no usable speech segments.".into());
	}

	let model_label = if parsed.model.is_empty() {
		format!("funasr:{model}")
	} else {
		parsed.model
	};
	let language = if parsed.language.is_empty() {
		lang.to_string()
	} else {
		parsed.language
	};

	Ok((segments, language, model_label))
}

/// Drain helper kept for future stdout capture needs.
#[allow(dead_code)]
fn drain_to_string(mut r: impl Read) -> String {
	let mut s = String::new();
	let _ = r.read_to_string(&mut s);
	s
}
