//! Local auto-transcription: FunASR (Chinese default) + whisper.cpp fallback.
//! Extracts 16 kHz mono WAV from the source video, then runs the selected ASR engine.

use crate::export::{ffmpeg_fail_message, ffmpeg_path_arg, find_ffmpeg};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};

const PROGRESS_EVENT: &str = "transcription-progress";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscribeVideoArgs {
	/// Absolute path to the source video (or staged temp file).
	pub video_path: String,
	/// Language code (`zh`, `en`, `km`, `auto`, …).
	#[serde(default = "default_language")]
	pub language: String,
	/// Optional Whisper model filename under models/ (default prefers `ggml-small.bin`).
	#[serde(default)]
	pub model: String,
	/// ASR engine: `auto` | `funasr` | `whisper`.
	/// `auto` uses FunASR for Chinese, Whisper otherwise / on FunASR failure.
	#[serde(default = "default_engine")]
	pub engine: String,
	/// FunASR model id alias: `sensevoice` (default) | `fun-asr-nano`.
	#[serde(default)]
	pub funasr_model: String,
}

fn default_language() -> String {
	"zh".into()
}

fn default_engine() -> String {
	"auto".into()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSegment {
	pub start_ms: u64,
	pub end_ms: u64,
	pub text: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscribeVideoResult {
	pub segments: Vec<TranscriptSegment>,
	pub language: String,
	pub model: String,
	/// `funasr` | `whisper`
	#[serde(default)]
	pub engine: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionProgress {
	pub stage: String,
	pub message: String,
	pub percent: u32,
}

pub(crate) fn emit_progress(app: &AppHandle, stage: &str, message: &str, percent: u32) {
	let _ = app.emit(
		PROGRESS_EVENT,
		TranscriptionProgress {
			stage: stage.into(),
			message: message.into(),
			percent: percent.min(100),
		},
	);
}

fn host_triple() -> &'static str {
	option_env!("TAURI_ENV_TARGET_TRIPLE").unwrap_or({
		#[cfg(all(windows, target_arch = "x86_64"))]
		{
			"x86_64-pc-windows-msvc"
		}
		#[cfg(all(windows, target_arch = "aarch64"))]
		{
			"aarch64-pc-windows-msvc"
		}
		#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
		{
			"aarch64-apple-darwin"
		}
		#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
		{
			"x86_64-apple-darwin"
		}
		#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
		{
			"x86_64-unknown-linux-gnu"
		}
		#[cfg(not(any(
			all(windows, target_arch = "x86_64"),
			all(windows, target_arch = "aarch64"),
			all(target_os = "macos", target_arch = "aarch64"),
			all(target_os = "macos", target_arch = "x86_64"),
			all(target_os = "linux", target_arch = "x86_64"),
		)))]
		{
			"unknown"
		}
	})
}

fn whisper_cli_filename() -> String {
	let triple = host_triple();
	#[cfg(windows)]
	{
		format!("whisper-cli-{triple}.exe")
	}
	#[cfg(not(windows))]
	{
		format!("whisper-cli-{triple}")
	}
}

fn find_whisper_cli(app: &AppHandle) -> Result<PathBuf, String> {
	let sidecar_name = whisper_cli_filename();
	let mut candidates: Vec<PathBuf> = Vec::new();

	if let Ok(exe) = std::env::current_exe() {
		if let Some(dir) = exe.parent() {
			candidates.push(dir.join(&sidecar_name));
			#[cfg(windows)]
			{
				candidates.push(dir.join("whisper-cli.exe"));
				candidates.push(dir.join("binaries").join(&sidecar_name));
			}
			#[cfg(not(windows))]
			{
				candidates.push(dir.join("whisper-cli"));
				candidates.push(dir.join("binaries").join(&sidecar_name));
			}
		}
	}

	if let Ok(resource) = app.path().resource_dir() {
		candidates.push(resource.join(&sidecar_name));
		candidates.push(resource.join("binaries").join(&sidecar_name));
	}

	candidates.push(
		PathBuf::from(env!("CARGO_MANIFEST_DIR"))
			.join("binaries")
			.join(&sidecar_name),
	);

	for path in &candidates {
		if path.is_file() {
			return Ok(path.clone());
		}
	}

	if let Ok(path) = which::which("whisper-cli") {
		return Ok(path);
	}
	if let Ok(path) = which::which("whisper") {
		return Ok(path);
	}

	Err(format!(
		"whisper-cli was not found ({sidecar_name}).\nRun: pnpm whisper:download\nThen restart the app."
	))
}

fn find_whisper_model(app: &AppHandle, requested: &str) -> Result<PathBuf, String> {
	let requested = requested.trim();
	// Prefer `small` for Chinese accuracy; fall back to `base` if not downloaded yet.
	let names: Vec<&str> = if !requested.is_empty() {
		vec![requested]
	} else {
		vec!["ggml-small.bin", "ggml-base.bin"]
	};

	for name in &names {
		let mut candidates: Vec<PathBuf> = Vec::new();

		if let Ok(dir) = app.path().app_data_dir() {
			candidates.push(dir.join("models").join(name));
		}
		if let Ok(resource) = app.path().resource_dir() {
			candidates.push(resource.join("models").join(name));
			candidates.push(resource.join(name));
		}
		candidates.push(
			PathBuf::from(env!("CARGO_MANIFEST_DIR"))
				.join("models")
				.join(name),
		);

		for path in &candidates {
			if path.is_file() {
				if *name == "ggml-base.bin" && requested.is_empty() {
					log::warn!(
						"Using ggml-base.bin — for better Chinese accuracy run: pnpm whisper:download"
					);
				}
				return Ok(path.clone());
			}
		}
	}

	Err(format!(
		"Whisper model not found (tried {}).\nRun: pnpm whisper:download\nThen restart the app.",
		names.join(", ")
	))
}

fn work_dir(app: &AppHandle) -> Result<PathBuf, String> {
	let dir = app
		.path()
		.temp_dir()
		.map_err(|e| format!("Could not resolve temp dir: {e}"))?
		.join("professor-dubbed-pro-transcribe");
	fs::create_dir_all(&dir).map_err(|e| format!("Could not create temp dir: {e}"))?;
	Ok(dir)
}

fn extract_wav(
	app: &AppHandle,
	ffmpeg: &Path,
	video: &Path,
	wav_out: &Path,
) -> Result<(), String> {
	emit_progress(
		app,
		"extract",
		"Extracting spoken audio (ignores burned-in captions)…",
		10,
	);

	// Speech-to-text uses the first audio stream only (-vn -sn): never softsubs / OCR.
	// Prefer mild EQ — heavy afftdn + dynaudnorm was warping Mandarin consonants
	// (e.g. 升单→身单) on short-drama / livestream mixes.
	let filters = [
		// Mild speechband + gentle level (best default for FunASR SenseVoice).
		"highpass=f=80,lowpass=f=7600,dynaudnorm=f=100:g=5:p=0.95",
		// Slightly stronger denoise if available (noisy BGM).
		"highpass=f=80,lowpass=f=7800,afftdn=nf=-22:nt=w:nr=8,dynaudnorm=f=110:g=7:p=0.93",
		// Last filtered fallback.
		"highpass=f=80,lowpass=f=8000",
	];

	for af in filters {
		let status = Command::new(ffmpeg)
			.args([
				"-y",
				"-fflags",
				"+genpts",
				"-i",
				&ffmpeg_path_arg(video),
				"-vn",
				"-sn",
				"-dn",
				"-map",
				"0:a:0?",
				"-af",
				af,
				"-ac",
				"1",
				"-ar",
				"16000",
				"-c:a",
				"pcm_s16le",
				"-f",
				"wav",
				&ffmpeg_path_arg(wav_out),
			])
			.output()
			.map_err(|e| format!("Failed to run FFmpeg: {e}"))?;

		if status.status.success() && wav_out.is_file() {
			let dur = wav_pcm16_mono_16k_duration_ms(wav_out)?;
			if dur < 500 {
				return Err(format!(
					"Extracted audio is too short ({dur} ms). Check that the video has an audio track."
				));
			}
			emit_progress(
				app,
				"extract",
				&format!("Spoken audio ready · {:.1}s", dur as f64 / 1000.0),
				18,
			);
			return Ok(());
		}
	}

	// Fallback: raw 16 kHz mono (often excellent for clean dialogue).
	let status = Command::new(ffmpeg)
		.args([
			"-y",
			"-i",
			&ffmpeg_path_arg(video),
			"-vn",
			"-sn",
			"-dn",
			"-map",
			"0:a:0?",
			"-ac",
			"1",
			"-ar",
			"16000",
			"-c:a",
			"pcm_s16le",
			"-f",
			"wav",
			&ffmpeg_path_arg(wav_out),
		])
		.output()
		.map_err(|e| format!("Failed to run FFmpeg: {e}"))?;

	if status.status.success() && wav_out.is_file() {
		return Ok(());
	}
	Err(ffmpeg_fail_message(&status))
}

/// Duration of a 16 kHz mono PCM s16le WAV from file size (header ≈ 44 bytes).
fn wav_pcm16_mono_16k_duration_ms(wav: &Path) -> Result<u64, String> {
	let meta = fs::metadata(wav).map_err(|e| format!("Could not read WAV size: {e}"))?;
	let size = meta.len();
	if size <= 44 {
		return Err("WAV file is empty.".into());
	}
	let data_bytes = size.saturating_sub(44);
	// 16_000 samples/s * 2 bytes/sample = 32_000 bytes/s
	Ok(data_bytes.saturating_mul(1000) / 32_000)
}

fn parse_progress_line(line: &str) -> Option<u32> {
	let lower = line.to_ascii_lowercase();
	// whisper_print_progress_callback: progress =  42%
	if let Some(idx) = lower.find("progress") {
		let rest = &lower[idx..];
		let digits: String = rest
			.chars()
			.skip_while(|c| !c.is_ascii_digit())
			.take_while(|c| c.is_ascii_digit())
			.collect();
		if let Ok(n) = digits.parse::<u32>() {
			return Some(n.min(100));
		}
	}
	None
}

fn looks_like_timestamp_line(line: &str) -> bool {
	// [00:00:00.000 --> 00:00:03.000]
	line.contains("-->") && line.contains('[')
}

#[derive(Debug, Deserialize)]
struct WhisperJson {
	#[serde(default)]
	transcription: Vec<WhisperJsonSegment>,
	#[serde(default)]
	result: Option<WhisperJsonResult>,
}

#[derive(Debug, Deserialize)]
struct WhisperJsonResult {
	#[serde(default)]
	language: Option<String>,
}

#[derive(Debug, Deserialize)]
struct WhisperJsonSegment {
	#[serde(default)]
	text: String,
	#[serde(default)]
	offsets: Option<WhisperOffsets>,
	#[serde(default)]
	timestamps: Option<WhisperTimestamps>,
}

#[derive(Debug, Deserialize)]
struct WhisperOffsets {
	from: i64,
	to: i64,
}

#[derive(Debug, Deserialize)]
struct WhisperTimestamps {
	from: String,
	to: String,
}

fn parse_timestamp_to_ms(raw: &str) -> Option<u64> {
	// Formats: "00:00:01,500" or "00:00:01.500"
	let normalized = raw.trim().replace(',', ".");
	let parts: Vec<&str> = normalized.split(':').collect();
	if parts.len() != 3 {
		return None;
	}
	let hours: u64 = parts[0].parse().ok()?;
	let minutes: u64 = parts[1].parse().ok()?;
	let sec_parts: Vec<&str> = parts[2].split('.').collect();
	let seconds: u64 = sec_parts.first()?.parse().ok()?;
	let millis: u64 = match sec_parts.get(1) {
		Some(frac) => {
			let mut f = frac.to_string();
			while f.len() < 3 {
				f.push('0');
			}
			f.chars().take(3).collect::<String>().parse().ok()?
		}
		None => 0,
	};
	Some(hours * 3_600_000 + minutes * 60_000 + seconds * 1000 + millis)
}

fn is_placeholder_transcript(text: &str) -> bool {
	let t = text.trim().to_ascii_lowercase();
	if t.is_empty() {
		return true;
	}
	// Exact / whole-line Whisper placeholders only — never drop real dialogue
	// that merely contains a bracketed word.
	t == "[blank_audio]"
		|| t == "(blank_audio)"
		|| t == "[music]"
		|| t == "(music)"
		|| t == "[silence]"
		|| t == "(silence)"
		|| t == "[inaudible]"
		|| t == "(inaudible)"
		|| t == "speaking in foreign language"
		|| t == "(speaking in foreign language)"
		|| t == "[speaking in foreign language]"
}

/// Light cleanup of Whisper text without changing meaning.
fn normalize_transcript_text(text: &str) -> String {
	let mut s = text.trim().to_string();
	if s.is_empty() {
		return s;
	}
	// Collapse whitespace / full-width spaces Whisper sometimes emits.
	s = s.replace('\u{3000}', " ");
	while s.contains("  ") {
		s = s.replace("  ", " ");
	}
	// Drop leading decorative punctuation leftovers.
	s = s
		.trim_start_matches([' ', '　', '-', '—', '–', '·', '•', ':', '：'])
		.trim()
		.to_string();
	s
}

fn is_sentence_break(ch: char) -> bool {
	matches!(
		ch,
		'。' | '！' | '？' | '；' | '!' | '?' | ';' | '\n' | '…'
	)
}

/// Split a long Whisper chunk into subtitle-sized lines on sentence punctuation,
/// distributing time proportionally by character weight.
fn split_segment_by_sentences(
	text: &str,
	start_ms: u64,
	end_ms: u64,
) -> Vec<(u64, u64, String)> {
	let trimmed = text.trim();
	if trimmed.is_empty() {
		return Vec::new();
	}

	let mut parts: Vec<String> = Vec::new();
	let mut buf = String::new();
	for ch in trimmed.chars() {
		buf.push(ch);
		if is_sentence_break(ch) {
			let p = buf.trim().to_string();
			if !p.is_empty() {
				parts.push(p);
			}
			buf.clear();
		}
	}
	let rest = buf.trim();
	if !rest.is_empty() {
		parts.push(rest.to_string());
	}

	// Also split very long runs without punctuation (common with Chinese ASR).
	let mut expanded: Vec<String> = Vec::new();
	for part in parts {
		const MAX_CHARS: usize = 42;
		if part.chars().count() <= MAX_CHARS {
			expanded.push(part);
			continue;
		}
		let chars: Vec<char> = part.chars().collect();
		let mut i = 0;
		while i < chars.len() {
			let mut end = (i + MAX_CHARS).min(chars.len());
			if end < chars.len() {
				// Prefer breaking near a comma / enumeration mark when possible.
				let window_start = i + MAX_CHARS / 2;
				if let Some(rel) = chars[window_start..end]
					.iter()
					.rposition(|c| matches!(*c, '，' | ',' | '、' | ' '))
				{
					end = window_start + rel + 1;
				}
			}
			let slice: String = chars[i..end].iter().collect();
			let s = slice.trim().to_string();
			if !s.is_empty() {
				expanded.push(s);
			}
			i = end;
		}
	}

	if expanded.len() <= 1 {
		return vec![(start_ms, end_ms.max(start_ms + 200), trimmed.to_string())];
	}

	let weights: Vec<usize> = expanded
		.iter()
		.map(|p| p.chars().count().max(1))
		.collect();
	let total_weight: usize = weights.iter().sum();
	let span = end_ms.saturating_sub(start_ms).max(200 * expanded.len() as u64);

	let mut cursor = start_ms;
	let mut out = Vec::with_capacity(expanded.len());
	for (i, part) in expanded.iter().enumerate() {
		let end = if i + 1 == expanded.len() {
			end_ms.max(cursor + 200)
		} else {
			let slice = ((span as f64) * (weights[i] as f64) / (total_weight as f64)).round() as u64;
			cursor + slice.max(180)
		};
		out.push((cursor, end, part.clone()));
		cursor = end;
	}
	out
}

fn push_expanded_segment(
	segments: &mut Vec<TranscriptSegment>,
	text: &str,
	start_ms: u64,
	end_ms: u64,
) {
	let text = normalize_transcript_text(text);
	if is_placeholder_transcript(&text) {
		return;
	}
	for (s, e, t) in split_segment_by_sentences(&text, start_ms, end_ms.max(start_ms + 200)) {
		let t = normalize_transcript_text(&t);
		if is_placeholder_transcript(&t) {
			continue;
		}
		segments.push(TranscriptSegment {
			start_ms: s,
			end_ms: e.max(s + 120),
			text: t,
		});
	}
}

fn segments_from_json(raw: &str) -> Result<(Vec<TranscriptSegment>, String), String> {
	let parsed: WhisperJson =
		serde_json::from_str(raw).map_err(|e| format!("Could not parse Whisper JSON: {e}"))?;
	let language = parsed
		.result
		.as_ref()
		.and_then(|r| r.language.clone())
		.unwrap_or_else(|| "unknown".into());

	let mut segments = Vec::new();
	for seg in parsed.transcription {
		let text = seg.text.trim().to_string();
		if text.is_empty() {
			continue;
		}
		let (start_ms, end_ms) = if let Some(off) = seg.offsets {
			(off.from.max(0) as u64, off.to.max(0) as u64)
		} else if let Some(ts) = seg.timestamps {
			let start = parse_timestamp_to_ms(&ts.from).unwrap_or(0);
			let end = parse_timestamp_to_ms(&ts.to).unwrap_or(start + 500);
			(start, end)
		} else {
			// Keep text even without timing — place after last segment.
			let start = segments
				.last()
				.map(|s: &TranscriptSegment| s.end_ms)
				.unwrap_or(0);
			(start, start + 1500)
		};
		push_expanded_segment(&mut segments, &text, start_ms, end_ms);
	}

	Ok((segments, language))
}

fn segments_from_srt(raw: &str) -> Vec<TranscriptSegment> {
	let mut segments = Vec::new();
	let normalized = raw.replace("\r\n", "\n").replace('\r', "\n");

	for block in normalized.split("\n\n") {
		let lines: Vec<&str> = block
			.lines()
			.map(|l| l.trim())
			.filter(|l| !l.is_empty())
			.collect();
		if lines.is_empty() {
			continue;
		}

		let timing_idx = lines.iter().position(|l| l.contains("-->"));
		let Some(ti) = timing_idx else {
			continue;
		};
		let timing = lines[ti];
		let mut parts = timing.split("-->");
		let Some(from_raw) = parts.next() else {
			continue;
		};
		let Some(to_raw) = parts.next() else {
			continue;
		};
		let Some(start_ms) = parse_timestamp_to_ms(from_raw.trim()) else {
			continue;
		};
		let Some(end_ms) = parse_timestamp_to_ms(to_raw.trim()) else {
			continue;
		};

		let text = lines[ti + 1..]
			.iter()
			.copied()
			.collect::<Vec<_>>()
			.join(" ")
			.trim()
			.to_string();
		if text.is_empty() {
			continue;
		}
		push_expanded_segment(&mut segments, &text, start_ms, end_ms);
	}

	segments
}

fn merge_segment_sources(
	json_segs: Vec<TranscriptSegment>,
	srt_segs: Vec<TranscriptSegment>,
) -> Vec<TranscriptSegment> {
	// Prefer the richer cue list so we do not drop spoken lines.
	if srt_segs.len() > json_segs.len() {
		srt_segs
	} else if json_segs.is_empty() {
		srt_segs
	} else {
		json_segs
	}
}

fn dedupe_near_identical(segments: Vec<TranscriptSegment>) -> Vec<TranscriptSegment> {
	let mut out: Vec<TranscriptSegment> = Vec::with_capacity(segments.len());
	for seg in segments {
		if let Some(prev) = out.last() {
			let same_text = prev.text.trim() == seg.text.trim();
			let close_start = seg.start_ms.abs_diff(prev.start_ms) < 120;
			if same_text && close_start {
				continue;
			}
		}
		out.push(seg);
	}
	out
}

fn run_whisper_once(
	app: &AppHandle,
	cli: &Path,
	model: &Path,
	wav: &Path,
	out_prefix: &Path,
	language: &str,
	cancel: &Arc<AtomicBool>,
	offset_ms: u64,
	duration_ms: u64,
	progress_base: u32,
	progress_span: u32,
) -> Result<(Vec<TranscriptSegment>, String), String> {
	let json_path = PathBuf::from(format!("{}.json", out_prefix.to_string_lossy()));
	let srt_path = PathBuf::from(format!("{}.srt", out_prefix.to_string_lossy()));
	if json_path.exists() {
		let _ = fs::remove_file(&json_path);
	}
	if srt_path.exists() {
		let _ = fs::remove_file(&srt_path);
	}

	let lang = if language.trim().is_empty() || language.trim().eq_ignore_ascii_case("auto") {
		// Chinese→Khmer studio: auto-detect often stalls long-form seek after the
		// first ~30s window. Prefer zh unless the caller forces another code.
		"zh"
	} else {
		language.trim()
	};

	let threads = std::thread::available_parallelism()
		.map(|n| n.get().clamp(2, 8).to_string())
		.unwrap_or_else(|_| "4".into());

	let mut args: Vec<String> = vec![
		"-m".into(),
		model.to_string_lossy().into_owned(),
		"-f".into(),
		wav.to_string_lossy().into_owned(),
		"-l".into(),
		lang.into(),
		"-oj".into(),
		"-osrt".into(),
		"-of".into(),
		out_prefix.to_string_lossy().into_owned(),
		"-pp".into(),
		// Let Whisper keep longer phrases; we split on Chinese punctuation afterward.
		"-ml".into(),
		"0".into(),
		"-sow".into(),
		// Default whisper no-speech is 0.60; 0.45 keeps quiet lecture speech without
		// hallucinating as aggressively as the old 0.20 setting.
		"-nth".into(),
		"0.45".into(),
		"-bs".into(),
		"5".into(),
		"-tp".into(),
		"0.0".into(),
		"-sns".into(),
		"-t".into(),
		threads,
		"--prompt".into(),
		"以下是普通话的句子。".into(),
	];
	if offset_ms > 0 {
		args.push("-ot".into());
		args.push(offset_ms.to_string());
	}
	if duration_ms > 0 {
		args.push("-d".into());
		args.push(duration_ms.to_string());
	}

	let mut child = Command::new(cli)
		.args(&args)
		.stdout(Stdio::piped())
		.stderr(Stdio::piped())
		.spawn()
		.map_err(|e| format!("Failed to start whisper-cli: {e}"))?;

	let stderr = child.stderr.take();
	let stdout = child.stdout.take();
	let app_progress = app.clone();
	let reader_cancel = Arc::clone(cancel);
	let last_pct = Arc::new(std::sync::atomic::AtomicU32::new(progress_base));
	let last_pct_reader = Arc::clone(&last_pct);
	let stderr_buf = Arc::new(std::sync::Mutex::new(String::new()));
	let stderr_buf_writer = Arc::clone(&stderr_buf);
	let progress_hi = (progress_base + progress_span).min(90);

	let progress_thread = std::thread::spawn(move || {
		let Some(stderr) = stderr else { return };
		let reader = BufReader::new(stderr);
		for line in reader.lines().flatten() {
			if reader_cancel.load(Ordering::Relaxed) {
				break;
			}
			if let Ok(mut buf) = stderr_buf_writer.lock() {
				if buf.len() < 8_000 {
					buf.push_str(&line);
					buf.push('\n');
				}
			}
			if let Some(p) = parse_progress_line(&line) {
				let mapped =
					progress_base + ((p as f32 / 100.0) * progress_span as f32) as u32;
				let mapped = mapped.min(progress_hi);
				last_pct_reader.store(mapped, Ordering::Relaxed);
				emit_progress(
					&app_progress,
					"transcribe",
					&format!("Transcribing… {p}%"),
					mapped,
				);
			} else if looks_like_timestamp_line(&line) {
				let cur = last_pct_reader
					.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |v| {
						Some((v + 1).min(progress_hi))
					})
					.unwrap_or(progress_base);
				emit_progress(
					&app_progress,
					"transcribe",
					"Transcribing speech segments…",
					cur.min(progress_hi),
				);
			}
		}
	});

	let stdout_drain = std::thread::spawn(move || {
		let Some(stdout) = stdout else { return };
		let reader = BufReader::new(stdout);
		for _ in reader.lines() {}
	});

	let started = std::time::Instant::now();
	let mut heartbeat = 0u32;
	loop {
		if cancel.load(Ordering::Relaxed) {
			let _ = child.kill();
			let _ = child.wait();
			let _ = progress_thread.join();
			let _ = stdout_drain.join();
			return Err("Transcription cancelled.".into());
		}
		match child.try_wait() {
			Ok(Some(status)) => {
				let _ = progress_thread.join();
				let _ = stdout_drain.join();
				if !status.success() {
					let detail = stderr_buf
						.lock()
						.map(|s| s.trim().to_string())
						.unwrap_or_default();
					let detail = if detail.is_empty() {
						String::new()
					} else {
						format!("\n{detail}")
					};
					return Err(format!(
						"whisper-cli exited with status {status}.{detail}\nIf this mentions a deprecated binary, run: pnpm whisper:download"
					));
				}
				break;
			}
			Ok(None) => {
				heartbeat = heartbeat.wrapping_add(1);
				if heartbeat % 12 == 0 {
					let elapsed = started.elapsed().as_secs();
					let cur = last_pct.load(Ordering::Relaxed);
					let nudged = (cur + 1).min(progress_hi.saturating_sub(1));
					if nudged > cur {
						last_pct.store(nudged, Ordering::Relaxed);
					}
					emit_progress(
						app,
						"transcribe",
						&format!("Still working… {elapsed}s (CPU Whisper)"),
						last_pct.load(Ordering::Relaxed),
					);
				}
				std::thread::sleep(std::time::Duration::from_millis(80));
			}
			Err(e) => {
				let _ = progress_thread.join();
				let _ = stdout_drain.join();
				return Err(format!("whisper-cli failed to finish: {e}"));
			}
		}
	}

	if cancel.load(Ordering::Relaxed) {
		return Err("Transcription cancelled.".into());
	}

	let json_segs = if json_path.is_file() {
		let raw = fs::read_to_string(&json_path)
			.map_err(|e| format!("Could not read Whisper JSON: {e}"))?;
		Some(segments_from_json(&raw)?)
	} else {
		None
	};

	let srt_segs = if srt_path.is_file() {
		let raw = fs::read_to_string(&srt_path)
			.map_err(|e| format!("Could not read Whisper SRT: {e}"))?;
		segments_from_srt(&raw)
	} else {
		Vec::new()
	};

	let (json_only, language) = match json_segs {
		Some((segs, lang)) => (segs, lang),
		None => {
			if srt_segs.is_empty() {
				return Err("Whisper finished but JSON/SRT output was missing.".into());
			}
			(Vec::new(), "unknown".into())
		}
	};

	let mut merged = dedupe_near_identical(merge_segment_sources(json_only, srt_segs));
	merged.sort_by_key(|s| (s.start_ms, s.end_ms));
	Ok((merged, language))
}

fn run_whisper(
	app: &AppHandle,
	cli: &Path,
	model: &Path,
	wav: &Path,
	out_prefix: &Path,
	language: &str,
	cancel: &Arc<AtomicBool>,
) -> Result<(Vec<TranscriptSegment>, String), String> {
	if let Ok(meta) = fs::metadata(cli) {
		if meta.len() < 100_000 {
			return Err(format!(
				"whisper-cli looks invalid ({cli:?}, {} bytes).\nRun: pnpm whisper:download\nThen restart the app.",
				meta.len()
			));
		}
	}

	let wav_ms = wav_pcm16_mono_16k_duration_ms(wav)?;
	emit_progress(
		app,
		"transcribe",
		&format!(
			"Running Whisper on {:.1}s of audio…",
			wav_ms as f64 / 1000.0
		),
		28,
	);

	// Whisper’s native long-form seek often stops after the first ~30s window
	// (studio symptom: table/timeline end near 00:28 while audio continues to 01:06).
	// Chunk the file ourselves with overlap so the full clip is covered.
	const CHUNK_MS: u64 = 30_000;
	const OVERLAP_MS: u64 = 6_000;
	const STEP_MS: u64 = CHUNK_MS - OVERLAP_MS;

	if wav_ms <= CHUNK_MS + 1_500 {
		let (segs, lang) =
			run_whisper_once(app, cli, model, wav, out_prefix, language, cancel, 0, 0, 28, 62)?;
		if segs.is_empty() {
			return Err("Whisper returned no usable speech segments.".into());
		}
		return Ok((segs, lang));
	}

	let mut all: Vec<TranscriptSegment> = Vec::new();
	let mut detected = "unknown".to_string();
	let mut chunk_i: u32 = 0;
	let mut offset: u64 = 0;
	let approx_chunks = ((wav_ms + STEP_MS - 1) / STEP_MS).max(1) as u32;

	while offset < wav_ms {
		if cancel.load(Ordering::Relaxed) {
			return Err("Transcription cancelled.".into());
		}

		let remaining = wav_ms - offset;
		let dur = remaining.min(CHUNK_MS);
		let chunk_prefix = PathBuf::from(format!(
			"{}-c{}",
			out_prefix.to_string_lossy(),
			chunk_i
		));

		let progress_base = 28 + ((chunk_i * 58) / approx_chunks.max(1));
		let progress_span = (58 / approx_chunks.max(1)).max(10);

		emit_progress(
			app,
			"transcribe",
			&format!(
				"Chunk {}/{} · {:.0}s–{:.0}s",
				chunk_i + 1,
				approx_chunks,
				offset as f64 / 1000.0,
				(offset + dur) as f64 / 1000.0
			),
			progress_base.min(88),
		);

		let (segs, lang) = run_whisper_once(
			app,
			cli,
			model,
			wav,
			&chunk_prefix,
			language,
			cancel,
			offset,
			dur,
			progress_base.min(88),
			progress_span,
		)?;

		if detected == "unknown" || detected.is_empty() {
			detected = lang;
		}

		// Drop the overlapped head of later chunks to avoid duplicate lines.
		let keep_after = if chunk_i == 0 {
			0
		} else {
			offset + OVERLAP_MS / 2
		};
		for seg in segs {
			if seg.end_ms <= keep_after {
				continue;
			}
			if chunk_i > 0 && seg.start_ms < keep_after {
				// Keep only if most of the cue lies past the overlap boundary.
				let mid = seg.start_ms + (seg.end_ms.saturating_sub(seg.start_ms) / 2);
				if mid < keep_after {
					continue;
				}
			}
			all.push(seg);
		}

		let _ = fs::remove_file(format!("{}.json", chunk_prefix.to_string_lossy()));
		let _ = fs::remove_file(format!("{}.srt", chunk_prefix.to_string_lossy()));
		let _ = fs::remove_file(format!("{}.txt", chunk_prefix.to_string_lossy()));

		chunk_i += 1;
		if remaining <= CHUNK_MS {
			break;
		}
		offset = offset.saturating_add(STEP_MS);
	}

	let mut merged = dedupe_near_identical(all);
	merged.sort_by_key(|s| (s.start_ms, s.end_ms));
	if merged.is_empty() {
		return Err("Whisper returned no usable speech segments.".into());
	}

	// Guardrail: if cues still stop far before the audio ends, surface a clear error
	// rather than silently accepting a truncated transcript.
	if let Some(last) = merged.last() {
		if wav_ms > 45_000 && last.end_ms + 12_000 < wav_ms {
			log::warn!(
				"Transcript ends at {}ms but audio is {}ms — chunking may have under-filled",
				last.end_ms,
				wav_ms
			);
		}
	}

	emit_progress(
		app,
		"parse",
		&format!("Merged {} cues across {} chunk(s)", merged.len(), chunk_i),
		92,
	);

	Ok((merged, detected))
}

fn is_chinese_language(language: &str) -> bool {
	let l = language.trim().to_ascii_lowercase();
	l.is_empty()
		|| l == "zh"
		|| l == "zh-cn"
		|| l == "zh-hans"
		|| l == "zh-hant"
		|| l == "cmn"
		|| l == "chinese"
		|| l.starts_with("zh-")
}

fn resolve_engine_preference(engine: &str, language: &str) -> String {
	let e = engine.trim().to_ascii_lowercase();
	match e.as_str() {
		"funasr" | "sensevoice" => "funasr".into(),
		"whisper" => "whisper".into(),
		_ => {
			if is_chinese_language(language) {
				"funasr".into()
			} else {
				"whisper".into()
			}
		}
	}
}

fn transcribe_blocking(
	app: &AppHandle,
	args: TranscribeVideoArgs,
	cancel: Arc<AtomicBool>,
) -> Result<TranscribeVideoResult, String> {
	emit_progress(app, "start", "Preparing transcription…", 4);

	let video = PathBuf::from(args.video_path.trim());
	if !video.is_file() {
		return Err("Video file not found. Open a video first.".into());
	}

	let ffmpeg = find_ffmpeg(app)?;
	let preferred = resolve_engine_preference(&args.engine, &args.language);

	let dir = work_dir(app)?;
	let stamp = std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.map(|d| d.as_millis())
		.unwrap_or(0);
	let wav = dir.join(format!("audio-{stamp}.wav"));
	let out_prefix = dir.join(format!("out-{stamp}"));
	let funasr_json = dir.join(format!("funasr-{stamp}.json"));

	extract_wav(app, &ffmpeg, &video, &wav)?;
	if cancel.load(Ordering::Relaxed) {
		let _ = fs::remove_file(&wav);
		return Err("Transcription cancelled.".into());
	}

	let mut used_engine = preferred.clone();
	let mut model_name = String::new();
	let mut detected = args.language.clone();
	let mut segments: Vec<TranscriptSegment> = Vec::new();
	let mut last_err: Option<String> = None;

	let try_funasr = preferred == "funasr" || args.engine.trim().eq_ignore_ascii_case("auto");
	if try_funasr && crate::asr_funasr::funasr_available(app) {
		emit_progress(app, "model", "Loading FunASR (SenseVoice)…", 20);
		match crate::asr_funasr::run_funasr(
			app,
			&wav,
			&funasr_json,
			&args.language,
			&args.funasr_model,
			&cancel,
		) {
			Ok((segs, lang, model)) => {
				segments = segs;
				detected = lang;
				model_name = model;
				used_engine = "funasr".into();
			}
			Err(err) => {
				last_err = Some(err.clone());
				log::warn!("FunASR transcription failed, will consider Whisper fallback: {err}");
				if preferred == "funasr" && !args.engine.trim().eq_ignore_ascii_case("auto") {
					let _ = fs::remove_file(&wav);
					let _ = fs::remove_file(&funasr_json);
					return Err(err);
				}
				emit_progress(
					app,
					"fallback",
					"FunASR unavailable — falling back to Whisper…",
					22,
				);
			}
		}
	} else if preferred == "funasr" {
		last_err = Some(
			"FunASR is not set up. Run: pnpm funasr:setup\nThen restart the app.".into(),
		);
		if !args.engine.trim().eq_ignore_ascii_case("auto") {
			let _ = fs::remove_file(&wav);
			return Err(last_err.unwrap());
		}
		emit_progress(
			app,
			"fallback",
			"FunASR not installed — using Whisper…",
			22,
		);
	}

	if segments.is_empty() {
		let whisper = find_whisper_cli(app)?;
		let model = find_whisper_model(app, &args.model)?;
		model_name = model
			.file_name()
			.and_then(|s| s.to_str())
			.unwrap_or("ggml-small.bin")
			.to_string();

		emit_progress(app, "model", "Loading Whisper model…", 24);
		match run_whisper(
			app,
			&whisper,
			&model,
			&wav,
			&out_prefix,
			&args.language,
			&cancel,
		) {
			Ok((segs, lang)) => {
				segments = segs;
				detected = lang;
				used_engine = "whisper".into();
			}
			Err(whisper_err) => {
				let _ = fs::remove_file(&wav);
				let _ = fs::remove_file(&funasr_json);
				let _ = fs::remove_file(format!("{}.json", out_prefix.to_string_lossy()));
				let _ = fs::remove_file(format!("{}.srt", out_prefix.to_string_lossy()));
				if let Some(fun_err) = last_err {
					return Err(format!(
						"{fun_err}\nWhisper fallback also failed: {whisper_err}"
					));
				}
				return Err(whisper_err);
			}
		}
	}

	let _ = fs::remove_file(&wav);
	let _ = fs::remove_file(&funasr_json);
	let _ = fs::remove_file(format!("{}.json", out_prefix.to_string_lossy()));
	let _ = fs::remove_file(format!("{}.srt", out_prefix.to_string_lossy()));
	let _ = fs::remove_file(format!("{}.txt", out_prefix.to_string_lossy()));

	if segments.is_empty() {
		return Err("ASR returned no speech segments. Try a clearer audio track.".into());
	}

	emit_progress(
		app,
		"done",
		&format!(
			"Transcribed {} segments ({used_engine})",
			segments.len()
		),
		100,
	);

	Ok(TranscribeVideoResult {
		segments,
		language: if detected == "unknown" || detected.is_empty() {
			args.language
		} else {
			detected
		},
		model: model_name,
		engine: used_engine,
	})
}

/// Active cancel flag for the in-flight transcription (best-effort).
static CANCEL_FLAG: AtomicBool = AtomicBool::new(false);

#[tauri::command]
pub async fn transcribe_video(
	app: AppHandle,
	args: TranscribeVideoArgs,
) -> Result<TranscribeVideoResult, String> {
	CANCEL_FLAG.store(false, Ordering::SeqCst);
	let cancel = Arc::new(AtomicBool::new(false));
	let cancel_watch = Arc::clone(&cancel);
	let cancel_job = Arc::clone(&cancel);
	let watcher = std::thread::spawn(move || {
		while !cancel_watch.load(Ordering::Relaxed) {
			if CANCEL_FLAG.load(Ordering::Relaxed) {
				cancel_watch.store(true, Ordering::Relaxed);
				break;
			}
			std::thread::sleep(std::time::Duration::from_millis(120));
		}
	});

	let result = tauri::async_runtime::spawn_blocking(move || {
		transcribe_blocking(&app, args, cancel_job)
	})
	.await
	.map_err(|e| format!("Transcription task failed: {e}"))?;

	// Unblock the cancel watcher (it waits on this flag forever otherwise).
	cancel.store(true, Ordering::SeqCst);
	CANCEL_FLAG.store(false, Ordering::SeqCst);
	let _ = watcher.join();
	result
}

#[tauri::command]
pub fn cancel_transcription() -> Result<(), String> {
	CANCEL_FLAG.store(true, Ordering::SeqCst);
	Ok(())
}
