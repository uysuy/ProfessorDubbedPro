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
	} else if h.contains("wetv.vip") || h.contains("wetvinfo.com") {
		"wetv"
	} else if h.contains("v.qq.com") || h == "v.qq.com" {
		"tencent"
	} else if h.contains("douyin.com") || h.contains("tiktok.com") {
		"short_video"
	} else if h.contains("dailymotion.com") || h.contains("dai.ly") {
		"dailymotion"
	} else if h.contains("vimeo.com") {
		"vimeo"
	} else if h.contains("twitter.com") || h.contains("x.com") {
		"twitter"
	} else {
		"other"
	}
}

/// WeTV channel module pages are not yt-dlp URLs — they need `/play/{albumId}`.
fn wetv_channel_id(url: &str) -> Option<String> {
	let lower = url.to_lowercase();
	if !lower.contains("wetv.vip") {
		return None;
	}
	// /en/channel/10262 or ?id=10262
	if let Some(idx) = lower.find("/channel/") {
		let rest = &url[idx + "/channel/".len()..];
		let id = rest
			.split(|c| c == '?' || c == '/' || c == '#' || c == '&')
			.next()
			.unwrap_or("")
			.trim();
		if !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
			return Some(id.to_string());
		}
	}
	// query id=
	for part in url.split(&['?', '&'][..]).skip(1) {
		if let Some(v) = part.strip_prefix("id=") {
			let id = v.split('#').next().unwrap_or(v).trim();
			if !id.is_empty() && id.chars().all(|c| c.is_ascii_digit()) {
				return Some(id.to_string());
			}
		}
	}
	None
}

fn is_wetv_play_url(url: &str) -> bool {
	let lower = url.to_lowercase();
	lower.contains("wetv.vip") && lower.contains("/play/")
}

fn normalize_user_input(raw: &str) -> ResolvedInput {
	let trimmed = raw.trim();
	if let Some(u) = url_like::UrlLike::parse(trimmed) {
		let host = host_of(&u);
		let mut site = classify_site(&host).to_string();
		let lower = trimmed.to_lowercase();

		if site == "wetv" || lower.contains("wetv.vip") {
			site = "wetv".into();
			if wetv_channel_id(trimmed).is_some() {
				return ResolvedInput {
					kind: "wetv_channel".into(),
					site,
					query: trimmed.to_string(),
					display: trimmed.to_string(),
				};
			}
			if is_wetv_play_url(trimmed) {
				// Series play URLs list episodes; episode URLs have two path ids.
				let after = lower.split("/play/").nth(1).unwrap_or("");
				let parts: Vec<&str> = after
					.split('/')
					.filter(|p| !p.is_empty())
					.take(2)
					.collect();
				let kind = if parts.len() >= 2 {
					"video"
				} else {
					"wetv_series"
				};
				return ResolvedInput {
					kind: kind.into(),
					site,
					query: trimmed.to_string(),
					display: trimmed.to_string(),
				};
			}
		}

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

	// Explicit ytsearchN:query (gallery pagination)
	if trimmed.to_ascii_lowercase().starts_with("ytsearch") {
		return ResolvedInput {
			kind: "search".into(),
			site: "youtube".into(),
			query: trimmed.to_string(),
			display: trimmed.to_string(),
		};
	}

	// Channel / search name → ytsearch (24 results for gallery shelves)
	let q = format!("ytsearch24:{trimmed}");
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
	/// `video` | `series` — series rows drill into an episode list when selected.
	#[serde(default = "default_candidate_kind")]
	pub kind: String,
}

fn default_candidate_kind() -> String {
	"video".into()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveResult {
	pub input: ResolvedInput,
	pub entries: Vec<MediaCandidate>,
	/// Human label for the list pane, e.g. "movies", "episodes".
	#[serde(default)]
	pub list_label: String,
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

fn best_thumbnail(v: &serde_json::Value) -> Option<String> {
	if let Some(arr) = v.get("thumbnails").and_then(|t| t.as_array()) {
		let mut best: Option<(i64, String)> = None;
		for item in arr {
			let url = item.get("url").and_then(|u| u.as_str()).unwrap_or("").trim();
			if url.is_empty() {
				continue;
			}
			let w = item.get("width").and_then(|x| x.as_i64()).unwrap_or(0);
			let h = item.get("height").and_then(|x| x.as_i64()).unwrap_or(0);
			let score = w.saturating_mul(h).max(w).max(h);
			if best.as_ref().map(|(s, _)| score >= *s).unwrap_or(true) {
				best = Some((score, url.to_string()));
			}
		}
		if let Some((_, url)) = best {
			return Some(url);
		}
	}
	json_str(v, &["thumbnail"])
}

fn wetv_ids_from_play_url(url: &str) -> Option<(String, Option<String>)> {
	// https://wetv.vip/en/play/SERIES or …/play/SERIES/EPISODE
	let lower = url.to_lowercase();
	let idx = lower.find("/play/")?;
	let rest = url[idx + "/play/".len()..].trim_start_matches('/');
	let mut parts = rest
		.split(|c| c == '?' || c == '#' || c == '&')
		.next()
		.unwrap_or("")
		.split('/')
		.filter(|p| !p.is_empty());
	let series = parts.next()?.to_string();
	if series.is_empty() {
		return None;
	}
	let episode = parts.next().map(|s| s.to_string()).filter(|s| !s.is_empty());
	Some((series, episode))
}

fn candidate_from_json(v: &serde_json::Value, fallback_site: &str) -> Option<MediaCandidate> {
	let webpage_url_raw = json_str(v, &["webpage_url", "url", "original_url"])?;
	let wetv_ids = wetv_ids_from_play_url(&webpage_url_raw);

	let mut id = json_str(v, &["id"]).unwrap_or_default();
	if id.is_empty() || id == "unknown" {
		if let Some((_, Some(ep))) = wetv_ids.as_ref() {
			id = ep.clone();
		} else if let Some((series, None)) = wetv_ids.as_ref() {
			id = series.clone();
		} else if !webpage_url_raw.starts_with("http") {
			id = webpage_url_raw.clone();
		} else {
			id = "unknown".into();
		}
	}

	let mut title = json_str(v, &["title", "fulltitle"]).unwrap_or_default();
	if title.is_empty() || title == "unknown" {
		title = id.clone();
	}

	// Flat playlist entries sometimes only have `url` as an id — normalize YouTube / WeTV.
	let webpage_url = if webpage_url_raw.starts_with("http://") || webpage_url_raw.starts_with("https://")
	{
		if let Some((series, Some(ep))) = wetv_ids.as_ref() {
			format!("https://wetv.vip/en/play/{series}/{ep}")
		} else if let Some((series, None)) = wetv_ids.as_ref() {
			format!("https://wetv.vip/en/play/{series}")
		} else {
			webpage_url_raw
		}
	} else if fallback_site.contains("youtube") || webpage_url_raw.len() == 11 {
		format!("https://www.youtube.com/watch?v={id}")
	} else if fallback_site.contains("wetv") {
		format!("https://wetv.vip/en/play/{id}")
	} else {
		webpage_url_raw
	};

	let duration_s = v
		.get("duration")
		.and_then(|d| d.as_f64().or_else(|| d.as_u64().map(|u| u as f64)));
	let thumbnail = best_thumbnail(v).or_else(|| {
		// YouTube hqdefault fallback when flat playlist omits thumbs.
		if id.len() == 11
			&& (fallback_site.contains("youtube")
				|| webpage_url.contains("youtube.com")
				|| webpage_url.contains("youtu.be"))
		{
			Some(format!("https://i.ytimg.com/vi/{id}/hqdefault.jpg"))
		} else {
			None
		}
	});
	let uploader = json_str(v, &["uploader", "channel", "creator"]);
	let extractor = json_str(v, &["extractor_key", "extractor", "ie_key"])
		.map(|s| s.to_lowercase())
		.unwrap_or_else(|| fallback_site.to_string());
	let site = if extractor.contains("wetv") || webpage_url.contains("wetv.vip") {
		"wetv".into()
	} else if extractor.contains("youtube") {
		"youtube".into()
	} else if extractor.contains("dailymotion") {
		"dailymotion".into()
	} else {
		extractor
	};
	let kind = if v.get("_type").and_then(|t| t.as_str()) == Some("playlist") {
		"series"
	} else {
		"video"
	};
	Some(MediaCandidate {
		id,
		title,
		duration_s,
		webpage_url,
		thumbnail,
		uploader,
		site,
		kind: kind.into(),
	})
}

fn resolve_wetv_channel(app: &AppHandle, channel_url: &str) -> Result<ResolveResult, String> {
	let channel_id = wetv_channel_id(channel_url).ok_or_else(|| {
		"Not a WeTV channel URL. Use a channel link, or a play URL like https://wetv.vip/en/play/SERIES_ID".to_string()
	})?;
	emit_progress(app, "resolve", "Loading WeTV channel catalog…", 15);

	let api = format!("https://wetv.vip/api/channel?id={channel_id}");
	let client = reqwest::blocking::Client::builder()
		.user_agent("Mozilla/5.0 (compatible; ProfessorDubbedPro/0.2)")
		.timeout(std::time::Duration::from_secs(25))
		.build()
		.map_err(|e| format!("HTTP client error: {e}"))?;
	let resp = client
		.get(&api)
		.header("Accept", "application/json")
		.send()
		.map_err(|e| format!("Could not reach WeTV channel API: {e}"))?;
	if !resp.status().is_success() {
		return Err(format!(
			"WeTV channel API returned HTTP {}.\nTip: open a series play page instead, e.g. https://wetv.vip/en/play/SERIES_ID",
			resp.status()
		));
	}
	let body: serde_json::Value = resp
		.json()
		.map_err(|e| format!("Invalid WeTV channel JSON: {e}"))?;
	if body.get("retCode").and_then(|c| c.as_i64()).unwrap_or(-1) != 0 {
		return Err("WeTV channel API error — try a /play/ series URL instead.".into());
	}

	let mut entries: Vec<MediaCandidate> = Vec::new();
	let mut seen = std::collections::HashSet::<String>::new();
	if let Some(modules) = body
		.pointer("/response/modules")
		.and_then(|m| m.as_array())
	{
		for module in modules {
			let module_name = module
				.get("name")
				.and_then(|n| n.as_str())
				.unwrap_or("WeTV");
			let items = module.get("items").and_then(|i| i.as_array());
			let Some(items) = items else { continue };
			for item in items {
				if item.get("type").and_then(|t| t.as_str()) != Some("ITEM_TYPE_ALBUM") {
					continue;
				}
				let id = match item.get("id").and_then(|x| x.as_str()) {
					Some(s) if !s.is_empty() => s.to_string(),
					_ => continue,
				};
				if !seen.insert(id.clone()) {
					continue;
				}
				let title = item
					.get("title")
					.and_then(|t| t.as_str())
					.unwrap_or(id.as_str())
					.to_string();
				let subtitle = item
					.get("subtitle")
					.and_then(|t| t.as_str())
					.map(|s| s.to_string());
				let pic = item
					.get("pic")
					.and_then(|t| t.as_str())
					.map(|s| s.to_string());
				let mark = item
					.pointer("/mark_label_list/1/text")
					.and_then(|t| t.as_str())
					.map(|s| s.to_string());
				// Prefer EP mark over subtitle when subtitle duplicates the title.
				let uploader = mark
					.clone()
					.or_else(|| {
						subtitle.filter(|s| !s.eq_ignore_ascii_case(&title))
					})
					.or(Some(module_name.to_string()));
				entries.push(MediaCandidate {
					id: id.clone(),
					title,
					duration_s: None,
					webpage_url: format!("https://wetv.vip/en/play/{id}"),
					thumbnail: pic,
					uploader,
					site: "wetv".into(),
					kind: "series".into(),
				});
			}
		}
	}

	if entries.is_empty() {
		return Err(
			"No titles found on that WeTV channel.\nOpen a series instead: https://wetv.vip/en/play/SERIES_ID"
				.into(),
		);
	}

	emit_progress(
		app,
		"resolve",
		&format!("Found {} WeTV titles", entries.len()),
		100,
	);
	Ok(ResolveResult {
		input: ResolvedInput {
			kind: "wetv_channel".into(),
			site: "wetv".into(),
			query: channel_url.to_string(),
			display: channel_url.to_string(),
		},
		entries,
		list_label: "movies / series".into(),
	})
}

fn friendly_resolve_error(raw_err: &str, input: &ResolvedInput) -> String {
	let e = raw_err.trim();
	if input.site == "wetv" || e.to_lowercase().contains("wetv") {
		return format!(
			"{e}\n\nWeTV tips:\n• Channel pages like /channel/10262 now load a movie list in-app.\n• For episodes, use a play URL: https://wetv.vip/en/play/SERIES_ID\n• Or pick a title from the channel list, then choose an episode."
		);
	}
	if e.contains("Unsupported URL") {
		return format!(
			"{e}\n\nThat page is not a supported media URL for yt-dlp.\nTry a direct video/series play link, or a search name."
		);
	}
	if e.contains("Sign in to confirm") || e.contains("not a bot") {
		return format!(
			"{e}\n\nYouTube is blocking this network. On your PC, try again (or export browser cookies for yt-dlp)."
		);
	}
	format!("Could not resolve link.\n{e}")
}

fn youtube_id_from_url(url: &str) -> Option<String> {
	let u = url.trim();
	if let Some(rest) = u.strip_prefix("https://youtu.be/") {
		let id = rest.split(['?', '&', '/']).next().unwrap_or("");
		if id.len() == 11 {
			return Some(id.to_string());
		}
	}
	for marker in ["v=", "/embed/", "/shorts/", "/live/"] {
		if let Some(idx) = u.find(marker) {
			let rest = &u[idx + marker.len()..];
			let id = rest.split(['?', '&', '/']).next().unwrap_or("");
			if id.len() == 11 {
				return Some(id.to_string());
			}
		}
	}
	None
}

fn bilibili_bvid(url: &str) -> Option<String> {
	for part in url.split('/') {
		if part.starts_with("BV") && part.len() >= 10 {
			return Some(part.split(['?', '&']).next().unwrap_or(part).to_string());
		}
	}
	None
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaPreviewInfo {
	/// `embed` | `stream` | `none`
	pub kind: String,
	pub url: Option<String>,
	pub thumbnail: Option<String>,
	pub title: String,
	pub duration_s: Option<f64>,
	pub webpage_url: String,
	pub site: String,
}

fn youtube_embed_preview(id: &str, title: String, duration_s: Option<f64>, thumbnail: Option<String>) -> MediaPreviewInfo {
	MediaPreviewInfo {
		kind: "embed".into(),
		url: Some(format!("https://www.youtube.com/embed/{id}?rel=0&modestbranding=1")),
		thumbnail: thumbnail.or(Some(format!("https://i.ytimg.com/vi/{id}/hqdefault.jpg"))),
		title,
		duration_s,
		webpage_url: format!("https://www.youtube.com/watch?v={id}"),
		site: "youtube".into(),
	}
}

fn bilibili_embed_preview(bvid: &str, url: &str, title: String, duration_s: Option<f64>, thumbnail: Option<String>) -> MediaPreviewInfo {
	MediaPreviewInfo {
		kind: "embed".into(),
		url: Some(format!(
			"https://player.bilibili.com/player.html?bvid={bvid}&high_quality=1&danmaku=0"
		)),
		thumbnail,
		title,
		duration_s,
		webpage_url: url.to_string(),
		site: "bilibili".into(),
	}
}

/// Resolve a direct media URL via yt-dlp `-g` (skips site player ads when the CDN allows).
fn resolve_preview_stream(ytdlp: &Path, url: &str) -> Option<String> {
	let mut stream_cmd = Command::new(ytdlp);
	stream_cmd.args([
		"--no-warnings",
		"--socket-timeout",
		"20",
		"-g",
		"-f",
		"b[height<=720]/best[height<=720]/best",
		"--no-playlist",
		url,
	]);
	#[cfg(windows)]
	{
		use std::os::windows::process::CommandExt;
		stream_cmd.creation_flags(0x08000000);
	}
	let stream_out = stream_cmd.output().ok()?;
	if !stream_out.status.success() {
		return None;
	}
	String::from_utf8_lossy(&stream_out.stdout)
		.lines()
		.map(str::trim)
		.find(|l| l.starts_with("http://") || l.starts_with("https://"))
		.map(|s| s.to_string())
}

fn get_media_preview_blocking(app: &AppHandle, url: String) -> Result<MediaPreviewInfo, String> {
	CANCEL.store(false, Ordering::SeqCst);
	let url = url.trim().to_string();
	if url.is_empty() {
		return Err("URL is empty.".into());
	}
	emit_progress(app, "preview", "Loading preview…", 10);

	// Fast path: native embeds (no yt-dlp) — keeps the gallery UI responsive.
	if let Some(id) = youtube_id_from_url(&url) {
		emit_progress(app, "preview", "YouTube embed ready", 100);
		return Ok(youtube_embed_preview(&id, id.clone(), None, None));
	}
	if let Some(bvid) = bilibili_bvid(&url) {
		emit_progress(app, "preview", "Bilibili embed ready", 100);
		return Ok(bilibili_embed_preview(&bvid, &url, bvid.clone(), None, None));
	}

	if CANCEL.load(Ordering::SeqCst) {
		return Err("Cancelled.".into());
	}

	let ytdlp = find_ytdlp(app)?;

	// One yt-dlp call only (`-g`). Title/thumb come from the gallery list row on the frontend.
	emit_progress(app, "preview", "Resolving stream URL…", 45);
	if let Some(stream) = resolve_preview_stream(&ytdlp, &url) {
		let site = if url.contains("wetv") {
			"wetv".into()
		} else if url.contains("dailymotion") {
			"dailymotion".into()
		} else {
			"other".into()
		};
		emit_progress(app, "preview", "Stream ready (ad-light)", 100);
		return Ok(MediaPreviewInfo {
			kind: "stream".into(),
			url: Some(stream),
			thumbnail: None,
			title: "Preview".into(),
			duration_s: None,
			webpage_url: url,
			site,
		});
	}

	if CANCEL.load(Ordering::SeqCst) {
		return Err("Cancelled.".into());
	}

	emit_progress(app, "preview", "Preview unavailable — thumbnail only", 100);
	Ok(MediaPreviewInfo {
		kind: "none".into(),
		url: None,
		thumbnail: None,
		title: "Preview".into(),
		duration_s: None,
		webpage_url: url,
		site: "other".into(),
	})
}

#[tauri::command]
pub async fn get_media_preview(app: AppHandle, url: String) -> Result<MediaPreviewInfo, String> {
	tauri::async_runtime::spawn_blocking(move || get_media_preview_blocking(&app, url))
		.await
		.map_err(|e| format!("Preview task failed: {e}"))?
}

#[tauri::command]
pub fn normalize_link_input(raw: String) -> ResolvedInput {
	normalize_user_input(&raw)
}

#[tauri::command]
pub async fn resolve_media_link(
	app: AppHandle,
	raw: String,
	playlist_start: Option<u32>,
	playlist_end: Option<u32>,
) -> Result<ResolveResult, String> {
	tauri::async_runtime::spawn_blocking(move || {
		resolve_media_link_blocking(&app, raw, playlist_start, playlist_end)
	})
	.await
	.map_err(|e| format!("Resolve task failed: {e}"))?
}

fn resolve_media_link_blocking(
	app: &AppHandle,
	raw: String,
	playlist_start: Option<u32>,
	playlist_end: Option<u32>,
) -> Result<ResolveResult, String> {
	CANCEL.store(false, Ordering::SeqCst);
	let input = normalize_user_input(&raw);
	emit_progress(app, "resolve", "Looking up media…", 5);

	if input.kind == "wetv_channel" {
		return resolve_wetv_channel(app, &input.query);
	}

	let ytdlp = find_ytdlp(app)?;

	let mut cmd = Command::new(&ytdlp);
	cmd.arg("--no-warnings")
		.arg("--socket-timeout")
		.arg("20")
		.arg("--skip-download");
	// Flat playlist keeps channel/search/series listings fast; single videos get full metadata.
	if matches!(
		input.kind.as_str(),
		"channel_or_playlist" | "search" | "wetv_series"
	) {
		cmd.arg("--flat-playlist");
	} else {
		cmd.arg("--no-playlist");
	}
	if let Some(start) = playlist_start.filter(|s| *s > 0) {
		cmd.arg("--playlist-start").arg(start.to_string());
	}
	if let Some(end) = playlist_end.filter(|e| *e > 0) {
		cmd.arg("--playlist-end").arg(end.to_string());
	}
	cmd.arg("--dump-single-json").arg(&input.query);
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
		let raw_err = if err.trim().is_empty() {
			out.trim()
		} else {
			err.trim()
		};
		return Err(friendly_resolve_error(raw_err, &input));
	}

	let stdout = String::from_utf8_lossy(&output.stdout);
	let v: serde_json::Value = serde_json::from_str(stdout.trim()).map_err(|e| {
		format!(
			"yt-dlp returned invalid JSON: {e}\n{}",
			stdout.chars().take(400).collect::<String>()
		)
	})?;

	let series_id_for_eps = if input.kind == "wetv_series" {
		v.get("id")
			.and_then(|x| x.as_str())
			.map(|s| s.to_string())
			.or_else(|| {
				input
					.query
					.split("/play/")
					.nth(1)
					.map(|rest| {
						rest.split(['/', '?', '-', '#'])
							.next()
							.unwrap_or("")
							.to_string()
					})
					.filter(|s| !s.is_empty())
			})
	} else {
		None
	};
	let series_title = if input.kind == "wetv_series" {
		json_str(&v, &["title", "fulltitle", "playlist_title"])
	} else {
		None
	};
	let series_thumb = if input.kind == "wetv_series" {
		best_thumbnail(&v)
	} else {
		None
	};

	let mut entries: Vec<MediaCandidate> = Vec::new();
	// Allow larger pages for gallery "load more" / episode lists.
	let limit = if input.kind == "wetv_series" {
		250
	} else if input.kind == "search" {
		100
	} else {
		80
	};
	if let Some(arr) = v.get("entries").and_then(|e| e.as_array()) {
		for (idx, item) in arr.iter().take(limit).enumerate() {
			if let Some(mut c) = candidate_from_json(item, &input.site) {
				// WeTV flat episodes are URL-only — fill id / title / thumb from series + index.
				if let Some(series_id) = series_id_for_eps.as_ref() {
					if c.id == "unknown" || c.id.is_empty() {
						if let Some((_, Some(ep))) = wetv_ids_from_play_url(&c.webpage_url) {
							c.id = ep;
						}
					}
					if !c.webpage_url.contains("/play/") || c.webpage_url.matches('/').count() < 5 {
						c.webpage_url = format!("https://wetv.vip/en/play/{series_id}/{}", c.id);
					} else if let Some((_, Some(ep))) = wetv_ids_from_play_url(&c.webpage_url) {
						c.webpage_url = format!("https://wetv.vip/en/play/{series_id}/{ep}");
						c.id = ep;
					}
					let ep_base = playlist_start.unwrap_or(1).saturating_sub(1) as usize;
					let ep_num = ep_base + idx + 1;
					if c.title == "unknown"
						|| c.title.is_empty()
						|| c.title == c.id
						|| c.title.eq_ignore_ascii_case("null")
					{
						c.title = if let Some(st) = series_title.as_ref() {
							format!("{st} · EP{ep_num}")
						} else {
							format!("Episode {ep_num}")
						};
					}
					if c.thumbnail.is_none() {
						c.thumbnail = series_thumb.clone();
					}
					c.uploader = Some(format!("EP{ep_num}"));
					c.site = "wetv".into();
					c.kind = "video".into();
				}
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

	let list_label = if input.kind == "wetv_series" {
		"episodes".into()
	} else if input.kind == "search" {
		"search results".into()
	} else if entries.len() > 1 {
		"videos".into()
	} else {
		"video".into()
	};

	emit_progress(
		app,
		"resolve",
		&format!("Found {} item(s)", entries.len()),
		100,
	);
	Ok(ResolveResult {
		input,
		entries,
		list_label,
	})
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
pub async fn download_media_link(
	app: AppHandle,
	args: DownloadLinkArgs,
) -> Result<DownloadLinkResult, String> {
	tauri::async_runtime::spawn_blocking(move || download_media_link_blocking(app, args))
		.await
		.map_err(|e| format!("Download task failed: {e}"))?
}

fn download_media_link_blocking(
	app: AppHandle,
	args: DownloadLinkArgs,
) -> Result<DownloadLinkResult, String> {
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
