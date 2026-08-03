//! Project export: SRT write + FFmpeg soft-subtitle mux.
//! Prefers the bundled FFmpeg sidecar; falls back to system PATH.

use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExportMode {
	Srt,
	VideoSoftSubs,
	/// Hardcoded / burned-in subtitles (always visible in any player).
	VideoBurnedIn,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportProjectArgs {
	pub mode: ExportMode,
	/// Full SRT document (UTF-8).
	pub srt_content: String,
	/// Destination path chosen by the user (`.srt` or `.mp4`).
	pub output_path: String,
	/// Absolute path to the source video (required for video export).
	pub video_path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportProjectResult {
	pub output_path: String,
	pub mode: String,
}

fn ensure_parent_dir(path: &Path) -> Result<(), String> {
	if let Some(parent) = path.parent() {
		if !parent.as_os_str().is_empty() {
			fs::create_dir_all(parent).map_err(|e| format!("Could not create output folder: {e}"))?;
		}
	}
	Ok(())
}

fn write_utf8_file(path: &Path, content: &str) -> Result<(), String> {
	ensure_parent_dir(path)?;
	fs::write(path, content.as_bytes()).map_err(|e| format!("Failed to write file: {e}"))
}

fn ffmpeg_sidecar_filename() -> String {
	// Injected by build.rs from Cargo's TARGET (e.g. x86_64-pc-windows-msvc).
	let triple = option_env!("TAURI_ENV_TARGET_TRIPLE").unwrap_or({
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
	});
	#[cfg(windows)]
	{
		format!("ffmpeg-{triple}.exe")
	}
	#[cfg(not(windows))]
	{
		format!("ffmpeg-{triple}")
	}
}

/// Prefer the app-bundled sidecar, then a binary next to the exe, then system PATH.
pub(crate) fn find_ffmpeg(app: &AppHandle) -> Result<PathBuf, String> {
	let sidecar_name = ffmpeg_sidecar_filename();
	let mut candidates: Vec<PathBuf> = Vec::new();

	// 1) Sidecar beside the running executable (tauri dev / production bundle)
	if let Ok(exe) = std::env::current_exe() {
		if let Some(dir) = exe.parent() {
			candidates.push(dir.join(&sidecar_name));
			#[cfg(windows)]
			candidates.push(dir.join("ffmpeg.exe"));
			#[cfg(not(windows))]
			candidates.push(dir.join("ffmpeg"));
		}
	}

	// 2) Resource / binaries folders
	if let Ok(resource) = app.path().resource_dir() {
		candidates.push(resource.join(&sidecar_name));
		candidates.push(resource.join("binaries").join(&sidecar_name));
	}

	// 3) Dev checkout: src-tauri/binaries (when not yet copied beside exe)
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

	// 4) System install (optional convenience)
	if let Ok(path) = which::which("ffmpeg") {
		return Ok(path);
	}

	Err(format!(
		"Bundled FFmpeg was not found ({sidecar_name}).\nRun: pnpm ffmpeg:download\nThen restart the app."
	))
}

pub(crate) fn ffmpeg_path_arg(path: &Path) -> String {
	path.to_string_lossy().replace('\\', "/")
}

pub(crate) fn ffmpeg_fail_message(status: &std::process::Output) -> String {
	let stderr = String::from_utf8_lossy(&status.stderr);
	let hint = stderr
		.lines()
		.rev()
		.take(10)
		.collect::<Vec<_>>()
		.into_iter()
		.rev()
		.collect::<Vec<_>>()
		.join("\n");
	format!(
		"FFmpeg export failed (exit {}).\n{}",
		status.status.code().unwrap_or(-1),
		hint
	)
}

fn require_video_path(video_path: &Option<String>) -> Result<PathBuf, String> {
	let video_path = video_path
		.as_ref()
		.map(|p| p.trim())
		.filter(|p| !p.is_empty())
		.ok_or_else(|| "Source video path is required for video export.".to_string())?;
	let video = PathBuf::from(video_path);
	if !video.is_file() {
		return Err(format!("Source video not found:\n{video_path}"));
	}
	Ok(video)
}

fn mux_soft_subtitles(
	app: &AppHandle,
	video_path: &Path,
	srt_path: &Path,
	output_path: &Path,
) -> Result<(), String> {
	let ffmpeg = find_ffmpeg(app)?;
	ensure_parent_dir(output_path)?;

	// Stream-copy A/V; convert SRT → MP4 mov_text soft track (no burn-in, no re-encode).
	let status = Command::new(&ffmpeg)
		.args([
			"-hide_banner",
			"-y",
			"-i",
			&ffmpeg_path_arg(video_path),
			"-i",
			&ffmpeg_path_arg(srt_path),
			"-map",
			"0:v:0",
			"-map",
			"0:a?",
			"-map",
			"1:0",
			"-c:v",
			"copy",
			"-c:a",
			"copy",
			"-c:s",
			"mov_text",
			"-metadata:s:s:0",
			"language=khm",
			"-metadata:s:s:0",
			"title=Khmer",
			"-disposition:s:0",
			"default",
			&ffmpeg_path_arg(output_path),
		])
		.output()
		.map_err(|e| format!("Failed to start FFmpeg: {e}"))?;

	if status.status.success() {
		return Ok(());
	}
	Err(ffmpeg_fail_message(&status))
}

/// Burn SRT into the picture (always visible — matches studio preview).
fn burn_in_subtitles(
	app: &AppHandle,
	video_path: &Path,
	srt_path: &Path,
	output_path: &Path,
) -> Result<(), String> {
	let ffmpeg = find_ffmpeg(app)?;
	ensure_parent_dir(output_path)?;

	// Windows drive letters (`C:`) break FFmpeg's filter option parser (`:` separators).
	// Run with cwd = SRT folder and pass a relative ASCII filename only.
	let srt_dir = srt_path
		.parent()
		.filter(|p| !p.as_os_str().is_empty())
		.map(|p| p.to_path_buf())
		.unwrap_or_else(|| PathBuf::from("."));
	let srt_name = srt_path
		.file_name()
		.and_then(|s| s.to_str())
		.ok_or_else(|| "Invalid subtitle temp path.".to_string())?;

	// Relative name only — no drive letter / absolute path in the filtergraph.
	let vf = format!(
		"subtitles={srt_name}:charenc=UTF-8:force_style='FontName=Khmer UI,FontSize=22,Outline=2,Shadow=1,Alignment=2,MarginV=40'"
	);

	let status = Command::new(&ffmpeg)
		.current_dir(&srt_dir)
		.args([
			"-hide_banner",
			"-y",
			"-i",
			&ffmpeg_path_arg(video_path),
			"-vf",
			&vf,
			"-c:v",
			"libx264",
			"-preset",
			"fast",
			"-crf",
			"18",
			"-pix_fmt",
			"yuv420p",
			"-c:a",
			"copy",
			"-movflags",
			"+faststart",
			&ffmpeg_path_arg(output_path),
		])
		.output()
		.map_err(|e| format!("Failed to start FFmpeg: {e}"))?;

	if status.status.success() {
		return Ok(());
	}
	Err(ffmpeg_fail_message(&status))
}

fn export_temp_dir(app: &AppHandle) -> Result<PathBuf, String> {
	let dir = app
		.path()
		.temp_dir()
		.map_err(|e| format!("Could not resolve temp dir: {e}"))?
		.join("professor-dubbed-pro-export");
	fs::create_dir_all(&dir).map_err(|e| format!("Could not create temp dir: {e}"))?;
	Ok(dir)
}

fn safe_file_name(file_name: &str) -> &str {
	Path::new(file_name)
		.file_name()
		.and_then(|s| s.to_str())
		.filter(|s| !s.is_empty())
		.unwrap_or("staged.bin")
}

/// Create an empty staging file; frontend appends chunks (avoids huge IPC payloads).
#[tauri::command]
pub fn begin_staged_file(app: AppHandle, file_name: String) -> Result<String, String> {
	let dir = export_temp_dir(&app)?;
	let stamp = std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.map(|d| d.as_millis())
		.unwrap_or(0);
	let path = dir.join(format!("{}-{}", stamp, safe_file_name(&file_name)));
	fs::File::create(&path).map_err(|e| format!("Failed to create staging file: {e}"))?;
	Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn append_staged_file(path: String, chunk: Vec<u8>) -> Result<(), String> {
	let p = PathBuf::from(&path);
	if !p.starts_with(std::env::temp_dir().join("professor-dubbed-pro-export"))
		&& !p.to_string_lossy().contains("professor-dubbed-pro-export")
	{
		// Soft guard — only allow writes under our export staging folder name.
		if !p
			.to_string_lossy()
			.replace('\\', "/")
			.contains("/professor-dubbed-pro-export/")
		{
			return Err("Invalid staging path.".into());
		}
	}

	let mut file = OpenOptions::new()
		.create(true)
		.append(true)
		.open(&p)
		.map_err(|e| format!("Failed to open staging file: {e}"))?;
	file
		.write_all(&chunk)
		.map_err(|e| format!("Failed to write staging chunk: {e}"))?;
	Ok(())
}

#[tauri::command]
pub fn cleanup_staged_file(path: String) -> Result<(), String> {
	let p = PathBuf::from(&path);
	if p.exists() {
		let _ = fs::remove_file(&p);
	}
	Ok(())
}

/// Export subtitles and/or mux soft subtitles into an MP4 via bundled/system FFmpeg.
#[tauri::command]
pub fn export_project(app: AppHandle, args: ExportProjectArgs) -> Result<ExportProjectResult, String> {
	if args.srt_content.trim().is_empty() {
		return Err("No subtitle cues to export. Add translation text first.".into());
	}

	let output = PathBuf::from(&args.output_path);
	if args.output_path.trim().is_empty() {
		return Err("Output path is required.".into());
	}

	match args.mode {
		ExportMode::Srt => {
			write_utf8_file(&output, &args.srt_content)?;
			Ok(ExportProjectResult {
				output_path: args.output_path,
				mode: "srt".into(),
			})
		}
		ExportMode::VideoSoftSubs | ExportMode::VideoBurnedIn => {
			let video = require_video_path(&args.video_path)?;

			// ASCII-only temp name avoids FFmpeg filter path issues with Unicode folders.
			let tmp_dir = export_temp_dir(&app)?;
			let srt_tmp = tmp_dir.join(format!(
				"subs-{}.srt",
				std::time::SystemTime::now()
					.duration_since(std::time::UNIX_EPOCH)
					.map(|d| d.as_millis())
					.unwrap_or(0)
			));
			write_utf8_file(&srt_tmp, &args.srt_content)?;

			let result = match args.mode {
				ExportMode::VideoSoftSubs => {
					let mux = mux_soft_subtitles(&app, &video, &srt_tmp, &output);
					// Also drop a companion .srt next to the MP4 — many players auto-load it.
					if mux.is_ok() {
						let external = output.with_extension("srt");
						let _ = write_utf8_file(&external, &args.srt_content);
					}
					mux.map(|_| "videoSoftSubs")
				}
				ExportMode::VideoBurnedIn => {
					burn_in_subtitles(&app, &video, &srt_tmp, &output).map(|_| "videoBurnedIn")
				}
				ExportMode::Srt => unreachable!(),
			};

			let _ = fs::remove_file(&srt_tmp);
			let mode = result?;

			Ok(ExportProjectResult {
				output_path: args.output_path,
				mode: mode.into(),
			})
		}
	}
}
