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
pub struct ExportDubClip {
	/// Absolute path to a generated TTS MP3 (or wav).
	pub path: String,
	/// Timeline start in milliseconds.
	pub start_ms: u64,
	/// Linear gain 0–1 (from cue volume %).
	#[serde(default = "default_clip_volume")]
	pub volume: f64,
	/// Clip length in ms (from TTS). Used so mix/pad isn’t cut short.
	#[serde(default)]
	pub duration_ms: Option<u64>,
}

fn default_clip_volume() -> f64 {
	0.8
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
	/// Original Audio fader (0 = muted in preview). Default 1.0 when omitted.
	#[serde(default)]
	pub original_audio_gain: Option<f64>,
	/// Generated TTS clips to mix onto the timeline (optional).
	#[serde(default)]
	pub dub_clips: Option<Vec<ExportDubClip>>,
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

fn clamp_gain(raw: f64) -> f64 {
	if !raw.is_finite() {
		return 1.0;
	}
	raw.clamp(0.0, 2.0)
}

fn needs_audio_remix(gain: f64, clips: &[ExportDubClip]) -> bool {
	!clips.is_empty() || (gain - 1.0).abs() > 0.02
}

fn parse_duration_ms_from_ffmpeg_log(log: &str) -> Option<u64> {
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

fn probe_media_duration_ms(ffmpeg: &Path, media: &Path) -> u64 {
	let output = Command::new(ffmpeg)
		.args(["-hide_banner", "-i", &ffmpeg_path_arg(media)])
		.output()
		.ok();
	output
		.and_then(|o| parse_duration_ms_from_ffmpeg_log(&String::from_utf8_lossy(&o.stderr)).map(|ms| ms))
		.unwrap_or(0)
}

/// Copy a Khmer-capable TTF next to the temp SRT so libass can shape syllables.
/// Prefers bundled Noto Sans Khmer (matches preview), then system Khmer UI.
/// Returns `(fonts_dir, ASS Fontname family)`.
fn prepare_khmer_fonts_dir(app: &AppHandle, work_dir: &Path) -> Result<(PathBuf, String), String> {
	let fonts = work_dir.join("fonts");
	fs::create_dir_all(&fonts).map_err(|e| format!("Could not create fonts dir: {e}"))?;

	let mut candidates: Vec<(PathBuf, &'static str)> = Vec::new();

	// Bundled Noto (preview parity) — checkout + packaged resources.
	candidates.push((
		PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/fonts/NotoSansKhmer-Regular.ttf"),
		"Noto Sans Khmer",
	));
	if let Ok(resource) = app.path().resource_dir() {
		candidates.push((
			resource.join("resources/fonts/NotoSansKhmer-Regular.ttf"),
			"Noto Sans Khmer",
		));
		candidates.push((
			resource.join("fonts/NotoSansKhmer-Regular.ttf"),
			"Noto Sans Khmer",
		));
	}
	if let Ok(exe) = std::env::current_exe() {
		if let Some(dir) = exe.parent() {
			candidates.push((
				dir.join("resources/fonts/NotoSansKhmer-Regular.ttf"),
				"Noto Sans Khmer",
			));
		}
	}

	#[cfg(windows)]
	{
		candidates.push((PathBuf::from(r"C:\Windows\Fonts\KhmerUI.ttf"), "Khmer UI"));
		candidates.push((PathBuf::from(r"C:\Windows\Fonts\KhmerUIb.ttf"), "Khmer UI"));
		candidates.push((PathBuf::from(r"C:\Windows\Fonts\LeelawUI.ttf"), "Leelawadee UI"));
		candidates.push((PathBuf::from(r"C:\Windows\Fonts\LEELAWAD.TTF"), "Leelawadee"));
	}
	#[cfg(not(windows))]
	{
		candidates.push((
			PathBuf::from("/usr/share/fonts/truetype/noto/NotoSansKhmer-Regular.ttf"),
			"Noto Sans Khmer",
		));
		candidates.push((
			PathBuf::from("/System/Library/Fonts/Supplemental/Khmer Sangam MN.ttc"),
			"Khmer Sangam MN",
		));
	}

	for (src, family) in &candidates {
		if !src.is_file() {
			continue;
		}
		// Always copy as a stable filename so libass finds it under fontsdir.
		let dest_name = if family.contains("Noto") {
			"NotoSansKhmer-Regular.ttf"
		} else {
			src.file_name()
				.and_then(|s| s.to_str())
				.unwrap_or("khmer.ttf")
		};
		let dest = fonts.join(dest_name);
		if !dest.is_file() {
			let _ = fs::copy(src, &dest);
		}
		if dest.is_file() {
			return Ok((fonts, (*family).to_string()));
		}
	}
	Ok((fonts, "Noto Sans Khmer".into()))
}

fn probe_video_size(ffmpeg: &Path, video: &Path) -> (u32, u32) {
	let output = Command::new(ffmpeg)
		.args(["-hide_banner", "-i", &ffmpeg_path_arg(video)])
		.output()
		.ok();
	let log = output
		.map(|o| String::from_utf8_lossy(&o.stderr).into_owned())
		.unwrap_or_default();
	// e.g. Stream #0:0: Video: h264, yuv420p, 576x768, ...
	for line in log.lines() {
		if !line.contains("Video:") {
			continue;
		}
		for token in line.split(',') {
			let t = token.trim();
			if let Some((w, rest)) = t.split_once('x') {
				if !w.chars().all(|c| c.is_ascii_digit()) {
					continue;
				}
				let h_token = rest
					.split(|c: char| !c.is_ascii_digit())
					.next()
					.unwrap_or("");
				if h_token.is_empty() {
					continue;
				}
				let width: u32 = w.parse().unwrap_or(0);
				let height: u32 = h_token.parse().unwrap_or(0);
				if width >= 16 && height >= 16 {
					return (width, height);
				}
			}
		}
	}
	(1280, 720)
}

/// Escape ASS dialogue text (keep Khmer grapheme clusters intact — no mid-syllable wraps).
fn escape_ass_text(text: &str) -> String {
	text.replace('\\', r"\\")
		.replace('{', r"\{")
		.replace('}', r"\}")
		.replace('\r', "")
		.replace('\n', r"\N")
}

fn srt_time_to_ass(ts: &str) -> Option<String> {
	// SRT: HH:MM:SS,mmm  → ASS: H:MM:SS.cc
	let ts = ts.trim().replace(',', ".");
	let parts: Vec<&str> = ts.split(':').collect();
	if parts.len() != 3 {
		return None;
	}
	let h: u32 = parts[0].parse().ok()?;
	let m: u32 = parts[1].parse().ok()?;
	let sec_parts: Vec<&str> = parts[2].split('.').collect();
	let s: u32 = sec_parts.first()?.parse().ok()?;
	let ms: u32 = sec_parts
		.get(1)
		.map(|f| {
			let padded = format!("{:0<3}", f.chars().take(3).collect::<String>());
			padded.parse::<u32>().unwrap_or(0)
		})
		.unwrap_or(0);
	let cs = ms / 10; // centiseconds
	Some(format!("{h}:{m:02}:{s:02}.{cs:02}"))
}

/// Convert SRT → ASS styled like the in-app preview (Noto + translucent box).
fn srt_to_preview_ass(
	srt: &str,
	font_family: &str,
	play_res_x: u32,
	play_res_y: u32,
) -> String {
	let family = font_family.replace(',', "");
	// Match preview: readable Khmer without dominating a 576-wide frame.
	let fontsize = ((play_res_y as f64) / 42.0).round().clamp(15.0, 22.0) as u32;
	let margin_v = ((play_res_y as f64) * 0.055).round().clamp(28.0, 64.0) as u32;
	let margin_h = ((play_res_x as f64) * 0.05).round().clamp(18.0, 48.0) as u32;
	// BorderStyle=3 opaque box; Outline ≈ padding. Alpha 0x64 ≈ 39% transparent black.
	let style = format!(
		"Style: Default,{family},{fontsize},&H00FFFFFF,&H000000FF,&H64000000,&H00000000,0,0,0,0,100,100,0,0,3,10,0,2,{margin_h},{margin_h},{margin_v},1"
	);

	let mut events = String::new();
	let normalized = srt.replace("\r\n", "\n");
	for block in normalized.split("\n\n") {
		let lines: Vec<&str> = block
			.lines()
			.map(|l| l.trim_end())
			.filter(|l| !l.is_empty())
			.collect();
		if lines.len() < 3 {
			continue;
		}
		// lines[0]=index, lines[1]=times, rest=text
		let time_line = lines[1];
		let Some((start_raw, end_raw)) = time_line.split_once("-->") else {
			continue;
		};
		let Some(start) = srt_time_to_ass(start_raw.trim()) else {
			continue;
		};
		let Some(end) = srt_time_to_ass(end_raw.trim()) else {
			continue;
		};
		let text = escape_ass_text(&lines[2..].join("\n"));
		if text.is_empty() {
			continue;
		}
		events.push_str(&format!("Dialogue: 0,{start},{end},Default,,0,0,0,,{text}\n"));
	}

	format!(
		"[Script Info]\n\
Title: ProfessorDubbedPro\n\
ScriptType: v4.00+\n\
WrapStyle: 0\n\
ScaledBorderAndShadow: yes\n\
PlayResX: {play_res_x}\n\
PlayResY: {play_res_y}\n\
\n\
[V4+ Styles]\n\
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n\
{style}\n\
\n\
[Events]\n\
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n\
{events}"
	)
}

/// libass burn-in filter using ASS (preview-matched box + Noto shaping).
fn burn_in_ass_filter(ass_name: &str, fonts_dir: &Path) -> String {
	let fonts_rel = fonts_dir
		.file_name()
		.and_then(|s| s.to_str())
		.unwrap_or("fonts");
	// `ass` filter uses libass with full shaping; fontsdir must be relative to cwd.
	format!("ass={ass_name}:fontsdir={fonts_rel}")
}

/// Write preview-styled ASS next to the temp SRT; returns (fonts_dir, ass_filename).
fn write_burn_in_ass(
	app: &AppHandle,
	ffmpeg: &Path,
	video_path: &Path,
	srt_path: &Path,
	srt_dir: &Path,
) -> Result<(PathBuf, String), String> {
	let srt = fs::read_to_string(srt_path).map_err(|e| format!("Could not read SRT: {e}"))?;
	let (fonts_dir, font_family) = prepare_khmer_fonts_dir(app, srt_dir)?;
	let (w, h) = probe_video_size(ffmpeg, video_path);
	let ass = srt_to_preview_ass(&srt, &font_family, w, h);
	let ass_path = srt_dir.join("burnin.ass");
	write_utf8_file(&ass_path, &ass)?;
	let ass_name = ass_path
		.file_name()
		.and_then(|s| s.to_str())
		.unwrap_or("burnin.ass")
		.to_string();
	Ok((fonts_dir, ass_name))
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

	let srt_dir = srt_path
		.parent()
		.filter(|p| !p.as_os_str().is_empty())
		.map(|p| p.to_path_buf())
		.unwrap_or_else(|| PathBuf::from("."));

	let (fonts_dir, ass_name) = write_burn_in_ass(app, &ffmpeg, video_path, srt_path, &srt_dir)?;
	let vf = burn_in_ass_filter(&ass_name, &fonts_dir);

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
			"medium",
			"-crf",
			"16",
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

fn dub_content_end_ms(clips: &[ExportDubClip], video_ms: u64) -> u64 {
	let mut end = video_ms;
	for clip in clips {
		let dur = clip.duration_ms.unwrap_or(2_500).max(200);
		end = end.max(clip.start_ms.saturating_add(dur));
	}
	end
}

/// Build filter chain piece for one dub clip (delay onto timeline, no early cutoff).
fn dub_clip_filter(input_index: usize, clip: &ExportDubClip, out_label: &str) -> Result<String, String> {
	let path = PathBuf::from(clip.path.trim());
	if !path.is_file() {
		return Err(format!("Dub audio not found:\n{}", clip.path));
	}
	let delay = clip.start_ms;
	let vol = clamp_gain(clip.volume);
	// adelay is per-channel ms; stereo needs delay|delay.
	Ok(format!(
		"[{input_index}:a]aformat=sample_rates=44100:channel_layouts=stereo,aresample=44100,adelay={delay}|{delay}:all=1,volume={vol:.4}[{out_label}]"
	))
}

/// Remix original audio (gain/mute) + TTS clips; optionally burn or soft-mux SRT.
fn export_video_with_audio_mix(
	app: &AppHandle,
	mode: &ExportMode,
	video_path: &Path,
	srt_path: &Path,
	output_path: &Path,
	original_gain: f64,
	clips: &[ExportDubClip],
) -> Result<(), String> {
	let ffmpeg = find_ffmpeg(app)?;
	ensure_parent_dir(output_path)?;
	let gain = clamp_gain(original_gain);

	for clip in clips {
		let p = PathBuf::from(clip.path.trim());
		if !p.is_file() {
			return Err(format!("Dub audio missing (generate TTS first):\n{}", clip.path));
		}
	}

	let srt_dir = srt_path
		.parent()
		.filter(|p| !p.as_os_str().is_empty())
		.map(|p| p.to_path_buf())
		.unwrap_or_else(|| PathBuf::from("."));

	let mut cmd = Command::new(&ffmpeg);
	cmd.current_dir(&srt_dir);
	cmd.args(["-hide_banner", "-y", "-i", &ffmpeg_path_arg(video_path)]);

	for clip in clips {
		cmd.args(["-i", &ffmpeg_path_arg(Path::new(clip.path.trim()))]);
	}

	// Soft-sub mode: SRT is an extra input for mov_text mux.
	let soft = matches!(mode, ExportMode::VideoSoftSubs);
	if soft {
		cmd.args(["-i", &ffmpeg_path_arg(srt_path)]);
	}

	let mut filters: Vec<String> = Vec::new();
	let mut mix_labels: Vec<String> = Vec::new();

	let video_ms = probe_media_duration_ms(&ffmpeg, video_path);
	let content_ms = dub_content_end_ms(clips, video_ms);
	let pad_ms = content_ms.saturating_sub(video_ms);
	let pad_sec = (pad_ms as f64) / 1000.0;

	// amix duration=longest pads shorter inputs; do not use bare apad (infinite).
	let content_sec = (content_ms as f64 / 1000.0).max(0.2);
	filters.push(format!(
		"[0:a]aformat=sample_rates=44100:channel_layouts=stereo,aresample=44100,apad=whole_dur={content_sec:.3},volume={gain:.4}[orig]"
	));
	mix_labels.push("orig".into());

	for (i, clip) in clips.iter().enumerate() {
		let in_idx = i + 1;
		let label = format!("d{i}");
		filters.push(dub_clip_filter(in_idx, clip, &label)?);
		mix_labels.push(label);
	}

	let mix_inputs = mix_labels
		.iter()
		.map(|l| format!("[{l}]"))
		.collect::<String>();
	let n = mix_labels.len();
	// longest keeps full TTS; dropout_transition softens clip edges (avoids choppy cuts).
	filters.push(format!(
		"{mix_inputs}amix=inputs={n}:duration=longest:dropout_transition=2:normalize=0[aout]"
	));

	let (fonts_dir, ass_name) = write_burn_in_ass(app, &ffmpeg, video_path, srt_path, &srt_dir)?;

	match mode {
		ExportMode::VideoBurnedIn => {
			let sub = burn_in_ass_filter(&ass_name, &fonts_dir);
			let vchain = if pad_sec > 0.05 {
				format!("[0:v]{sub},tpad=stop_mode=clone:stop_duration={pad_sec:.3}[vout]")
			} else {
				format!("[0:v]{sub}[vout]")
			};
			filters.insert(0, vchain);
			let fc = filters.join(";");
			cmd.args([
				"-filter_complex",
				&fc,
				"-map",
				"[vout]",
				"-map",
				"[aout]",
				"-c:v",
				"libx264",
				"-preset",
				"medium",
				"-crf",
				"16",
				"-pix_fmt",
				"yuv420p",
				"-c:a",
				"aac",
				"-b:a",
				"192k",
				"-movflags",
				"+faststart",
				&ffmpeg_path_arg(output_path),
			]);
		}
		ExportMode::VideoSoftSubs => {
			let vchain = if pad_sec > 0.05 {
				format!("[0:v]tpad=stop_mode=clone:stop_duration={pad_sec:.3}[vout]")
			} else {
				"[0:v]null[vout]".to_string()
			};
			filters.insert(0, vchain);
			let fc = filters.join(";");
			let srt_input_idx = 1 + clips.len();
			cmd.args([
				"-filter_complex",
				&fc,
				"-map",
				"[vout]",
				"-map",
				"[aout]",
				"-map",
				&format!("{srt_input_idx}:0"),
				"-c:v",
				"libx264",
				"-preset",
				"veryfast",
				"-crf",
				"20",
				"-pix_fmt",
				"yuv420p",
				"-c:a",
				"aac",
				"-b:a",
				"192k",
				"-c:s",
				"mov_text",
				"-metadata:s:s:0",
				"language=khm",
				"-metadata:s:s:0",
				"title=Khmer",
				"-disposition:s:0",
				"default",
				"-movflags",
				"+faststart",
				&ffmpeg_path_arg(output_path),
			]);
		}
		ExportMode::Srt => return Err("Internal: SRT mode has no audio mix.".into()),
	}

	let status = cmd
		.output()
		.map_err(|e| format!("Failed to start FFmpeg: {e}"))?;

	if status.status.success() {
		return Ok(());
	}
	// Older FFmpeg builds may not accept adelay `all=1` — retry without it.
	let err = ffmpeg_fail_message(&status);
	if err.contains("all") || err.to_lowercase().contains("adelay") {
		return export_video_with_audio_mix_legacy(
			app,
			mode,
			video_path,
			srt_path,
			output_path,
			original_gain,
			clips,
		);
	}
	Err(err)
}

/// Fallback mix without `adelay=...:all=1` for older FFmpeg sidecars.
fn export_video_with_audio_mix_legacy(
	app: &AppHandle,
	mode: &ExportMode,
	video_path: &Path,
	srt_path: &Path,
	output_path: &Path,
	original_gain: f64,
	clips: &[ExportDubClip],
) -> Result<(), String> {
	// Re-enter with filters that use classic adelay=ms|ms only by temporarily
	// rewriting clip filters via a local helper path: call the same structure
	// but force classic adelay through a patched copy of the command build.
	let ffmpeg = find_ffmpeg(app)?;
	ensure_parent_dir(output_path)?;
	let gain = clamp_gain(original_gain);
	let srt_dir = srt_path
		.parent()
		.filter(|p| !p.as_os_str().is_empty())
		.map(|p| p.to_path_buf())
		.unwrap_or_else(|| PathBuf::from("."));

	let mut cmd = Command::new(&ffmpeg);
	cmd.current_dir(&srt_dir);
	cmd.args(["-hide_banner", "-y", "-i", &ffmpeg_path_arg(video_path)]);
	for clip in clips {
		cmd.args(["-i", &ffmpeg_path_arg(Path::new(clip.path.trim()))]);
	}
	let soft = matches!(mode, ExportMode::VideoSoftSubs);
	if soft {
		cmd.args(["-i", &ffmpeg_path_arg(srt_path)]);
	}

	let video_ms = probe_media_duration_ms(&ffmpeg, video_path);
	let content_ms = dub_content_end_ms(clips, video_ms);
	let pad_sec = (content_ms.saturating_sub(video_ms) as f64) / 1000.0;

	let mut filters: Vec<String> = Vec::new();
	let content_sec = (content_ms as f64 / 1000.0).max(0.2);
	filters.push(format!(
		"[0:a]aformat=sample_rates=44100:channel_layouts=stereo,aresample=44100,apad=whole_dur={content_sec:.3},volume={gain:.4}[orig]"
	));
	let mut mix_labels = vec!["orig".to_string()];
	for (i, clip) in clips.iter().enumerate() {
		let label = format!("d{i}");
		let delay = clip.start_ms;
		let vol = clamp_gain(clip.volume);
		filters.push(format!(
			"[{}:a]aformat=sample_rates=44100:channel_layouts=stereo,aresample=44100,adelay={delay}|{delay},volume={vol:.4}[{label}]",
			i + 1
		));
		mix_labels.push(label);
	}
	let mix_inputs = mix_labels.iter().map(|l| format!("[{l}]")).collect::<String>();
	filters.push(format!(
		"{mix_inputs}amix=inputs={}:duration=longest:dropout_transition=2:normalize=0[aout]",
		mix_labels.len()
	));

	let (fonts_dir, ass_name) = write_burn_in_ass(app, &ffmpeg, video_path, srt_path, &srt_dir)?;
	match mode {
		ExportMode::VideoBurnedIn => {
			let sub = burn_in_ass_filter(&ass_name, &fonts_dir);
			let vchain = if pad_sec > 0.05 {
				format!("[0:v]{sub},tpad=stop_mode=clone:stop_duration={pad_sec:.3}[vout]")
			} else {
				format!("[0:v]{sub}[vout]")
			};
			filters.insert(0, vchain);
			let fc = filters.join(";");
			cmd.args([
				"-filter_complex",
				&fc,
				"-map",
				"[vout]",
				"-map",
				"[aout]",
				"-c:v",
				"libx264",
				"-preset",
				"medium",
				"-crf",
				"16",
				"-pix_fmt",
				"yuv420p",
				"-c:a",
				"aac",
				"-b:a",
				"192k",
				"-movflags",
				"+faststart",
				&ffmpeg_path_arg(output_path),
			]);
		}
		ExportMode::VideoSoftSubs => {
			let vchain = if pad_sec > 0.05 {
				format!("[0:v]tpad=stop_mode=clone:stop_duration={pad_sec:.3}[vout]")
			} else {
				"[0:v]null[vout]".to_string()
			};
			filters.insert(0, vchain);
			let fc = filters.join(";");
			let srt_input_idx = 1 + clips.len();
			cmd.args([
				"-filter_complex",
				&fc,
				"-map",
				"[vout]",
				"-map",
				"[aout]",
				"-map",
				&format!("{srt_input_idx}:0"),
				"-c:v",
				"libx264",
				"-preset",
				"veryfast",
				"-crf",
				"20",
				"-pix_fmt",
				"yuv420p",
				"-c:a",
				"aac",
				"-b:a",
				"192k",
				"-c:s",
				"mov_text",
				"-movflags",
				"+faststart",
				&ffmpeg_path_arg(output_path),
			]);
		}
		ExportMode::Srt => return Err("Internal: SRT mode has no audio mix.".into()),
	}

	let status = cmd
		.output()
		.map_err(|e| format!("Failed to start FFmpeg: {e}"))?;
	if status.status.success() {
		return Ok(());
	}
	Err(ffmpeg_fail_message(&status))
}

/// Duck/mute original only (no TTS clips) — lighter than full mix graph.
fn export_video_gain_only(
	app: &AppHandle,
	mode: &ExportMode,
	video_path: &Path,
	srt_path: &Path,
	output_path: &Path,
	original_gain: f64,
) -> Result<(), String> {
	let ffmpeg = find_ffmpeg(app)?;
	ensure_parent_dir(output_path)?;
	let gain = clamp_gain(original_gain);

	let srt_dir = srt_path
		.parent()
		.filter(|p| !p.as_os_str().is_empty())
		.map(|p| p.to_path_buf())
		.unwrap_or_else(|| PathBuf::from("."));

	let mut cmd = Command::new(&ffmpeg);
	cmd.current_dir(&srt_dir);
	cmd.args([
		"-hide_banner",
		"-y",
		"-i",
		&ffmpeg_path_arg(video_path),
	]);

	match mode {
		ExportMode::VideoBurnedIn => {
			let (fonts_dir, ass_name) =
				write_burn_in_ass(app, &ffmpeg, video_path, srt_path, &srt_dir)?;
			let vf = burn_in_ass_filter(&ass_name, &fonts_dir);
			cmd.args([
				"-vf",
				&vf,
				"-af",
				&format!("volume={gain:.4}"),
				"-c:v",
				"libx264",
				"-preset",
				"medium",
				"-crf",
				"16",
				"-pix_fmt",
				"yuv420p",
				"-c:a",
				"aac",
				"-b:a",
				"192k",
				"-movflags",
				"+faststart",
				&ffmpeg_path_arg(output_path),
			]);
		}
		ExportMode::VideoSoftSubs => {
			cmd.args(["-i", &ffmpeg_path_arg(srt_path)]);
			cmd.args([
				"-filter_complex",
				&format!(
					"[0:a]aformat=sample_rates=44100:channel_layouts=stereo,volume={gain:.4}[aout]"
				),
				"-map",
				"0:v:0",
				"-map",
				"[aout]",
				"-map",
				"1:0",
				"-c:v",
				"copy",
				"-c:a",
				"aac",
				"-b:a",
				"192k",
				"-c:s",
				"mov_text",
				"-metadata:s:s:0",
				"language=khm",
				"-metadata:s:s:0",
				"title=Khmer",
				"-disposition:s:0",
				"default",
				"-movflags",
				"+faststart",
				&ffmpeg_path_arg(output_path),
			]);
		}
		ExportMode::Srt => return Err("Internal: SRT mode has no audio gain.".into()),
	}

	let status = cmd
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
			let gain = clamp_gain(args.original_audio_gain.unwrap_or(1.0));
			let clips: Vec<ExportDubClip> = args.dub_clips.unwrap_or_default();

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

			let result = if needs_audio_remix(gain, &clips) {
				if clips.is_empty() {
					export_video_gain_only(&app, &args.mode, &video, &srt_tmp, &output, gain)
				} else {
					export_video_with_audio_mix(
						&app, &args.mode, &video, &srt_tmp, &output, gain, &clips,
					)
				}
				.map(|_| match args.mode {
					ExportMode::VideoSoftSubs => "videoSoftSubs",
					ExportMode::VideoBurnedIn => "videoBurnedIn",
					ExportMode::Srt => unreachable!(),
				})
			} else {
				match args.mode {
					ExportMode::VideoSoftSubs => {
						let mux = mux_soft_subtitles(&app, &video, &srt_tmp, &output);
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
				}
			};

			// Companion SRT next to remixed MP4 as well.
			if result.is_ok() {
				let external = output.with_extension("srt");
				let _ = write_utf8_file(&external, &args.srt_content);
			}

			let _ = fs::remove_file(&srt_tmp);
			let mode = result?;

			Ok(ExportProjectResult {
				output_path: args.output_path,
				mode: mode.into(),
			})
		}
	}
}
