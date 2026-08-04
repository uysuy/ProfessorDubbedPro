//! Pitch-safe video tempo remaster: slow/speed media with setpts + atempo
//! so speech pitch stays natural and cue times can be scaled by 1/tempo.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager};

use crate::export::{ffmpeg_fail_message, ffmpeg_path_arg, find_ffmpeg};

const PROGRESS_EVENT: &str = "video-tempo-progress";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemasterVideoTempoArgs {
	/// Absolute path to the source video.
	pub video_path: String,
	/// Playback speed relative to the current file (0.5–2.0; &lt;1 slows, &gt;1 speeds).
	pub tempo: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemasterVideoTempoResult {
	pub output_path: String,
	pub tempo: f64,
	pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TempoProgress {
	stage: String,
	message: String,
	percent: u32,
}

fn emit_progress(app: &AppHandle, stage: &str, message: &str, percent: u32) {
	let _ = app.emit(
		PROGRESS_EVENT,
		TempoProgress {
			stage: stage.into(),
			message: message.into(),
			percent: percent.min(100),
		},
	);
}

fn clamp_tempo(raw: f64) -> Result<f64, String> {
	if !raw.is_finite() {
		return Err("Tempo must be a finite number.".into());
	}
	// Keep within FFmpeg atempo range (chained for extremes); UI fit uses 0.5–2.0.
	let t = raw.clamp(0.5, 2.0);
	if (t - 1.0).abs() < 0.001 {
		return Err("Tempo is already 1.00× — nothing to remaster.".into());
	}
	Ok((t * 1000.0).round() / 1000.0)
}

/// Build chained `atempo` filters when needed (each stage must be in [0.5, 2.0]).
fn atempo_filter_chain(tempo: f64) -> String {
	let mut remaining = tempo;
	let mut parts: Vec<String> = Vec::new();
	// Prefer one stage for our UI range.
	while remaining < 0.5 - 1e-9 {
		parts.push("atempo=0.5".into());
		remaining /= 0.5;
	}
	while remaining > 2.0 + 1e-9 {
		parts.push("atempo=2.0".into());
		remaining /= 2.0;
	}
	parts.push(format!("atempo={remaining:.6}"));
	parts.join(",")
}

fn probe_duration_ms(ffmpeg: &Path, video: &Path) -> Result<u64, String> {
	// `-i` alone exits quickly after printing Duration (no full decode).
	let output = Command::new(ffmpeg)
		.args(["-hide_banner", "-i", &ffmpeg_path_arg(video)])
		.output()
		.map_err(|e| format!("Failed to probe video: {e}"))?;
	let stderr = String::from_utf8_lossy(&output.stderr);
	parse_duration_ms_from_ffmpeg_log(&stderr)
		.ok_or_else(|| "Could not read remastered video duration.".into())
}

fn parse_duration_ms_from_ffmpeg_log(log: &str) -> Option<u64> {
	// Duration: 00:01:06.10
	for line in log.lines() {
		let line = line.trim();
		let Some(rest) = line.strip_prefix("Duration:") else {
			continue;
		};
		let token = rest.split(',').next()?.trim();
		let parts: Vec<&str> = token.split(':').collect();
		if parts.len() != 3 {
			continue;
		}
		let h: f64 = parts[0].parse().ok()?;
		let m: f64 = parts[1].parse().ok()?;
		let s: f64 = parts[2].parse().ok()?;
		let ms = ((h * 3600.0 + m * 60.0 + s) * 1000.0).round();
		if ms.is_finite() && ms > 0.0 {
			return Some(ms as u64);
		}
	}
	None
}

fn parse_time_ms_from_progress(line: &str) -> Option<u64> {
	// time=00:01:02.45
	let idx = line.find("time=")?;
	let rest = &line[idx + 5..];
	let token = rest.split_whitespace().next()?;
	if token.starts_with('N') {
		return None;
	}
	let parts: Vec<&str> = token.split(':').collect();
	if parts.len() != 3 {
		return None;
	}
	let h: f64 = parts[0].parse().ok()?;
	let m: f64 = parts[1].parse().ok()?;
	let s: f64 = parts[2].parse().ok()?;
	Some(((h * 3600.0 + m * 60.0 + s) * 1000.0).round() as u64)
}

fn tempo_work_dir(app: &AppHandle) -> Result<PathBuf, String> {
	let dir = app
		.path()
		.temp_dir()
		.map_err(|e| format!("Could not resolve temp dir: {e}"))?
		.join("professor-dubbed-pro-tempo");
	fs::create_dir_all(&dir).map_err(|e| format!("Could not create tempo temp dir: {e}"))?;
	Ok(dir)
}

fn remaster_blocking(
	app: &AppHandle,
	args: RemasterVideoTempoArgs,
) -> Result<RemasterVideoTempoResult, String> {
	let tempo = clamp_tempo(args.tempo)?;
	let video = PathBuf::from(args.video_path.trim());
	if !video.is_file() {
		return Err("Source video not found. Open a video first.".into());
	}

	let ffmpeg = find_ffmpeg(app)?;
	emit_progress(app, "start", "Preparing pitch-safe remaster…", 4);

	let src_dur = probe_duration_ms(&ffmpeg, &video).unwrap_or(0);
	let expected_out_ms = if src_dur > 0 {
		((src_dur as f64) / tempo).round() as u64
	} else {
		0
	};

	let dir = tempo_work_dir(app)?;
	let stamp = std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.map(|d| d.as_millis())
		.unwrap_or(0);
	let stem = video
		.file_stem()
		.and_then(|s| s.to_str())
		.unwrap_or("video");
	let out = dir.join(format!("{stem}-tempo-{tempo:.3}-{stamp}.mp4"));

	if TEMPO_CANCEL.load(Ordering::Relaxed) {
		return Err("Tempo remaster cancelled.".into());
	}

	emit_progress(
		app,
		"encode",
		&format!("Remastering at {tempo:.2}× (pitch preserved)…"),
		12,
	);

	let vf = format!("setpts=PTS/{tempo}");
	let af = atempo_filter_chain(tempo);

	let mut child = Command::new(&ffmpeg)
		.args([
			"-hide_banner",
			"-y",
			"-i",
			&ffmpeg_path_arg(&video),
			"-vf",
			&vf,
			"-af",
			&af,
			"-c:v",
			"libx264",
			"-preset",
			"veryfast",
			"-crf",
			"20",
			"-c:a",
			"aac",
			"-b:a",
			"192k",
			"-movflags",
			"+faststart",
			"-progress",
			"pipe:1",
			"-nostats",
			&ffmpeg_path_arg(&out),
		])
		.stdout(Stdio::piped())
		.stderr(Stdio::piped())
		.spawn()
		.map_err(|e| format!("Failed to start FFmpeg: {e}"))?;

	let stdout = child.stdout.take();
	let stderr = child.stderr.take();
	let app_progress = app.clone();

	let progress_thread = std::thread::spawn(move || {
		let Some(stdout) = stdout else { return };
		let reader = BufReader::new(stdout);
		for line in reader.lines().flatten() {
			if TEMPO_CANCEL.load(Ordering::Relaxed) {
				break;
			}
			if let Some(ms) = parse_time_ms_from_progress(&line) {
				if expected_out_ms > 0 {
					let pct = 12 + ((ms as f64 / expected_out_ms as f64) * 80.0) as u32;
					emit_progress(
						&app_progress,
						"encode",
						&format!("Remastering… {:.1}s", ms as f64 / 1000.0),
						pct.min(92),
					);
				}
			}
		}
	});

	let err_buf = std::sync::Mutex::new(String::new());
	let err_buf_thread = std::sync::Arc::new(err_buf);
	let err_writer = std::sync::Arc::clone(&err_buf_thread);
	let stderr_thread = std::thread::spawn(move || {
		let Some(stderr) = stderr else { return };
		let reader = BufReader::new(stderr);
		for line in reader.lines().flatten() {
			if let Ok(mut acc) = err_writer.lock() {
				if acc.len() < 12_000 {
					acc.push_str(&line);
					acc.push('\n');
				}
			}
		}
	});

	loop {
		if TEMPO_CANCEL.load(Ordering::Relaxed) {
			let _ = child.kill();
			let _ = progress_thread.join();
			let _ = stderr_thread.join();
			let _ = fs::remove_file(&out);
			return Err("Tempo remaster cancelled.".into());
		}
		match child.try_wait() {
			Ok(Some(_)) => break,
			Ok(None) => std::thread::sleep(std::time::Duration::from_millis(120)),
			Err(e) => {
				let _ = child.kill();
				let _ = progress_thread.join();
				let _ = stderr_thread.join();
				return Err(format!("FFmpeg process error: {e}"));
			}
		}
	}

	let status = child
		.wait()
		.map_err(|e| format!("FFmpeg wait failed: {e}"))?;
	let _ = progress_thread.join();
	let _ = stderr_thread.join();

	if !status.success() {
		let err_tail = err_buf_thread
			.lock()
			.map(|b| b.clone())
			.unwrap_or_default();
		let fake = std::process::Output {
			status,
			stdout: Vec::new(),
			stderr: err_tail.into_bytes(),
		};
		let _ = fs::remove_file(&out);
		return Err(ffmpeg_fail_message(&fake));
	}

	if !out.is_file() {
		return Err("FFmpeg finished but wrote no output file.".into());
	}

	emit_progress(app, "probe", "Measuring remastered duration…", 95);
	let duration_ms = probe_duration_ms(&ffmpeg, &out).unwrap_or(expected_out_ms);
	emit_progress(app, "done", "Tempo remaster complete", 100);

	Ok(RemasterVideoTempoResult {
		output_path: out.to_string_lossy().into_owned(),
		tempo,
		duration_ms,
	})
}

static TEMPO_CANCEL: AtomicBool = AtomicBool::new(false);

#[tauri::command]
pub async fn remaster_video_tempo(
	app: AppHandle,
	args: RemasterVideoTempoArgs,
) -> Result<RemasterVideoTempoResult, String> {
	TEMPO_CANCEL.store(false, Ordering::Relaxed);
	tauri::async_runtime::spawn_blocking(move || remaster_blocking(&app, args))
		.await
		.map_err(|e| format!("Tempo remaster task failed: {e}"))?
}

#[tauri::command]
pub fn cancel_video_tempo() -> Result<(), String> {
	TEMPO_CANCEL.store(true, Ordering::Relaxed);
	Ok(())
}

#[cfg(test)]
mod tests {
	use super::{atempo_filter_chain, clamp_tempo, parse_duration_ms_from_ffmpeg_log};

	#[test]
	fn clamps_and_rejects_identity() {
		assert!(clamp_tempo(1.0).is_err());
		assert!((clamp_tempo(0.92).unwrap() - 0.92).abs() < 1e-9);
	}

	#[test]
	fn atempo_single_stage_for_ui_range() {
		let f = atempo_filter_chain(0.92);
		assert_eq!(f, "atempo=0.920000");
	}

	#[test]
	fn parses_duration_banner() {
		let log = "  Duration: 00:01:06.10, start: 0.000000, bitrate: 386 kb/s\n";
		assert_eq!(parse_duration_ms_from_ffmpeg_log(log), Some(66100));
	}
}
