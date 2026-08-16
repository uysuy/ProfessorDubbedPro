//! Import media from a URL / channel query via yt-dlp, optional FFmpeg trim + hardsub OCR.
//!
//! Does not change the studio timeline model — downloads land as a normal video path
//! the existing project store can open.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

use crate::export::{ffmpeg_fail_message, ffmpeg_path_arg, find_ffmpeg};

static CANCEL: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkImportProgress {
	pub stage: String,
	pub message: String,
	pub percent: u32,
}

fn emit_progress(app: &AppHandle, stage: &str, message: &str, percent: u32) {
	let _ = app.emit(
		"link-import-progress",
		LinkImportProgress {
			stage: stage.into(),
			message: message.into(),
			percent: percent.min(100),
		},
	);
}

fn project_root() -> PathBuf {
	PathBuf::from(env!("CARGO_MANIFEST_DIR"))
		.parent()
		.map(|p| p.to_path_buf())
		.unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")))
}

fn ytdlp_sidecar_filename() -> String {
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
		format!("yt-dlp-{triple}.exe")
	}
	#[cfg(not(windows))]
	{
		format!("yt-dlp-{triple}")
	}
}

fn find_ytdlp(app: &AppHandle) -> Result<PathBuf, String> {
	let sidecar_name = ytdlp_sidecar_filename();
	let mut candidates: Vec<PathBuf> = Vec::new();

	if let Ok(exe) = std::env::current_exe() {
		if let Some(dir) = exe.parent() {
			candidates.push(dir.join(&sidecar_name));
			#[cfg(windows)]
			candidates.push(dir.join("yt-dlp.exe"));
			#[cfg(not(windows))]
			candidates.push(dir.join("yt-dlp"));
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

	if let Ok(path) = which::which("yt-dlp") {
		return Ok(path);
	}
	if let Ok(path) = which::which("yt-dlp.exe") {
		return Ok(path);
	}

	Err(format!(
		"yt-dlp was not found ({sidecar_name}).\nRun: pnpm ytdlp:download\nThen restart the app."
	))
}

fn find_ocr_script(app: &AppHandle) -> Result<PathBuf, String> {
	let mut candidates: Vec<PathBuf> = Vec::new();
	candidates.push(project_root().join("scripts").join("ocr").join("hardsub_ocr.py"));
	if let Ok(resource) = app.path().resource_dir() {
		candidates.push(resource.join("scripts").join("ocr").join("hardsub_ocr.py"));
	}
	for p in &candidates {
		if p.is_file() {
			return Ok(p.clone());
		}
	}
	Err("Hardsub OCR script not found (scripts/ocr/hardsub_ocr.py).".into())
}

fn find_ocr_python() -> Result<PathBuf, String> {
	if let Ok(custom) = std::env::var("PDP_OCR_PYTHON") {
		let p = PathBuf::from(custom.trim());
		if p.is_file() {
			return Ok(p);
		}
	}
	let root = project_root();
	#[cfg(windows)]
	let venv_py = root.join(".venv-ocr").join("Scripts").join("python.exe");
	#[cfg(not(windows))]
	let venv_py = root.join(".venv-ocr").join("bin").join("python");
	if venv_py.is_file() {
		return Ok(venv_py);
	}
	// Reuse FunASR venv if RapidOCR was installed there accidentally.
	#[cfg(windows)]
	let funasr_py = root.join(".venv-funasr").join("Scripts").join("python.exe");
	#[cfg(not(windows))]
	let funasr_py = root.join(".venv-funasr").join("bin").join("python");
	if funasr_py.is_file() {
		return Ok(funasr_py);
	}
	#[cfg(windows)]
	{
		if let Ok(path) = which::which("py") {
			return Ok(path);
		}
	}
	if let Ok(path) = which::which("python3") {
		return Ok(path);
	}
	if let Ok(path) = which::which("python") {
		return Ok(path);
	}
	Err("OCR Python not found.\nRun: pnpm ocr:setup".into())
}

fn imports_dir(app: &AppHandle) -> Result<PathBuf, String> {
	let base = app
		.path()
		.app_local_data_dir()
		.map_err(|e| format!("Could not resolve app data dir: {e}"))?;
	let dir = base.join("imports");
	fs::create_dir_all(&dir).map_err(|e| format!("Could not create imports dir: {e}"))?;
	Ok(dir)
}

fn now_stamp() -> String {
	let ms = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map(|d| d.as_millis())
		.unwrap_or(0);
	format!("{ms}")
}

fn sanitize_filename(raw: &str) -> String {
	let mut out = String::with_capacity(raw.len());
	for ch in raw.chars() {
		if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.' {
			out.push(ch);
		} else if ch.is_whitespace() {
			out.push('_');
		}
	}
	let trimmed = out.trim_matches('_').trim_matches('.');
	if trimmed.is_empty() {
		"video".into()
	} else {
		trimmed.chars().take(80).collect()
	}
}

/// Detect site / normalize user paste into a yt-dlp-friendly URL or query.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedInput {
	pub kind: String,
	pub site: String,
	pub query: String,
	pub display: String,
}

fn host_of(url: &url_like::UrlLike) -> String {
	url.host().unwrap_or("unknown").to_lowercase()
}

mod url_like {
	//! Tiny URL peek without adding a dependency.
	pub struct UrlLike<'a> {
		raw: &'a str,
	}
	impl<'a> UrlLike<'a> {
		pub fn parse(s: &'a str) -> Option<Self> {
			let t = s.trim();
			if t.starts_with("http://") || t.starts_with("https://") {
				Some(Self { raw: t })
			} else {
				None
			}
		}
		pub fn host(&self) -> Option<&str> {
			let rest = self
				.raw
				.strip_prefix("https://")
				.or_else(|| self.raw.strip_prefix("http://"))?;
			let host = rest.split('/').next()?.split('?').next()?.split(':').next()?;
			if host.is_empty() {
				None
			} else {
				Some(host)
			}
		}
	}
}

fn classify_site(host: &str) -> &'static str {
	let h = host.trim_start_matches("www.").trim_start_matches("m.");
	if h.contains("youtube.com") || h == "youtu.be" {
		"youtube"
	} else if h.contains("bilibili.com") || h.contains("b23.tv") {
		"bilibili"
	} else if h.contains("douyin.com") || h.contains("tiktok.com") {
		"short_video"
	} else if h.contains("vimeo.com") {
		"vimeo"
	} else if h.contains("twitter.com") || h.contains("x.com") {
		"twitter"
	} else {
		"other"
	}
}

fn normalize_user_input(raw: &str) -> ResolvedInput {
	let trimmed = raw.trim();
	if let Some(u) = url_like::UrlLike::parse(trimmed) {
		let host = host_of(&u);
		let site = classify_site(&host).to_string();
		let lower = trimmed.to_lowercase();
		let kind = if lower.contains("/channel/")
			|| lower.contains("/c/")
			|| lower.contains("/@")
			|| lower.contains("/user/")
			|| lower.contains("/playlist")
			|| lower.contains("list=")
		{
			"channel_or_playlist"
		} else {
			"video"
		};
		return ResolvedInput {
			kind: kind.into(),
			site,
			query: trimmed.to_string(),
			display: trimmed.to_string(),
		};
	}

	// Bare YouTube id
	if trimmed.len() == 11
		&& trimmed
			.chars()
			.all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
	{
		let url = format!("https://www.youtube.com/watch?v={trimmed}");
		return ResolvedInput {
			kind: "video".into(),
			site: "youtube".into(),
			query: url.clone(),
			display: url,
		};
	}

	// Channel / search name → ytsearch
	let q = format!("ytsearch10:{trimmed}");
	ResolvedInput {
		kind: "search".into(),
		site: "youtube".into(),
		query: q,
		display: trimmed.to_string(),
	}
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaCandidate {
	pub id: String,
	pub title: String,
	pub duration_s: Option<f64>,
	pub webpage_url: String,
	pub thumbnail: Option<String>,
	pub uploader: Option<String>,
	pub site: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveResult {
	pub input: ResolvedInput,
	pub entries: Vec<MediaCandidate>,
}

fn json_str(v: &serde_json::Value, keys: &[&str]) -> Option<String> {
	for k in keys {
		if let Some(s) = v.get(*k).and_then(|x| x.as_str()) {
			let t = s.trim();
			if !t.is_empty() {
				return Some(t.to_string());
			}
		}
	}
	None
}

fn candidate_from_json(v: &serde_json::Value, fallback_site: &str) -> Option<MediaCandidate> {
	let id = json_str(v, &["id"]).unwrap_or_else(|| "unknown".into());
	let title = json_str(v, &["title", "fulltitle"]).unwrap_or_else(|| id.clone());
	let webpage_url = json_str(v, &["webpage_url", "url", "original_url"])?;
	let duration_s = v
		.get("duration")
		.and_then(|d| d.as_f64().or_else(|| d.as_u64().map(|u| u as f64)));
	let thumbnail = json_str(v, &["thumbnail"]);
	let uploader = json_str(v, &["uploader", "channel", "creator"]);
	let extractor = json_str(v, &["extractor_key", "extractor"])
		.map(|s| s.to_lowercase())
		.unwrap_or_else(|| fallback_site.to_string());
	Some(MediaCandidate {
		id,
		title,
		duration_s,
		webpage_url,
		thumbnail,
		uploader,
		site: extractor,
	})
}

#[tauri::command]
pub fn normalize_link_input(raw: String) -> ResolvedInput {
	normalize_user_input(&raw)
}

#[tauri::command]
pub fn resolve_media_link(app: AppHandle, raw: String) -> Result<ResolveResult, String> {
	CANCEL.store(false, Ordering::SeqCst);
	let input = normalize_user_input(&raw);
	emit_progress(&app, "resolve", "Looking up media…", 5);
	let ytdlp = find_ytdlp(&app)?;

	let mut cmd = Command::new(&ytdlp);
	cmd.args([
		"--no-warnings",
		"--skip-download",
		"--flat-playlist",
		"--dump-single-json",
		&input.query,
	]);
	#[cfg(windows)]
	{
		use std::os::windows::process::CommandExt;
		cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
	}

	let output = cmd
		.output()
		.map_err(|e| format!("Failed to run yt-dlp: {e}"))?;
	if CANCEL.load(Ordering::SeqCst) {
		return Err("Cancelled.".into());
	}
	if !output.status.success() {
		let err = String::from_utf8_lossy(&output.stderr);
		let out = String::from_utf8_lossy(&output.stdout);
		return Err(format!(
			"Could not resolve link.\n{}",
			if err.trim().is_empty() {
				out.trim()
			} else {
				err.trim()
			}
		));
	}

	let stdout = String::from_utf8_lossy(&output.stdout);
	let v: serde_json::Value = serde_json::from_str(stdout.trim()).map_err(|e| {
		format!("yt-dlp returned invalid JSON: {e}\n{}", stdout.chars().take(400).collect::<String>())
	})?;

	let mut entries: Vec<MediaCandidate> = Vec::new();
	if let Some(arr) = v.get("entries").and_then(|e| e.as_array()) {
		for item in arr.iter().take(40) {
			if let Some(c) = candidate_from_json(item, &input.site) {
				entries.push(c);
			}
		}
	}
	if entries.is_empty() {
		if let Some(c) = candidate_from_json(&v, &input.site) {
			entries.push(c);
		}
	}
	if entries.is_empty() {
		return Err("No videos found for that link or search.".into());
	}

	emit_progress(
		&app,
		"resolve",
		&format!("Found {} item(s)", entries.len()),
		100,
	);
	Ok(ResolveResult { input, entries })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadLinkArgs {
	pub url: String,
	pub title: Option<String>,
	/// Optional start time in seconds (inclusive).
	pub start_s: Option<f64>,
	/// Optional end time in seconds (exclusive).
	pub end_s: Option<f64>,
	/// Prefer writing soft / auto subs when the site provides them.
	pub write_subs: Option<bool>,
	/// Run hardsub OCR after download (requires `pnpm ocr:setup`).
	pub run_ocr: Option<bool>,
	pub ocr_interval_s: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadLinkResult {
	pub video_path: String,
	pub subtitle_path: Option<String>,
	pub subtitle_source: Option<String>,
	pub title: String,
	pub duration_ms: u64,
}

fn find_sidecar_subs(dir: &Path, stem: &str) -> Option<PathBuf> {
	let mut best: Option<PathBuf> = None;
	let Ok(rd) = fs::read_dir(dir) else {
		return None;
	};
	for ent in rd.flatten() {
		let p = ent.path();
		let name = p.file_name()?.to_string_lossy().to_string();
		if !name.starts_with(stem) {
			continue;
		}
		let lower = name.to_lowercase();
		if lower.ends_with(".srt") || lower.ends_with(".vtt") {
			best = Some(p);
			if lower.contains(".zh") || lower.contains(".zh-hans") || lower.contains(".zh-cn") {
				return best;
			}
		}
	}
	best
}

fn trim_with_ffmpeg(
	app: &AppHandle,
	ffmpeg: &Path,
	src: &Path,
	dest: &Path,
	start_s: f64,
	end_s: Option<f64>,
) -> Result<(), String> {
	emit_progress(app, "trim", "Trimming selected range…", 70);
	let start = start_s.max(0.0);
	let mut args = vec![
		"-hide_banner".into(),
		"-y".into(),
		"-ss".into(),
		format!("{start:.3}"),
		"-i".into(),
		ffmpeg_path_arg(src),
	];
	if let Some(end) = end_s {
		if end > start {
			args.push("-to".into());
			args.push(format!("{end:.3}"));
		}
	}
	args.extend([
		"-c".into(),
		"copy".into(),
		"-avoid_negative_ts".into(),
		"make_zero".into(),
		ffmpeg_path_arg(dest),
	]);
	let status = Command::new(ffmpeg)
		.args(&args)
		.output()
		.map_err(|e| format!("FFmpeg trim failed to start: {e}"))?;
	if !status.status.success() {
		// Remux copy can fail on some containers — retry with re-encode.
		let mut args2 = vec![
			"-hide_banner".into(),
			"-y".into(),
			"-ss".into(),
			format!("{start:.3}"),
			"-i".into(),
			ffmpeg_path_arg(src),
		];
		if let Some(end) = end_s {
			if end > start {
				args2.push("-to".into());
				args2.push(format!("{end:.3}"));
			}
		}
		args2.extend([
			"-c:v".into(),
			"libx264".into(),
			"-preset".into(),
			"veryfast".into(),
			"-crf".into(),
			"20".into(),
			"-c:a".into(),
			"aac".into(),
			"-movflags".into(),
			"+faststart".into(),
			ffmpeg_path_arg(dest),
		]);
		let status2 = Command::new(ffmpeg)
			.args(&args2)
			.output()
			.map_err(|e| format!("FFmpeg trim re-encode failed: {e}"))?;
		if !status2.status.success() {
			return Err(ffmpeg_fail_message(&status2));
		}
	}
	Ok(())
}

fn run_hardsub_ocr(
	app: &AppHandle,
	video: &Path,
	srt_out: &Path,
	interval_s: f64,
) -> Result<String, String> {
	let script = find_ocr_script(app)?;
	let python = find_ocr_python()?;
	let ffmpeg = find_ffmpeg(app)?;
	emit_progress(app, "ocr", "OCR hardsubs…", 80);

	let mut cmd = Command::new(&python);
	cmd.args([
		script.to_string_lossy().as_ref(),
		"--video",
		&video.to_string_lossy(),
		"--ffmpeg",
		&ffmpeg.to_string_lossy(),
		"--interval",
		&format!("{interval_s:.2}"),
		"--srt-out",
		&srt_out.to_string_lossy(),
	]);
	cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
	#[cfg(windows)]
	{
		use std::os::windows::process::CommandExt;
		cmd.creation_flags(0x08000000);
	}

	let mut child = cmd
		.spawn()
		.map_err(|e| format!("Could not start OCR: {e}\nRun: pnpm ocr:setup"))?;

	let stdout = child.stdout.take();
	let stderr = child.stderr.take();
	let last_result = Arc::new(Mutex::new(String::new()));
	let last_result_w = Arc::clone(&last_result);
	let app_progress = app.clone();

	let reader_thread = std::thread::spawn(move || {
		if let Some(out) = stdout {
			let reader = BufReader::new(out);
			for line in reader.lines().flatten() {
				if let Some(rest) = line.strip_prefix("PROGRESS ") {
					let mut parts = rest.splitn(2, char::is_whitespace);
					let pct: u32 = parts.next().and_then(|p| p.parse().ok()).unwrap_or(85);
					let msg = parts.next().unwrap_or("OCR…");
					emit_progress(&app_progress, "ocr", msg, 80 + (pct.min(100) * 15 / 100));
				} else if let Some(json) = line.strip_prefix("RESULT ") {
					if let Ok(mut g) = last_result_w.lock() {
						*g = json.to_string();
					}
				}
			}
		}
	});

	let mut err_buf = String::new();
	if let Some(err) = stderr {
		let mut r = BufReader::new(err);
		let _ = r.read_to_string(&mut err_buf);
	}

	let status = child
		.wait()
		.map_err(|e| format!("OCR process failed: {e}"))?;
	let _ = reader_thread.join();

	if CANCEL.load(Ordering::SeqCst) {
		return Err("Cancelled.".into());
	}
	if !status.success() {
		return Err(format!(
			"Hardsub OCR failed.\n{}",
			if err_buf.trim().is_empty() {
				"Run: pnpm ocr:setup"
			} else {
				err_buf.trim()
			}
		));
	}

	if srt_out.is_file() {
		return Ok(srt_out.to_string_lossy().to_string());
	}

	let raw = last_result.lock().map(|g| g.clone()).unwrap_or_default();
	if !raw.is_empty() {
		if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
			if let Some(srt) = v.get("srt").and_then(|s| s.as_str()) {
				if !srt.trim().is_empty() {
					fs::write(srt_out, srt)
						.map_err(|e| format!("Could not write OCR SRT: {e}"))?;
					return Ok(srt_out.to_string_lossy().to_string());
				}
			}
		}
	}
	Err("OCR finished but produced no subtitle cues.".into())
}

fn probe_duration_ms(ffmpeg: &Path, video: &Path) -> u64 {
	let output = Command::new(ffmpeg)
		.args(["-hide_banner", "-i", &ffmpeg_path_arg(video)])
		.output()
		.ok();
	let Some(o) = output else {
		return 0;
	};
	let log = String::from_utf8_lossy(&o.stderr);
	// Duration: 00:01:06.10
	for line in log.lines() {
		if let Some(idx) = line.find("Duration:") {
			let rest = &line[idx + "Duration:".len()..];
			let token = rest.split(',').next().unwrap_or("").trim();
			let parts: Vec<&str> = token.split(':').collect();
			if parts.len() == 3 {
				let h: f64 = parts[0].parse().unwrap_or(0.0);
				let m: f64 = parts[1].parse().unwrap_or(0.0);
				let s: f64 = parts[2].parse().unwrap_or(0.0);
				return ((h * 3600.0 + m * 60.0 + s) * 1000.0).round() as u64;
			}
		}
	}
	0
}

#[tauri::command]
pub fn download_media_link(app: AppHandle, args: DownloadLinkArgs) -> Result<DownloadLinkResult, String> {
	CANCEL.store(false, Ordering::SeqCst);
	let url = args.url.trim();
	if url.is_empty() {
		return Err("URL is empty.".into());
	}

	let ytdlp = find_ytdlp(&app)?;
	let ffmpeg = find_ffmpeg(&app)?;
	let root = imports_dir(&app)?;
	let stamp = now_stamp();
	let title_hint = args
		.title
		.as_deref()
		.map(sanitize_filename)
		.unwrap_or_else(|| "import".into());
	let work = root.join(format!("{stamp}_{title_hint}"));
	fs::create_dir_all(&work).map_err(|e| format!("Could not create import folder: {e}"))?;

	emit_progress(&app, "download", "Downloading…", 8);

	let out_tmpl = work.join("%(title).80B [%(id)s].%(ext)s");
	let mut cmd = Command::new(&ytdlp);
	cmd.arg("--no-warnings")
		.arg("--newline")
		.arg("-f")
		.arg("bv*+ba/b")
		.arg("--merge-output-format")
		.arg("mp4")
		.arg("-o")
		.arg(out_tmpl.to_string_lossy().as_ref())
		.arg("--ffmpeg-location")
		.arg(
			ffmpeg
				.parent()
				.map(|p| p.to_string_lossy().to_string())
				.unwrap_or_else(|| ffmpeg.to_string_lossy().to_string()),
		);

	let write_subs = args.write_subs.unwrap_or(true);
	if write_subs {
		cmd.args([
			"--write-subs",
			"--write-auto-subs",
			"--sub-langs",
			"zh.*,zh-Hans,zh-CN,zh,en.*,en",
			"--convert-subs",
			"srt",
		]);
	}
	cmd.arg(url);
	cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
	#[cfg(windows)]
	{
		use std::os::windows::process::CommandExt;
		cmd.creation_flags(0x08000000);
	}

	let mut child = cmd
		.spawn()
		.map_err(|e| format!("Failed to start yt-dlp: {e}"))?;

	let stdout = child.stdout.take();
	let stderr = child.stderr.take();
	let app_c = app.clone();
	let progress_thread = std::thread::spawn(move || {
		let emit_line = |app: &AppHandle, l: &str| {
			let l = l.trim();
			if l.contains('%') {
				if let Some(pct_str) = l.split_whitespace().find(|t| t.ends_with('%')) {
					let num = pct_str.trim_end_matches('%').parse::<f64>().unwrap_or(0.0);
					let mapped = 8 + ((num / 100.0) * 55.0) as u32;
					emit_progress(app, "download", l, mapped.min(65));
				}
			} else if l.starts_with("[Merger]") || l.starts_with("[ExtractAudio]") {
				emit_progress(app, "download", l, 66);
			}
		};
		// yt-dlp progress is usually on stderr
		if let Some(err) = stderr {
			for line in BufReader::new(err).lines().flatten() {
				if CANCEL.load(Ordering::SeqCst) {
					break;
				}
				emit_line(&app_c, &line);
			}
		}
		if let Some(out) = stdout {
			for line in BufReader::new(out).lines().flatten() {
				if CANCEL.load(Ordering::SeqCst) {
					break;
				}
				emit_line(&app_c, &line);
			}
		}
	});

	let status = child
		.wait()
		.map_err(|e| format!("yt-dlp exited abnormally: {e}"))?;
	let _ = progress_thread.join();

	if CANCEL.load(Ordering::SeqCst) {
		let _ = fs::remove_dir_all(&work);
		return Err("Cancelled.".into());
	}
	if !status.success() {
		return Err(
			"Download failed. Check the URL, your network, and that the content is available."
				.into(),
		);
	}

	// Find the downloaded video file
	let mut video_path: Option<PathBuf> = None;
	if let Ok(rd) = fs::read_dir(&work) {
		for ent in rd.flatten() {
			let p = ent.path();
			let ext = p
				.extension()
				.and_then(|e| e.to_str())
				.unwrap_or("")
				.to_lowercase();
			if matches!(ext.as_str(), "mp4" | "mkv" | "webm" | "mov" | "m4a" | "mp3") {
				video_path = Some(p);
				break;
			}
		}
	}
	let Some(full_video) = video_path else {
		return Err("Download finished but no media file was found.".into());
	};

	let stem = full_video
		.file_stem()
		.and_then(|s| s.to_str())
		.unwrap_or("video")
		.to_string();
	let mut subtitle_path = find_sidecar_subs(&work, &stem);
	let mut subtitle_source = subtitle_path.as_ref().map(|_| "soft".to_string());

	let start_s = args.start_s.unwrap_or(0.0).max(0.0);
	let end_s = args.end_s.filter(|e| *e > start_s + 0.2);
	let needs_trim = start_s > 0.05 || end_s.is_some();

	let final_video = if needs_trim {
		let trimmed = work.join(format!("{stem}_clip.mp4"));
		trim_with_ffmpeg(&app, &ffmpeg, &full_video, &trimmed, start_s, end_s)?;
		// Soft subs timing won't match a mid-file trim — drop them for range clips.
		subtitle_path = None;
		subtitle_source = None;
		trimmed
	} else {
		full_video
	};

	if args.run_ocr.unwrap_or(false) {
		let ocr_srt = work.join(format!("{stem}_ocr.srt"));
		let interval = args.ocr_interval_s.unwrap_or(1.0).clamp(0.25, 5.0);
		match run_hardsub_ocr(&app, &final_video, &ocr_srt, interval) {
			Ok(path) => {
				subtitle_path = Some(PathBuf::from(path));
				subtitle_source = Some("ocr".into());
			}
			Err(e) => {
					// Softsubs already present → keep them; otherwise surface OCR error softly.
					if subtitle_path.is_none() {
						emit_progress(&app, "ocr", &e, 95);
						eprintln!("OCR skipped: {e}");
					}
			}
		}
	}

	let duration_ms = probe_duration_ms(&ffmpeg, &final_video);
	let title = args
		.title
		.filter(|t| !t.trim().is_empty())
		.unwrap_or_else(|| stem.clone());

	emit_progress(&app, "done", "Ready in studio", 100);

	Ok(DownloadLinkResult {
		video_path: final_video.to_string_lossy().to_string(),
		subtitle_path: subtitle_path.map(|p| p.to_string_lossy().to_string()),
		subtitle_source,
		title,
		duration_ms,
	})
}

#[tauri::command]
pub fn cancel_link_import() -> Result<(), String> {
	CANCEL.store(true, Ordering::SeqCst);
	Ok(())
}

#[tauri::command]
pub fn link_import_tools_status(app: AppHandle) -> Result<serde_json::Value, String> {
	let ytdlp = find_ytdlp(&app).ok();
	let ocr_script = find_ocr_script(&app).is_ok();
	let ocr_python = find_ocr_python().ok();
	Ok(serde_json::json!({
		"ytdlp": ytdlp.map(|p| p.to_string_lossy().to_string()),
		"ocrReady": ocr_script && ocr_python.is_some(),
		"ocrPython": ocr_python.map(|p| p.to_string_lossy().to_string()),
	}))
}
