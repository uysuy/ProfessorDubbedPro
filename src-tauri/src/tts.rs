//! Edge-TTS (Microsoft Edge Read Aloud) synthesis via `msedge-tts`.
//! Writes one MP3 per request under the app data `tts/` folder.

use msedge_tts::tts::client::connect;
use msedge_tts::tts::SpeechConfig;
use msedge_tts::voice::get_voices_list;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SynthesizeSpeechArgs {
	/// Plain text to speak (Khmer or English).
	pub text: String,
	/// Edge short voice name, e.g. `km-KH-SreymomNeural`.
	pub voice: String,
	/// Cue id — used in the output filename.
	pub cue_id: String,
	/// Pitch offset in Hz (Edge SSML). Typical range ~-50..+50.
	#[serde(default)]
	pub pitch_hz: i32,
	/// Rate percent offset (Edge SSML), e.g. -20 = slower.
	#[serde(default)]
	pub rate_percent: i32,
	/// Volume percent offset (Edge SSML).
	#[serde(default)]
	pub volume_percent: i32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SynthesizeSpeechResult {
	pub file_path: String,
	pub voice: String,
	pub byte_length: usize,
	pub engine: String,
	/// Measured / estimated MP3 duration in milliseconds.
	pub duration_ms: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListEdgeVoicesArgs {
	/// Locale prefix filter, e.g. `km` or `km-KH`. Empty = all voices.
	#[serde(default)]
	pub locale_prefix: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeVoiceInfo {
	pub short_name: String,
	pub name: String,
	pub friendly_name: String,
	pub gender: String,
	pub locale: String,
	pub status: String,
}

fn escape_xml(text: &str) -> String {
	let mut out = String::with_capacity(text.len());
	for ch in text.chars() {
		match ch {
			'&' => out.push_str("&amp;"),
			'<' => out.push_str("&lt;"),
			'>' => out.push_str("&gt;"),
			'"' => out.push_str("&quot;"),
			'\'' => out.push_str("&apos;"),
			c => out.push(c),
		}
	}
	out
}

fn sanitize_filename(id: &str) -> String {
	id.chars()
		.map(|c| {
			if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
				c
			} else {
				'_'
			}
		})
		.collect()
}

fn tts_dir(app: &AppHandle) -> Result<PathBuf, String> {
	let dir = app
		.path()
		.app_data_dir()
		.map_err(|e| format!("Could not resolve app data dir: {e}"))?
		.join("tts");
	fs::create_dir_all(&dir).map_err(|e| format!("Could not create TTS folder: {e}"))?;
	Ok(dir)
}

fn map_network_error(err: &str) -> String {
	let lower = err.to_lowercase();
	if lower.contains("failed to lookup")
		|| lower.contains("dns")
		|| lower.contains("no such host")
		|| lower.contains("network is unreachable")
		|| lower.contains("timed out")
		|| lower.contains("connection refused")
		|| lower.contains("os error 10060")
		|| lower.contains("os error 11001")
		|| lower.contains("os error 10054")
	{
		return "No internet connection (Edge-TTS requires online access).".to_string();
	}
	if lower.contains("403") || lower.contains("forbidden") {
		return "Edge-TTS was blocked by the server. Try again in a moment.".to_string();
	}
	format!("Edge-TTS failed: {err}")
}

fn contains_khmer(text: &str) -> bool {
	text.chars().any(|c| {
		let u = c as u32;
		(0x1780..=0x17FF).contains(&u) || (0x19E0..=0x19FF).contains(&u)
	})
}

fn is_khmer_voice(voice: &str) -> bool {
	let lower = voice.to_ascii_lowercase();
	lower.contains("km-kh") || lower.contains("sreymom") || lower.contains("piseth")
}

/// Prefer the full Microsoft voice `Name` (what SpeechConfig::from uses).
fn resolve_voice_name(requested: &str) -> String {
	let needle = requested.trim();
	if needle.is_empty() {
		return needle.to_string();
	}
	if needle.starts_with("Microsoft ") {
		return needle.to_string();
	}
	match get_voices_list() {
		Ok(voices) => voices
			.into_iter()
			.find(|v| v.short_name.as_deref() == Some(needle) || v.name == needle)
			.map(|v| v.name)
			.unwrap_or_else(|| needle.to_string()),
		Err(_) => needle.to_string(),
	}
}

#[allow(dead_code)]
fn contains_cjk(text: &str) -> bool {
	text.chars().any(|c| {
		let u = c as u32;
		(0x4E00..=0x9FFF).contains(&u) // CJK Unified
			|| (0x3400..=0x4DBF).contains(&u)
			|| (0xF900..=0xFAFF).contains(&u)
	})
}

fn empty_audio_message(text: &str, voice: &str) -> String {
	if contains_khmer(text) && !is_khmer_voice(voice) {
		return "Edge-TTS returned empty audio: Khmer text needs a Khmer voice (Sreymom / Piseth). Set target language to Khmer.".to_string();
	}
	if is_khmer_voice(voice) && !contains_khmer(text) {
		return "Edge-TTS returned empty/blank audio: this cue has no Khmer text. Paste your Khmer script or Translate first (Chinese on a Khmer voice is silent).".to_string();
	}
	if contains_khmer(text) {
		return "Edge-TTS returned empty audio for this Khmer text. Try again in a moment.".to_string();
	}
	format!(
		"Edge-TTS returned empty audio for voice `{voice}`. Check that text language matches the voice."
	)
}

fn display_name_from_short(short: &str) -> String {
	// km-KH-SreymomNeural → Sreymom
	let parts: Vec<&str> = short.split('-').collect();
	if parts.len() >= 3 {
		let mut name = parts[2..].join("-");
		if let Some(stripped) = name.strip_suffix("Neural") {
			name = stripped.to_string();
		} else if let Some(stripped) = name.strip_suffix("Standard") {
			name = stripped.to_string();
		}
		if !name.is_empty() {
			return name;
		}
	}
	short.to_string()
}

fn list_edge_voices_blocking(args: ListEdgeVoicesArgs) -> Result<Vec<EdgeVoiceInfo>, String> {
	let voices = get_voices_list().map_err(|e| map_network_error(&e.to_string()))?;
	let prefix = args.locale_prefix.trim().to_ascii_lowercase();

	let mut out: Vec<EdgeVoiceInfo> = voices
		.into_iter()
		.filter_map(|v| {
			let short = v.short_name.as_deref()?.trim();
			if short.is_empty() {
				return None;
			}
			let locale = v.locale.as_deref().unwrap_or("").trim();
			if !prefix.is_empty() {
				let loc = locale.to_ascii_lowercase();
				let short_l = short.to_ascii_lowercase();
				if !loc.starts_with(&prefix) && !short_l.starts_with(&prefix) {
					return None;
				}
			}
			let friendly = v
				.friendly_name
				.as_deref()
				.map(str::trim)
				.filter(|s| !s.is_empty())
				.unwrap_or("")
				.to_string();
			Some(EdgeVoiceInfo {
				short_name: short.to_string(),
				name: display_name_from_short(short),
				friendly_name: if friendly.is_empty() {
					v.name.clone()
				} else {
					friendly
				},
				gender: v.gender.unwrap_or_else(|| "Neutral".to_string()),
				locale: if locale.is_empty() {
					short
						.split('-')
						.take(2)
						.collect::<Vec<_>>()
						.join("-")
				} else {
					locale.to_string()
				},
				status: v.status.unwrap_or_else(|| "Unknown".to_string()),
			})
		})
		.collect();

	out.sort_by(|a, b| {
		a.locale
			.cmp(&b.locale)
			.then_with(|| a.gender.cmp(&b.gender))
			.then_with(|| a.name.cmp(&b.name))
	});
	Ok(out)
}

fn synthesize_blocking(
	app: &AppHandle,
	args: SynthesizeSpeechArgs,
) -> Result<SynthesizeSpeechResult, String> {
	let text = args.text.trim();
	if text.is_empty() {
		return Err("Subtitle text is empty — nothing to speak.".to_string());
	}
	let voice_requested = args.voice.trim();
	if voice_requested.is_empty() {
		return Err("No Edge-TTS voice selected.".to_string());
	}

	// English Neural voices return 0 bytes for Khmer script — refuse early with a clear error.
	if contains_khmer(text) && !is_khmer_voice(voice_requested) {
		return Err(empty_audio_message(text, voice_requested));
	}
	// Khmer voices often emit silent/blank audio for Chinese (or non-Khmer) cues.
	if is_khmer_voice(voice_requested) && !contains_khmer(text) {
		return Err(empty_audio_message(text, voice_requested));
	}

	let voice_name = resolve_voice_name(voice_requested);
	let safe_text = escape_xml(text);
	let config = SpeechConfig {
		voice_name: voice_name.clone(),
		audio_format: "audio-24khz-48kbitrate-mono-mp3".to_string(),
		pitch: args.pitch_hz.clamp(-100, 100),
		rate: args.rate_percent.clamp(-50, 100),
		volume: args.volume_percent.clamp(-50, 50),
	};

	let mut client = connect().map_err(|e| map_network_error(&e.to_string()))?;
	let audio = client
		.synthesize(&safe_text, &config)
		.map_err(|e| map_network_error(&e.to_string()))?;

	let bytes = audio.audio_bytes;
	// Tiny payloads are effectively silent (headers only / near-empty frames).
	if bytes.len() < 512 {
		return Err(empty_audio_message(text, &voice_name));
	}

	let dir = tts_dir(app)?;
	let file_name = format!(
		"{}_{}.mp3",
		sanitize_filename(&args.cue_id),
		uuid::Uuid::new_v4().simple()
	);
	let path = dir.join(file_name);
	fs::write(&path, &bytes).map_err(|e| format!("Could not write TTS file: {e}"))?;

	let duration_ms = probe_mp3_duration_ms(app, &path)
		.unwrap_or_else(|| estimate_mp3_duration_ms(bytes.len()));

	Ok(SynthesizeSpeechResult {
		file_path: path.to_string_lossy().to_string(),
		voice: voice_requested.to_string(),
		byte_length: bytes.len(),
		engine: "edge-tts".to_string(),
		duration_ms,
	})
}

/// Edge config uses `audio-24khz-48kbitrate-mono-mp3` (≈48 kbps CBR).
fn estimate_mp3_duration_ms(byte_length: usize) -> u64 {
	let ms = (byte_length as u64)
		.saturating_mul(8)
		.saturating_mul(1000)
		/ 48_000;
	ms.max(200)
}

fn probe_mp3_duration_ms(app: &AppHandle, path: &std::path::Path) -> Option<u64> {
	let ffmpeg = crate::export::find_ffmpeg(app).ok()?;
	let output = std::process::Command::new(&ffmpeg)
		.args([
			"-hide_banner",
			"-i",
			&crate::export::ffmpeg_path_arg(path),
		])
		.output()
		.ok()?;
	let log = String::from_utf8_lossy(&output.stderr);
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

/// List Edge Read Aloud voices (optionally filtered by locale prefix, e.g. `km`).
#[tauri::command]
pub async fn list_edge_voices(args: ListEdgeVoicesArgs) -> Result<Vec<EdgeVoiceInfo>, String> {
	tauri::async_runtime::spawn_blocking(move || list_edge_voices_blocking(args))
		.await
		.map_err(|e| format!("Voice list task failed: {e}"))?
}

/// Generate one MP3 for a subtitle cue via Microsoft Edge Read Aloud.
#[tauri::command]
pub async fn synthesize_speech(
	app: AppHandle,
	args: SynthesizeSpeechArgs,
) -> Result<SynthesizeSpeechResult, String> {
	tauri::async_runtime::spawn_blocking(move || synthesize_blocking(&app, args))
		.await
		.map_err(|e| format!("TTS task failed: {e}"))?
}
