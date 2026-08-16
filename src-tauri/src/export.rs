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
	/// Play-through length in ms after tempo. Used so mix/pad isn’t cut short.
	#[serde(default)]
	pub duration_ms: Option<u64>,
	/// Align / fit tempo (FFmpeg atempo). 1.0 = natural speed.
	#[serde(default = "default_playback_rate")]
	pub playback_rate: f64,
}

fn default_clip_volume() -> f64 {
	0.8
}

fn default_playback_rate() -> f64 {
	1.0
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSubtitleStyle {
	/// ASS / CSS font family.
	#[serde(default = "default_font_family")]
	pub font_family: String,
	/// Absolute path to TTF/OTF when known.
	#[serde(default)]
	pub font_file: Option<String>,
	/// Design font size in px as if picture were 720px tall.
	#[serde(default = "default_font_size_px")]
	pub font_size_px: f64,
	/// Anchor X 0–1.
	#[serde(default = "default_style_x")]
	pub x: f64,
	/// Anchor Y 0–1.
	#[serde(default = "default_style_y")]
	pub y: f64,
	/// `outline` | `box`
	#[serde(default = "default_look")]
	pub look: String,
	/// Max text width as fraction of frame width.
	#[serde(default = "default_max_width_pct")]
	pub max_width_pct: f64,
	/// Black outline thickness in design px (at 720p tall).
	#[serde(default = "default_outline_width")]
	pub outline_width: f64,
}

fn default_font_family() -> String {
	"Noto Sans Khmer".into()
}
fn default_font_size_px() -> f64 {
	20.0
}
fn default_style_x() -> f64 {
	0.5
}
fn default_style_y() -> f64 {
	0.84
}
fn default_look() -> String {
	"outline".into()
}
fn default_max_width_pct() -> f64 {
	0.96
}
fn default_outline_width() -> f64 {
	1.0
}

impl Default for ExportSubtitleStyle {
	fn default() -> Self {
		Self {
			font_family: default_font_family(),
			font_file: None,
			font_size_px: default_font_size_px(),
			x: default_style_x(),
			y: default_style_y(),
			look: default_look(),
			max_width_pct: default_max_width_pct(),
			outline_width: default_outline_width(),
		}
	}
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
	/// Preview-matched burn-in look (font / size / position).
	#[serde(default)]
	pub subtitle_style: Option<ExportSubtitleStyle>,
	/// Title Liver / live title clips to burn in (video burned-in mode).
	#[serde(default)]
	pub title_liver_clips: Option<Vec<ExportTitleLiverClip>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportTitleLiverClip {
	/// Full-frame transparent PNG (preview-matched graphic), absolute path.
	pub png_path: String,
	pub start_ms: u64,
	pub end_ms: u64,
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

/// Escape ASS dialogue text (keep Khmer grapheme clusters intact).
fn escape_ass_text(text: &str) -> String {
	text.replace('\\', r"\\")
		.replace('{', r"\{")
		.replace('}', r"\}")
		.replace('\r', "")
		.replace('\n', r"\N")
}

fn is_khmer_base(c: char) -> bool {
	let u = c as u32;
	(0x1780..=0x17B3).contains(&u)
}

fn is_khmer_coeng(c: char) -> bool {
	c == '\u{17D2}'
}

/// Dependent vowels, signs, and other marks that must stay with the syllable.
fn is_khmer_mark(c: char) -> bool {
	let u = c as u32;
	(0x17B4..=0x17D1).contains(&u)
		|| (0x17D3..=0x17DD).contains(&u)
		|| c == '\u{200C}'
		|| c == '\u{200D}'
}

/// Visual column weight for wrapping. Marks / coeng are 0; bases count as 1.
fn wrap_column_weight(c: char) -> usize {
	let u = c as u32;
	if is_khmer_base(c) {
		return 1;
	}
	if is_khmer_coeng(c) || is_khmer_mark(c) {
		return 0;
	}
	if c.is_ascii_alphanumeric() || c.is_whitespace() {
		return 1;
	}
	if (0x4E00..=0x9FFF).contains(&u) {
		return 1;
	}
	if (0x0300..=0x036F).contains(&u) {
		return 0;
	}
	1
}

fn unit_column_weight(unit: &str) -> usize {
	unit.chars().map(wrap_column_weight).sum::<usize>().max(if unit.is_empty() { 0 } else { 1 })
}

/// Split into unbreakable wrap units (Khmer phonetic syllables stay whole).
///
/// Includes an optional final consonant (coda): e.g. ទាំង stays one unit, not ទាំ|ង.
fn wrap_units(text: &str) -> Vec<String> {
	let chars: Vec<char> = text.chars().collect();
	let mut units: Vec<String> = Vec::new();
	let mut i = 0usize;
	while i < chars.len() {
		let c = chars[i];

		// Spaces / ASCII punctuation: break opportunity after.
		if c.is_whitespace() {
			units.push(c.to_string());
			i += 1;
			continue;
		}

		// Khmer phonetic syllable:
		//   base (+ coeng + base)* + marks* + optional coda consonant
		// Coda = following base that is NOT itself followed by coeng or marks
		// (those start the next syllable, e.g. យ in យ៉ាង).
		if is_khmer_base(c) {
			let start = i;
			i += 1;
			loop {
				if i < chars.len() && is_khmer_coeng(chars[i]) {
					i += 1;
					if i < chars.len() && is_khmer_base(chars[i]) {
						i += 1;
					}
					continue;
				}
				if i < chars.len() && is_khmer_mark(chars[i]) {
					i += 1;
					continue;
				}
				break;
			}
			// Optional final consonant (coda) — keeps ទាំង / អ្នក intact.
			if i < chars.len() && is_khmer_base(chars[i]) {
				let after = chars.get(i + 1).copied();
				let starts_next_syllable = after
					.map(|n| is_khmer_coeng(n) || is_khmer_mark(n))
					.unwrap_or(false);
				if !starts_next_syllable {
					i += 1;
				}
			}
			units.push(chars[start..i].iter().collect());
			continue;
		}

		// Orphan coeng + following base (malformed but keep together)
		if is_khmer_coeng(c) {
			let start = i;
			i += 1;
			if i < chars.len() && is_khmer_base(chars[i]) {
				i += 1;
				while i < chars.len() && is_khmer_mark(chars[i]) {
					i += 1;
				}
				if i < chars.len() && is_khmer_base(chars[i]) {
					let after = chars.get(i + 1).copied();
					let starts_next_syllable = after
						.map(|n| is_khmer_coeng(n) || is_khmer_mark(n))
						.unwrap_or(false);
					if !starts_next_syllable {
						i += 1;
					}
				}
			}
			units.push(chars[start..i].iter().collect());
			continue;
		}

		// Standalone mark — glue to previous unit when possible
		if is_khmer_mark(c) || wrap_column_weight(c) == 0 {
			if let Some(prev) = units.last_mut() {
				prev.push(c);
			} else {
				units.push(c.to_string());
			}
			i += 1;
			continue;
		}

		// Latin / other: keep runs of non-space together
		let start = i;
		i += 1;
		while i < chars.len() {
			let n = chars[i];
			if n.is_whitespace() || is_khmer_base(n) || is_khmer_coeng(n) {
				break;
			}
			if wrap_column_weight(n) == 0 {
				i += 1;
				continue;
			}
			if n.is_ascii_alphanumeric() && chars[start].is_ascii_alphanumeric() {
				i += 1;
				continue;
			}
			if n.is_ascii_alphanumeric() {
				break;
			}
			i += 1;
		}
		units.push(chars[start..i].iter().collect());
	}
	merge_sticky_onsets(units)
}

/// Glue a lone consonant onto the next Khmer cluster (ប + ន្តិច → បន្តិច).
fn merge_sticky_onsets(units: Vec<String>) -> Vec<String> {
	let mut out: Vec<String> = Vec::new();
	let mut i = 0usize;
	while i < units.len() {
		let u = &units[i];
		let bare = {
			let mut ch = u.chars();
			matches!(ch.next(), Some(c) if is_khmer_base(c)) && ch.next().is_none()
		};
		if bare {
			if let Some(next) = units.get(i + 1) {
				if next.chars().next().map(is_khmer_base).unwrap_or(false) {
					out.push(format!("{u}{next}"));
					i += 2;
					continue;
				}
			}
		}
		out.push(u.clone());
		i += 1;
	}
	out
}

/// Soft-wrap to preview box width without splitting Khmer syllables.
fn soft_wrap_to_width(text: &str, max_cols: usize) -> String {
	let max_cols = max_cols.max(6);
	let mut out: Vec<String> = Vec::new();
	for paragraph in text.split('\n') {
		let paragraph = paragraph.trim_end();
		if paragraph.is_empty() {
			continue;
		}
		let mut line = String::new();
		let mut cols = 0usize;
		for unit in wrap_units(paragraph) {
			let w = unit_column_weight(&unit);
			let is_space = unit.chars().all(|c| c.is_whitespace());
			if !is_space && cols + w > max_cols && !line.is_empty() {
				// Drop trailing spaces on the finished line
				out.push(line.trim_end().to_string());
				line.clear();
				cols = 0;
			}
			if is_space && line.is_empty() {
				continue; // no leading spaces on a wrapped line
			}
			line.push_str(&unit);
			cols += w;
		}
		if !line.is_empty() {
			out.push(line.trim_end().to_string());
		}
	}
	if out.is_empty() {
		return String::new();
	}
	out.join("\n")
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

/// Prepare fontsdir: prefer the user's selected font file, else resolve by family,
/// else bundled Noto. Returns `(fonts_dir, ASS Fontname)` matching a file in fontsdir.
fn prepare_subtitle_fonts_dir(
	app: &AppHandle,
	work_dir: &Path,
	style: &ExportSubtitleStyle,
) -> Result<(PathBuf, String), String> {
	// Always stage bundled/system Khmer as fallback so shaping never dies.
	let (fonts, noto_family) = prepare_khmer_fonts_dir(app, work_dir)?;

	let requested = style.font_family.trim();
	let requested = if requested.is_empty() {
		"Noto Sans Khmer"
	} else {
		requested
	};

	let mut user_src: Option<PathBuf> = None;
	if let Some(file) = style
		.font_file
		.as_ref()
		.map(|s| s.trim())
		.filter(|s| !s.is_empty())
	{
		let p = PathBuf::from(file);
		if p.is_file() {
			user_src = Some(p);
		}
	}
	if user_src.is_none() {
		user_src = crate::fonts::find_system_font_path(requested);
	}

	if let Some(src) = user_src {
		let ext = src
			.extension()
			.and_then(|e| e.to_str())
			.map(|e| e.to_ascii_lowercase())
			.unwrap_or_default();
		if matches!(ext.as_str(), "ttf" | "otf") {
			let dest_name = src
				.file_name()
				.and_then(|s| s.to_str())
				.unwrap_or("user-font.ttf");
			let dest = fonts.join(dest_name);
			let _ = fs::copy(&src, &dest);
			if dest.is_file() {
				// ASS Fontname must match the font's real name table, not the picker label.
				let family = crate::fonts::read_font_family_name(&dest)
					.or_else(|| crate::fonts::read_font_family_name(&src))
					.unwrap_or_else(|| requested.to_string());
				return Ok((fonts, family));
			}
		}
	}

	Ok((fonts, noto_family))
}

/// Convert SRT → ASS matching preview width / size / position.
fn srt_to_preview_ass(
	srt: &str,
	style: &ExportSubtitleStyle,
	video_w: u32,
	video_h: u32,
) -> String {
	let family = style.font_family.replace(',', "").trim().to_string();
	let family = if family.is_empty() {
		"Noto Sans Khmer".to_string()
	} else {
		family
	};

	let play_res_x = video_w.max(16);
	let play_res_y = video_h.max(16);
	let scale = (play_res_y as f64) / 720.0;

	let size_px = if style.font_size_px.is_finite() {
		style.font_size_px.clamp(12.0, 72.0)
	} else {
		20.0
	};
	let fontsize = (size_px * scale).round().clamp(12.0, 160.0) as u32;

	let x = if style.x.is_finite() {
		style.x.clamp(0.05, 0.95)
	} else {
		0.5
	};
	let y = if style.y.is_finite() {
		style.y.clamp(0.05, 0.97)
	} else {
		0.88
	};
	// Lower third: TOP of Khmer pinned (grows down under CN/EN hardsubs).
	// Always use \pos — MarginV-only placement drifted from the preview pin.
	let (an, y_use) = if y >= 0.55 {
		(8u32, y.clamp(0.55, 0.96))
	} else if y <= 0.45 {
		(8u32, y.clamp(0.03, 0.45))
	} else {
		(5u32, y)
	};

	let max_w = if style.max_width_pct.is_finite() {
		style.max_width_pct.clamp(0.2, 0.98)
	} else {
		0.96
	};
	// Preview box width → ASS margins (libass wraps with real glyph advances).
	let side_margin = (((1.0 - max_w) * 0.5) * play_res_x as f64)
		.round()
		.clamp(0.0, play_res_x as f64 * 0.4) as i64;

	let outline = if style.outline_width.is_finite() {
		style.outline_width.clamp(0.0, 4.0)
	} else {
		1.0
	};
	let outline = (outline * scale)
		.min((fontsize as f64) * 0.06)
		.clamp(0.0, 12.0);

	let look = style.look.trim().to_ascii_lowercase();
	let pos_x = ((x * play_res_x as f64).round() as i64).clamp(0, play_res_x as i64);
	let pos_y = ((y_use * play_res_y as f64).round() as i64).clamp(0, play_res_y as i64);

	let style_line = if look == "box" {
		format!(
			"Style: Default,{family},{fontsize},&H00FFFFFF,&H000000FF,&H64000000,&H00000000,0,0,0,0,100,100,0,0,3,0,0,{an},{side_margin},{side_margin},0,1"
		)
	} else {
		format!(
			"Style: Default,{family},{fontsize},&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,{outline:.2},0,{an},{side_margin},{side_margin},0,1"
		)
	};

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
		let raw = lines[2..].join("\n");
		if raw.trim().is_empty() {
			continue;
		}
		// Frontend burn-in path pre-wraps with the same font metrics as the preview
		// and inserts hard newlines. Re-wrapping here would break syllables differently.
		// Fall back to column wrap only when the cue is still a single line.
		let wrapped = if raw.contains('\n') {
			raw.lines()
				.map(|l| l.trim_end())
				.filter(|l| !l.is_empty())
				.collect::<Vec<_>>()
				.join("\n")
		} else {
			const CHAR_EM: f64 = 0.55;
			let max_cols = ((max_w * play_res_x as f64) / (fontsize as f64 * CHAR_EM))
				.floor()
				.clamp(8.0, 220.0) as usize;
			soft_wrap_to_width(&raw, max_cols)
		};
		let text = escape_ass_text(&wrapped);
		if text.is_empty() {
			continue;
		}
		// Explicit pin + pre-wrapped lines (\q2 = no further auto-wrap).
		events.push_str(&format!(
			"Dialogue: 0,{start},{end},Default,,0,0,0,,{{\\an{an}\\pos({pos_x},{pos_y})\\q2}}{text}\n"
		));
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
{style_line}\n\
\n\
[Events]\n\
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n\
{events}"
	)
}

/// Escape a filesystem path for an FFmpeg filtergraph option value.
fn ffmpeg_filter_path(path: &Path) -> String {
	path.to_string_lossy()
		.replace('\\', "/")
		.replace(':', "\\:")
		.replace('\'', "\\'")
		.replace('[', "\\[")
		.replace(']', "\\]")
}

/// libass burn-in filter — absolute fontsdir is required on Windows or Khmer
/// falls back to a Latin font and shaping breaks (preview still looks fine).
fn burn_in_ass_filter(ass_path: &Path, fonts_dir: &Path) -> String {
	let ass = ffmpeg_filter_path(ass_path);
	let fonts = ffmpeg_filter_path(fonts_dir);
	format!("ass='{ass}':fontsdir='{fonts}'")
}

/// Write preview-styled ASS next to the temp SRT; returns (fonts_dir, ass_path).
fn write_burn_in_ass(
	app: &AppHandle,
	ffmpeg: &Path,
	video_path: &Path,
	srt_path: &Path,
	srt_dir: &Path,
	style: &ExportSubtitleStyle,
) -> Result<(PathBuf, PathBuf), String> {
	let srt = fs::read_to_string(srt_path).map_err(|e| format!("Could not read SRT: {e}"))?;
	let (fonts_dir, family) = prepare_subtitle_fonts_dir(app, srt_dir, style)?;
	// Fontname MUST match the file actually in fontsdir (not the picker label alone).
	let mut style = style.clone();
	style.font_family = family;
	let (w, h) = probe_video_size(ffmpeg, video_path);
	// Title Liver is burned via PNG overlay (preview-matched), not ASS text.
	let ass = srt_to_preview_ass(&srt, &style, w, h);
	let ass_path = srt_dir.join("burnin.ass");
	write_utf8_file(&ass_path, &ass)?;
	Ok((fonts_dir, ass_path))
}

/// Copy Title Liver PNGs into `work` as short names for FFmpeg `movie=` filters.
fn stage_title_liver_pngs(
	work: &Path,
	clips: &[ExportTitleLiverClip],
) -> Result<Vec<(String, f64, f64)>, String> {
	let mut out = Vec::new();
	for (i, clip) in clips.iter().enumerate() {
		if clip.end_ms <= clip.start_ms {
			continue;
		}
		let src = PathBuf::from(&clip.png_path);
		if !src.is_file() {
			return Err(format!("Title Liver PNG missing: {}", clip.png_path));
		}
		let name = format!("tl{i}.png");
		let dest = work.join(&name);
		fs::copy(&src, &dest).map_err(|e| format!("Could not stage Title Liver PNG: {e}"))?;
		out.push((
			name,
			clip.start_ms as f64 / 1000.0,
			clip.end_ms as f64 / 1000.0,
		));
	}
	Ok(out)
}

/// Append full-frame PNG overlays after `from_label` (no brackets). Returns final label.
fn title_liver_overlay_filters(
	from_label: &str,
	staged: &[(String, f64, f64)],
) -> (Vec<String>, String) {
	let mut filters = Vec::new();
	let mut cur = from_label.to_string();
	for (i, (name, start_s, end_s)) in staged.iter().enumerate() {
		let tl = format!("tl{i}");
		let next = format!("vtl{i}");
		filters.push(format!(
			"movie={name}:loop=0,format=rgba,setpts=PTS-STARTPTS[{tl}]"
		));
		filters.push(format!(
			"[{cur}][{tl}]overlay=0:0:format=auto:eof_action=pass:enable='between(t,{start_s:.3},{end_s:.3})'[{next}]"
		));
		cur = next;
	}
	(filters, cur)
}

/// Burn SRT into the picture (always visible — matches studio preview).
fn burn_in_subtitles(
	app: &AppHandle,
	video_path: &Path,
	srt_path: &Path,
	output_path: &Path,
	style: &ExportSubtitleStyle,
	title_liver: &[ExportTitleLiverClip],
) -> Result<(), String> {
	let ffmpeg = find_ffmpeg(app)?;
	ensure_parent_dir(output_path)?;

	let srt_dir = srt_path
		.parent()
		.filter(|p| !p.as_os_str().is_empty())
		.map(|p| p.to_path_buf())
		.unwrap_or_else(|| PathBuf::from("."));

	let (fonts_dir, ass_path) =
		write_burn_in_ass(app, &ffmpeg, video_path, srt_path, &srt_dir, style)?;
	let staged_tl = stage_title_liver_pngs(&srt_dir, title_liver)?;

	let status = if staged_tl.is_empty() {
		let vf = burn_in_ass_filter(&ass_path, &fonts_dir);
		Command::new(&ffmpeg)
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
			.map_err(|e| format!("Failed to start FFmpeg: {e}"))?
	} else {
		let sub = burn_in_ass_filter(&ass_path, &fonts_dir);
		let mut filters = vec![format!("[0:v]{sub}[vsub]")];
		let (more, final_label) = title_liver_overlay_filters("vsub", &staged_tl);
		filters.extend(more);
		if final_label != "vout" {
			filters.push(format!("[{final_label}]null[vout]"));
		}
		let fc = filters.join(";");
		let script = write_filter_complex_script(&srt_dir, &fc)?;
		Command::new(&ffmpeg)
			.current_dir(&srt_dir)
			.args([
				"-hide_banner",
				"-y",
				"-i",
				&ffmpeg_path_arg(video_path),
				"-filter_complex_script",
				&script,
				"-map",
				"[vout]",
				"-map",
				"0:a?",
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
			.map_err(|e| format!("Failed to start FFmpeg: {e}"))?
	};

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

/// Build FFmpeg atempo chain (each stage must be in 0.5..=2.0).
fn atempo_filter_chain(rate: f64) -> String {
	let mut r = rate;
	if !r.is_finite() || (r - 1.0).abs() < 0.001 {
		return String::new();
	}
	r = r.clamp(0.5, 2.5);
	let mut parts: Vec<String> = Vec::new();
	while r > 2.0 + 1e-6 {
		parts.push("atempo=2.0".into());
		r /= 2.0;
	}
	while r < 0.5 - 1e-6 {
		parts.push("atempo=0.5".into());
		r /= 0.5;
	}
	if (r - 1.0).abs() >= 0.001 {
		parts.push(format!("atempo={r:.4}"));
	}
	if parts.is_empty() {
		String::new()
	} else {
		format!(",{}", parts.join(","))
	}
}

/// Build filter chain piece for one dub clip (tempo → trim → delay onto timeline).
fn dub_clip_filter(input_index: usize, clip: &ExportDubClip, out_label: &str) -> Result<String, String> {
	let path = PathBuf::from(clip.path.trim());
	if !path.is_file() {
		return Err(format!("Dub audio not found:\n{}", clip.path));
	}
	let delay = clip.start_ms;
	let vol = clamp_gain(clip.volume);
	let tempo = atempo_filter_chain(clip.playback_rate);
	let trim = match clip.duration_ms {
		Some(ms) if ms > 0 => {
			let sec = (ms as f64) / 1000.0;
			format!(",atrim=0:{sec:.3},asetpts=PTS-STARTPTS")
		}
		_ => String::new(),
	};
	// adelay is per-channel ms; stereo needs delay|delay.
	Ok(format!(
		"[{input_index}:a]aformat=sample_rates=44100:channel_layouts=stereo,aresample=44100{tempo}{trim},adelay={delay}|{delay}:all=1,volume={vol:.4}[{out_label}]"
	))
}

fn dub_clip_filter_legacy(input_index: usize, clip: &ExportDubClip, out_label: &str) -> String {
	let delay = clip.start_ms;
	let vol = clamp_gain(clip.volume);
	let tempo = atempo_filter_chain(clip.playback_rate);
	let trim = match clip.duration_ms {
		Some(ms) if ms > 0 => {
			let sec = (ms as f64) / 1000.0;
			format!(",atrim=0:{sec:.3},asetpts=PTS-STARTPTS")
		}
		_ => String::new(),
	};
	format!(
		"[{input_index}:a]aformat=sample_rates=44100:channel_layouts=stereo,aresample=44100{tempo}{trim},adelay={delay}|{delay},volume={vol:.4}[{out_label}]"
	)
}

/// Hard-link or copy a TTS file to a short name (avoids Windows CreateProcess limit).
fn link_or_copy(src: &Path, dst: &Path) -> Result<(), String> {
	if dst.exists() {
		let _ = fs::remove_file(dst);
	}
	if fs::hard_link(src, dst).is_ok() {
		return Ok(());
	}
	fs::copy(src, dst)
		.map(|_| ())
		.map_err(|e| format!("Could not stage dub clip:\n{}\n{e}", src.display()))
}

/// Stage each dub clip as `d0.mp3`, `d1.mp3`, … under `work` for short `-i` args.
fn stage_dub_clips(work: &Path, clips: &[ExportDubClip]) -> Result<Vec<String>, String> {
	fs::create_dir_all(work).map_err(|e| format!("Could not create export mix dir: {e}"))?;
	let mut names = Vec::with_capacity(clips.len());
	for (i, clip) in clips.iter().enumerate() {
		let src = PathBuf::from(clip.path.trim());
		if !src.is_file() {
			return Err(format!("Dub audio missing (generate TTS first):\n{}", clip.path));
		}
		let ext = src
			.extension()
			.and_then(|e| e.to_str())
			.filter(|e| !e.is_empty())
			.unwrap_or("mp3");
		let name = format!("d{i}.{ext}");
		link_or_copy(&src, &work.join(&name))?;
		names.push(name);
	}
	Ok(names)
}

/// Write filtergraph to a file and return a path relative to `work` (cwd).
fn write_filter_complex_script(work: &Path, filter_complex: &str) -> Result<String, String> {
	let path = work.join("fc.txt");
	fs::write(&path, filter_complex)
		.map_err(|e| format!("Could not write FFmpeg filter script: {e}"))?;
	Ok("fc.txt".into())
}

fn mix_export_work_dir(app: &AppHandle) -> Result<PathBuf, String> {
	let stamp = std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.map(|d| d.as_millis())
		.unwrap_or(0);
	let dir = export_temp_dir(app)?.join(format!("mix-{stamp}"));
	fs::create_dir_all(&dir).map_err(|e| format!("Could not create mix work dir: {e}"))?;
	Ok(dir)
}

/// Remix original audio (gain/mute) + TTS clips; optionally burn or soft-mux SRT.
/// Stages clips to short paths and uses `-filter_complex_script` so Windows does not
/// hit CreateProcess error 206 (command line too long) with 50+ TTS inputs.
fn export_video_with_audio_mix(
	app: &AppHandle,
	mode: &ExportMode,
	video_path: &Path,
	srt_path: &Path,
	output_path: &Path,
	original_gain: f64,
	clips: &[ExportDubClip],
	style: &ExportSubtitleStyle,
	title_liver: &[ExportTitleLiverClip],
) -> Result<(), String> {
	export_video_with_audio_mix_inner(
		app,
		mode,
		video_path,
		srt_path,
		output_path,
		original_gain,
		clips,
		style,
		title_liver,
		true,
	)
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
	style: &ExportSubtitleStyle,
	title_liver: &[ExportTitleLiverClip],
) -> Result<(), String> {
	export_video_with_audio_mix_inner(
		app,
		mode,
		video_path,
		srt_path,
		output_path,
		original_gain,
		clips,
		style,
		title_liver,
		false,
	)
}

fn export_video_with_audio_mix_inner(
	app: &AppHandle,
	mode: &ExportMode,
	video_path: &Path,
	srt_path: &Path,
	output_path: &Path,
	original_gain: f64,
	clips: &[ExportDubClip],
	style: &ExportSubtitleStyle,
	title_liver: &[ExportTitleLiverClip],
	adelay_all: bool,
) -> Result<(), String> {
	let ffmpeg = find_ffmpeg(app)?;
	ensure_parent_dir(output_path)?;
	let gain = clamp_gain(original_gain);

	let work = mix_export_work_dir(app)?;
	let staged_names = stage_dub_clips(&work, clips)?;

	let srt_dir = srt_path
		.parent()
		.filter(|p| !p.as_os_str().is_empty())
		.map(|p| p.to_path_buf())
		.unwrap_or_else(|| PathBuf::from("."));

	// Run from the mix work dir so `-i d0.mp3` and `fc.txt` stay short on Windows.
	let mut cmd = Command::new(&ffmpeg);
	cmd.current_dir(&work);
	cmd.args(["-hide_banner", "-y", "-i", &ffmpeg_path_arg(video_path)]);
	for name in &staged_names {
		cmd.args(["-i", name]);
	}

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

	let content_sec = (content_ms as f64 / 1000.0).max(0.2);
	filters.push(format!(
		"[0:a]aformat=sample_rates=44100:channel_layouts=stereo,aresample=44100,apad=whole_dur={content_sec:.3},volume={gain:.4}[orig]"
	));
	mix_labels.push("orig".into());

	for (i, clip) in clips.iter().enumerate() {
		let in_idx = i + 1;
		let label = format!("d{i}");
		if adelay_all {
			filters.push(dub_clip_filter(in_idx, clip, &label)?);
		} else {
			filters.push(dub_clip_filter_legacy(in_idx, clip, &label));
		}
		mix_labels.push(label);
	}

	let mix_inputs = mix_labels
		.iter()
		.map(|l| format!("[{l}]"))
		.collect::<String>();
	let n = mix_labels.len();
	filters.push(format!(
		"{mix_inputs}amix=inputs={n}:duration=longest:dropout_transition=2:normalize=0[aout]"
	));

	let (fonts_dir, ass_path) =
		write_burn_in_ass(app, &ffmpeg, video_path, srt_path, &srt_dir, style)?;
	let staged_tl = stage_title_liver_pngs(&work, title_liver)?;

	match mode {
		ExportMode::VideoBurnedIn => {
			let sub = burn_in_ass_filter(&ass_path, &fonts_dir);
			let mut vfilters = vec![format!("[0:v]{sub}[vsub]")];
			let (more, vlabel) = title_liver_overlay_filters("vsub", &staged_tl);
			vfilters.extend(more);
			if pad_sec > 0.05 {
				vfilters.push(format!(
					"[{vlabel}]tpad=stop_mode=clone:stop_duration={pad_sec:.3}[vout]"
				));
			} else if vlabel != "vout" {
				vfilters.push(format!("[{vlabel}]null[vout]"));
			}
			for (i, f) in vfilters.into_iter().enumerate() {
				filters.insert(i, f);
			}
			let fc = filters.join(";");
			let script = write_filter_complex_script(&work, &fc)?;
			cmd.args([
				"-filter_complex_script",
				&script,
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
			let script = write_filter_complex_script(&work, &fc)?;
			let srt_input_idx = 1 + clips.len();
			cmd.args([
				"-filter_complex_script",
				&script,
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
				"-movflags",
				"+faststart",
				&ffmpeg_path_arg(output_path),
			]);
		}
		ExportMode::Srt => return Err("Internal: SRT mode in video mix.".into()),
	}

	let status = cmd
		.output()
		.map_err(|e| format!("Failed to start FFmpeg: {e}"))?;

	// Best-effort cleanup of staged clips (keep failures from masking FFmpeg errors).
	let _ = fs::remove_dir_all(&work);

	if status.status.success() {
		return Ok(());
	}
	let err = ffmpeg_fail_message(&status);
	if adelay_all && (err.contains("all") || err.to_lowercase().contains("adelay")) {
		return export_video_with_audio_mix_legacy(
			app,
			mode,
			video_path,
			srt_path,
			output_path,
			original_gain,
			clips,
			style,
			title_liver,
		);
	}
	Err(err)
}

/// Duck/mute original only (no TTS clips) — lighter than full mix graph.
fn export_video_gain_only(
	app: &AppHandle,
	mode: &ExportMode,
	video_path: &Path,
	srt_path: &Path,
	output_path: &Path,
	original_gain: f64,
	style: &ExportSubtitleStyle,
	title_liver: &[ExportTitleLiverClip],
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
			let (fonts_dir, ass_path) =
				write_burn_in_ass(app, &ffmpeg, video_path, srt_path, &srt_dir, style)?;
			let staged_tl = stage_title_liver_pngs(&srt_dir, title_liver)?;
			if staged_tl.is_empty() {
				let vf = burn_in_ass_filter(&ass_path, &fonts_dir);
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
			} else {
				let sub = burn_in_ass_filter(&ass_path, &fonts_dir);
				let mut filters = vec![
					format!("[0:v]{sub}[vsub]"),
					format!("[0:a]volume={gain:.4}[aout]"),
				];
				let (more, final_label) = title_liver_overlay_filters("vsub", &staged_tl);
				filters.extend(more);
				if final_label != "vout" {
					filters.push(format!("[{final_label}]null[vout]"));
				}
				let fc = filters.join(";");
				let script = write_filter_complex_script(&srt_dir, &fc)?;
				cmd.args([
					"-filter_complex_script",
					&script,
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

#[tauri::command]
pub fn probe_export_video_size(app: AppHandle, video_path: String) -> Result<(u32, u32), String> {
	let ffmpeg = find_ffmpeg(&app)?;
	Ok(probe_video_size(&ffmpeg, Path::new(&video_path)))
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
	if args.srt_content.trim().is_empty()
		&& args
			.title_liver_clips
			.as_ref()
			.map(|c| c.is_empty())
			.unwrap_or(true)
	{
		return Err("No subtitle cues or live titles to export.".into());
	}

	let output = PathBuf::from(&args.output_path);
	if args.output_path.trim().is_empty() {
		return Err("Output path is required.".into());
	}

	match args.mode {
		ExportMode::Srt => {
			if args.srt_content.trim().is_empty() {
				return Err("No subtitle cues to export. Add translation text first.".into());
			}
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
			let title_liver: Vec<ExportTitleLiverClip> = args.title_liver_clips.unwrap_or_default();

			// ASCII-only temp name avoids FFmpeg filter path issues with Unicode folders.
			let tmp_dir = export_temp_dir(&app)?;
			let srt_tmp = tmp_dir.join(format!(
				"subs-{}.srt",
				std::time::SystemTime::now()
					.duration_since(std::time::UNIX_EPOCH)
					.map(|d| d.as_millis())
					.unwrap_or(0)
			));
			let srt_body = if args.srt_content.trim().is_empty() {
				"1\n00:00:00,000 --> 00:00:00,040\n \n\n".to_string()
			} else {
				args.srt_content.clone()
			};
			write_utf8_file(&srt_tmp, &srt_body)?;

			let style = args.subtitle_style.clone().unwrap_or_default();

			let result = if needs_audio_remix(gain, &clips) {
				if clips.is_empty() {
					export_video_gain_only(
						&app, &args.mode, &video, &srt_tmp, &output, gain, &style, &title_liver,
					)
				} else {
					export_video_with_audio_mix(
						&app,
						&args.mode,
						&video,
						&srt_tmp,
						&output,
						gain,
						&clips,
						&style,
						&title_liver,
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
					ExportMode::VideoBurnedIn => burn_in_subtitles(
						&app, &video, &srt_tmp, &output, &style, &title_liver,
					)
					.map(|_| "videoBurnedIn"),
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

#[cfg(test)]
mod khmer_wrap_tests {
	use super::{soft_wrap_to_width, wrap_units};

	#[test]
	fn teang_stays_one_unit() {
		// ទាំង must not split before final ង
		let units = wrap_units("ទាំង");
		assert_eq!(units, vec!["ទាំង".to_string()]);
	}

	#[test]
	fn teang_not_split_across_lines() {
		let text = "អ្នកលក់ដែលពូកែនៅទូទាំងពិភពលោកមានលក្ខណៈពិសេសជារួមទាំងប្រាំយ៉ាង";
		// Force a wrap somewhere in the middle — no unit boundary may fall inside ទាំង
		for cols in 8..40 {
			let wrapped = soft_wrap_to_width(text, cols);
			assert!(
				!wrapped.contains("ទាំ\nង") && !wrapped.contains("ទាំ\\Nង"),
				"split ទាំង at max_cols={cols}: {wrapped:?}"
			);
			assert!(
				wrapped.replace('\n', "").contains("ទាំង"),
				"ទាំង missing after wrap at {cols}: {wrapped:?}"
			);
		}
	}

	#[test]
	fn next_syllable_with_marks_still_splits() {
		// ប្រាំ | យ៉ាង — យ is followed by mark ៉, so it starts a new syllable
		let units = wrap_units("ប្រាំយ៉ាង");
		assert!(units.len() >= 2, "{units:?}");
		assert_eq!(units[0], "ប្រាំ");
		assert!(units[1].starts_with('យ'), "{units:?}");
	}

	#[test]
	fn bantec_stays_one_unit() {
		// បន្តិច must not split as ប|ន្តិច
		let units = wrap_units("បន្តិច");
		assert_eq!(units, vec!["បន្តិច".to_string()], "{units:?}");
	}
}
