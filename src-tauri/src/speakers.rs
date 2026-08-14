//! Speaker diarization: cluster ASR cues → Speaker 1..N + reference WAVs for VoxCPM cloning.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

use crate::asr_funasr::find_funasr_python;
use crate::export::{ffmpeg_path_arg, find_ffmpeg};
use crate::transcribe::emit_progress;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectSpeakersArgs {
	pub video_path: String,
	pub cues: Vec<DetectSpeakerCue>,
	/// 0 = auto
	#[serde(default)]
	pub max_speakers: u32,
	/// Optional project id used to namespace ref folder.
	#[serde(default)]
	pub project_id: String,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DetectSpeakerCue {
	pub id: String,
	pub start_ms: u64,
	pub end_ms: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerProfileDto {
	pub id: String,
	pub gender: String,
	/// Legacy / unused for Generate — prefer video_ref_wav_path from detect.
	#[serde(default)]
	pub ref_wav_path: String,
	#[serde(default)]
	pub video_ref_wav_path: String,
	pub cue_count: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerAssignmentDto {
	pub cue_id: String,
	pub speaker: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectSpeakersResult {
	pub ok: bool,
	pub speaker_count: u32,
	pub speakers: Vec<SpeakerProfileDto>,
	pub assignments: Vec<SpeakerAssignmentDto>,
	pub message: String,
}

#[derive(Debug, Deserialize)]
struct DiarizeFileResult {
	#[serde(default)]
	ok: bool,
	#[serde(default)]
	error: Option<String>,
	#[serde(default, rename = "speakerCount")]
	#[allow(dead_code)]
	speaker_count: u32,
	#[serde(default)]
	speakers: Vec<DiarizeSpeaker>,
	#[serde(default)]
	assignments: Vec<DiarizeAssignment>,
}

#[derive(Debug, Deserialize)]
struct DiarizeSpeaker {
	id: String,
	gender: String,
	#[serde(default, rename = "refWavPath")]
	ref_wav_path: String,
	#[serde(default, rename = "videoRefWavPath")]
	video_ref_wav_path: String,
	#[serde(rename = "cueCount")]
	cue_count: u32,
}

#[derive(Debug, Deserialize)]
struct DiarizeAssignment {
	#[serde(rename = "cueId")]
	cue_id: String,
	speaker: String,
}

fn project_root() -> PathBuf {
	PathBuf::from(env!("CARGO_MANIFEST_DIR"))
		.parent()
		.map(|p| p.to_path_buf())
		.unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")))
}

fn find_diarize_script(app: &AppHandle) -> Result<PathBuf, String> {
	let mut candidates: Vec<PathBuf> = Vec::new();
	candidates.push(project_root().join("scripts").join("asr").join("diarize_speakers.py"));
	if let Ok(resource) = app.path().resource_dir() {
		candidates.push(resource.join("scripts").join("asr").join("diarize_speakers.py"));
		candidates.push(resource.join("diarize_speakers.py"));
	}
	for p in &candidates {
		if p.is_file() {
			return Ok(p.clone());
		}
	}
	Err("Speaker diarization script not found (scripts/asr/diarize_speakers.py).".into())
}

fn work_dir(app: &AppHandle) -> Result<PathBuf, String> {
	let dir = app
		.path()
		.temp_dir()
		.map_err(|e| format!("Could not resolve temp dir: {e}"))?
		.join("professor-dubbed-pro-speakers");
	fs::create_dir_all(&dir).map_err(|e| format!("Could not create temp dir: {e}"))?;
	Ok(dir)
}

fn speakers_data_dir(app: &AppHandle, project_id: &str) -> Result<PathBuf, String> {
	let safe: String = project_id
		.chars()
		.map(|c| {
			if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
				c
			} else {
				'_'
			}
		})
		.collect();
	let folder = if safe.is_empty() {
		"default".into()
	} else {
		safe
	};
	let dir = app
		.path()
		.app_data_dir()
		.map_err(|e| format!("Could not resolve app data dir: {e}"))?
		.join("speakers")
		.join(folder);
	fs::create_dir_all(&dir).map_err(|e| format!("Could not create speakers dir: {e}"))?;
	Ok(dir)
}

fn extract_mono_wav(ffmpeg: &Path, video: &Path, wav_out: &Path) -> Result<(), String> {
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
			"highpass=f=80,lowpass=f=7600,dynaudnorm=f=100:g=5:p=0.95",
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
		.map_err(|e| format!("Failed to run FFmpeg for speaker detect: {e}"))?;
	if !status.status.success() || !wav_out.is_file() {
		let err = String::from_utf8_lossy(&status.stderr);
		return Err(format!(
			"Could not extract audio for speaker detection.\n{err}"
		));
	}
	Ok(())
}

fn detect_blocking(app: &AppHandle, args: DetectSpeakersArgs) -> Result<DetectSpeakersResult, String> {
	if args.cues.is_empty() {
		return Err("No subtitle cues — run Extract Subs first.".into());
	}
	let video = PathBuf::from(args.video_path.trim());
	if !video.is_file() {
		return Err(format!("Video not found: {}", video.display()));
	}

	emit_progress(app, "speakers", "Preparing audio for speaker detection…", 8);
	let ffmpeg = find_ffmpeg(app)?;
	let stamp = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map(|d| d.as_millis())
		.unwrap_or(0);
	let tmp = work_dir(app)?;
	let wav = tmp.join(format!("speakers-{stamp}.wav"));
	let segs_path = tmp.join(format!("speakers-{stamp}-cues.json"));
	let out_path = tmp.join(format!("speakers-{stamp}-out.json"));
	let refs_dir = speakers_data_dir(app, &args.project_id)?;

	extract_mono_wav(&ffmpeg, &video, &wav)?;
	emit_progress(app, "speakers", "Clustering speakers…", 35);

	let segs_json: Vec<serde_json::Value> = args
		.cues
		.iter()
		.map(|c| {
			serde_json::json!({
				"id": c.id,
				"startMs": c.start_ms,
				"endMs": c.end_ms,
			})
		})
		.collect();
	fs::write(&segs_path, serde_json::to_string_pretty(&segs_json).unwrap_or_else(|_| "[]".into()))
		.map_err(|e| format!("Could not write cue list: {e}"))?;

	let python = find_funasr_python().map_err(|e| {
		format!("{e}\nSpeaker detect uses the FunASR Python venv (`pnpm funasr:setup`).")
	})?;
	let script = find_diarize_script(app)?;
	let root = project_root();
	let script_arg: PathBuf = script
		.strip_prefix(&root)
		.map(|r| r.to_path_buf())
		.unwrap_or_else(|_| script.clone());

	let mut cmd = Command::new(&python);
	cmd.arg("-u")
		.arg(&script_arg)
		.arg("--wav")
		.arg(&wav)
		.arg("--segments")
		.arg(&segs_path)
		.arg("--out")
		.arg(&out_path)
		.arg("--refs-dir")
		.arg(&refs_dir)
		.current_dir(&root);
	if args.max_speakers > 0 {
		cmd.arg("--max-speakers").arg(args.max_speakers.to_string());
	}

	#[cfg(windows)]
	{
		use std::os::windows::process::CommandExt;
		const CREATE_NO_WINDOW: u32 = 0x0800_0000;
		cmd.creation_flags(CREATE_NO_WINDOW);
	}

	let output = cmd
		.output()
		.map_err(|e| format!("Failed to start speaker diarization: {e}"))?;

	let stdout = String::from_utf8_lossy(&output.stdout);
	let stderr = String::from_utf8_lossy(&output.stderr);
	if !out_path.is_file() {
		return Err(format!(
			"Speaker detection produced no result.\n{stdout}\n{stderr}"
		));
	}
	let raw = fs::read_to_string(&out_path).map_err(|e| format!("Could not read diarize output: {e}"))?;
	let parsed: DiarizeFileResult =
		serde_json::from_str(&raw).map_err(|e| format!("Bad diarize JSON: {e}\n{raw}"))?;
	if !parsed.ok {
		return Err(parsed
			.error
			.unwrap_or_else(|| format!("Speaker detection failed.\n{stderr}")));
	}

	let speakers: Vec<SpeakerProfileDto> = parsed
		.speakers
		.into_iter()
		.map(|s| {
			let video = if !s.video_ref_wav_path.trim().is_empty() {
				s.video_ref_wav_path
			} else {
				s.ref_wav_path.clone()
			};
			SpeakerProfileDto {
				id: s.id,
				gender: s.gender,
				ref_wav_path: String::new(),
				video_ref_wav_path: video,
				cue_count: s.cue_count,
			}
		})
		.collect();
	let assignments: Vec<SpeakerAssignmentDto> = parsed
		.assignments
		.into_iter()
		.map(|a| SpeakerAssignmentDto {
			cue_id: a.cue_id,
			speaker: a.speaker,
		})
		.collect();

	emit_progress(
		app,
		"speakers",
		&format!("Detected {} speaker(s)", speakers.len()),
		100,
	);

	let _ = fs::remove_file(&wav);
	let _ = fs::remove_file(&segs_path);

	Ok(DetectSpeakersResult {
		ok: true,
		speaker_count: speakers.len() as u32,
		message: format!(
			"Detected {} speaker(s). Lock a Khmer preset per speaker for stable dubbing.",
			speakers.len()
		),
		speakers,
		assignments,
	})
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSpeakerLockArgs {
	pub project_id: String,
	pub speaker_id: String,
	pub source_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSpeakerLockResult {
	pub file_path: String,
}

fn sanitize_speaker_file_stem(speaker_id: &str) -> String {
	let safe: String = speaker_id
		.chars()
		.map(|c| {
			if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
				c
			} else {
				'_'
			}
		})
		.collect();
	if safe.is_empty() {
		"speaker".into()
	} else {
		safe
	}
}

fn voice_library_dir(app: &AppHandle) -> Result<PathBuf, String> {
	let dir = app
		.path()
		.app_data_dir()
		.map_err(|e| format!("Could not resolve app data dir: {e}"))?
		.join("voice-library");
	fs::create_dir_all(&dir).map_err(|e| format!("Could not create voice-library dir: {e}"))?;
	Ok(dir)
}

fn save_speaker_lock_blocking(
	app: &AppHandle,
	args: SaveSpeakerLockArgs,
) -> Result<SaveSpeakerLockResult, String> {
	let src = PathBuf::from(args.source_path.trim());
	if !src.is_file() {
		return Err(format!("Lock sample not found: {}", src.display()));
	}
	// App-global library so locks survive New project / app restart.
	let dir = voice_library_dir(app)?;
	let stem = sanitize_speaker_file_stem(&args.speaker_id);
	let stamp = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map(|d| d.as_millis())
		.unwrap_or(0);
	let dest = dir.join(format!("voice-{stem}-{stamp}.wav"));
	fs::copy(&src, &dest).map_err(|e| format!("Could not save lock WAV: {e}"))?;

	// Also keep a project-scoped copy for older tooling / recovery.
	if let Ok(proj_dir) = speakers_data_dir(app, &args.project_id) {
		let proj_dest = proj_dir.join(format!("lock-{stem}-{stamp}.wav"));
		let _ = fs::copy(&dest, &proj_dest);
		if let Ok(entries) = fs::read_dir(&proj_dir) {
			let prefix = format!("lock-{stem}-");
			for entry in entries.flatten() {
				let path = entry.path();
				if path == proj_dest {
					continue;
				}
				let name = path
					.file_name()
					.and_then(|n| n.to_str())
					.unwrap_or("");
				if name.starts_with(&prefix) && name.ends_with(".wav") {
					let _ = fs::remove_file(&path);
				}
				if name == format!("lock-{stem}.wav") {
					let _ = fs::remove_file(&path);
				}
			}
		}
	}

	Ok(SaveSpeakerLockResult {
		file_path: dest.to_string_lossy().into_owned(),
	})
}

#[tauri::command]
pub async fn detect_speakers(
	app: AppHandle,
	args: DetectSpeakersArgs,
) -> Result<DetectSpeakersResult, String> {
	tauri::async_runtime::spawn_blocking(move || detect_blocking(&app, args))
		.await
		.map_err(|e| format!("Speaker detect task failed: {e}"))?
}

#[tauri::command]
pub async fn save_speaker_lock_wav(
	app: AppHandle,
	args: SaveSpeakerLockArgs,
) -> Result<SaveSpeakerLockResult, String> {
	tauri::async_runtime::spawn_blocking(move || save_speaker_lock_blocking(&app, args))
		.await
		.map_err(|e| format!("Save lock WAV task failed: {e}"))?
}
