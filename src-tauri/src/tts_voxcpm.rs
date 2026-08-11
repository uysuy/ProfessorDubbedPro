//! Optional VoxCPM2 local TTS sidecar (Python HTTP on 127.0.0.1).
//! Edge TTS remains the default — this engine is opt-in after `pnpm voxcpm:setup`.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

const DEFAULT_PORT: u16 = 18765;
const HEALTH_PATH: &str = "/health";

static SERVER_STARTED: AtomicBool = AtomicBool::new(false);
static CHILD: Mutex<Option<Child>> = Mutex::new(None);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoxcpmSynthesizeArgs {
	pub text: String,
	pub cue_id: String,
	/// Natural-language voice design prompt (VoxCPM2 parentheses style).
	#[serde(default)]
	pub voice_prompt: String,
	/// Optional reference WAV for stable voice cloning (VoxCPM2).
	#[serde(default)]
	pub reference_wav_path: String,
	#[serde(default = "default_cfg")]
	pub cfg: f64,
	#[serde(default = "default_timesteps")]
	pub timesteps: u32,
}

fn default_cfg() -> f64 {
	2.5
}
fn default_timesteps() -> u32 {
	10
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoxcpmSynthesizeResult {
	pub file_path: String,
	pub voice: String,
	pub byte_length: usize,
	pub engine: String,
	pub duration_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoxcpmStatus {
	pub setup_ready: bool,
	pub server_running: bool,
	pub model_loaded: bool,
	/// True when openbmb/VoxCPM2 weights are already on disk (no Hub download needed).
	pub weights_cached: bool,
	pub loading: bool,
	pub load_progress: u32,
	pub load_stage: String,
	pub model: String,
	pub port: u16,
	pub message: String,
}

fn project_root() -> PathBuf {
	PathBuf::from(env!("CARGO_MANIFEST_DIR"))
		.parent()
		.map(|p| p.to_path_buf())
		.unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")))
}

fn port() -> u16 {
	std::env::var("PDP_VOXCPM_PORT")
		.ok()
		.and_then(|s| s.trim().parse().ok())
		.unwrap_or(DEFAULT_PORT)
}

fn find_script(app: &AppHandle) -> Result<PathBuf, String> {
	let mut candidates: Vec<PathBuf> = Vec::new();
	candidates.push(project_root().join("scripts").join("tts").join("voxcpm_server.py"));
	if let Ok(resource) = app.path().resource_dir() {
		candidates.push(resource.join("scripts").join("tts").join("voxcpm_server.py"));
		candidates.push(resource.join("voxcpm_server.py"));
	}
	if let Ok(exe) = std::env::current_exe() {
		if let Some(dir) = exe.parent() {
			candidates.push(dir.join("scripts").join("tts").join("voxcpm_server.py"));
		}
	}
	for p in &candidates {
		if p.is_file() {
			return Ok(p.clone());
		}
	}
	Err("VoxCPM script not found (scripts/tts/voxcpm_server.py).\nRun: pnpm voxcpm:setup".into())
}

fn find_python() -> Result<PathBuf, String> {
	if let Ok(custom) = std::env::var("PDP_VOXCPM_PYTHON") {
		let p = PathBuf::from(custom.trim());
		if p.is_file() {
			return Ok(p);
		}
	}
	let root = project_root();
	#[cfg(windows)]
	let venv_py = root.join(".venv-voxcpm").join("Scripts").join("python.exe");
	#[cfg(not(windows))]
	let venv_py = root.join(".venv-voxcpm").join("bin").join("python");
	if venv_py.is_file() {
		return Ok(venv_py);
	}
	Err(
		"VoxCPM Python venv not found (.venv-voxcpm).\nRun once: pnpm voxcpm:setup\nNeeds NVIDIA GPU; Edge TTS stays available without setup."
			.into(),
	)
}

fn setup_ready() -> bool {
	let root = project_root();
	#[cfg(windows)]
	let py = root.join(".venv-voxcpm").join("Scripts").join("python.exe");
	#[cfg(not(windows))]
	let py = root.join(".venv-voxcpm").join("bin").join("python");
	let marker = root.join(".venv-voxcpm").join(".pdp-voxcpm-ready");
	py.is_file() && marker.is_file()
}

fn hf_hub_cache_root() -> PathBuf {
	if let Ok(custom) = std::env::var("HF_HUB_CACHE") {
		let p = PathBuf::from(custom.trim());
		if !p.as_os_str().is_empty() {
			return p;
		}
	}
	let home = std::env::var_os("USERPROFILE")
		.or_else(|| std::env::var_os("HOME"))
		.map(PathBuf::from)
		.unwrap_or_else(|| PathBuf::from("."));
	home.join(".cache").join("huggingface").join("hub")
}

/// Detect a complete local VoxCPM2 snapshot (avoids misleading "first download" UI).
fn weights_cached() -> bool {
	let model = std::env::var("PDP_VOXCPM_MODEL").unwrap_or_else(|_| "openbmb/VoxCPM2".into());
	if PathBuf::from(&model).join("model.safetensors").is_file() {
		return true;
	}
	let repo_dir = format!("models--{}", model.replace('/', "--"));
	let snapshots = hf_hub_cache_root().join(repo_dir).join("snapshots");
	let Ok(entries) = fs::read_dir(&snapshots) else {
		return false;
	};
	for entry in entries.flatten() {
		let weights = entry.path().join("model.safetensors");
		if !weights.exists() {
			continue;
		}
		// Symlinks report 0 bytes on Windows — follow to the blob.
		match fs::canonicalize(&weights).and_then(|p| fs::metadata(p)) {
			Ok(meta) if meta.len() >= 100_000_000 => return true,
			_ => continue,
		}
	}
	false
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

fn http_json(method: &str, path: &str, body: Option<&str>) -> Result<(u16, String), String> {
	let p = port();
	let addr = format!("127.0.0.1:{p}");
	let mut stream = TcpStream::connect(&addr).map_err(|e| {
		format!("VoxCPM server not reachable on {addr} ({e}). Start it from Voice & Mix, or run setup.")
	})?;
	stream
		.set_read_timeout(Some(Duration::from_secs(600)))
		.ok();
	stream
		.set_write_timeout(Some(Duration::from_secs(30)))
		.ok();

	let body_bytes = body.unwrap_or("").as_bytes();
	let mut req = format!(
		"{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{p}\r\nConnection: close\r\n"
	);
	if method == "POST" {
		req.push_str("Content-Type: application/json\r\n");
		req.push_str(&format!("Content-Length: {}\r\n", body_bytes.len()));
	}
	req.push_str("\r\n");
	stream
		.write_all(req.as_bytes())
		.map_err(|e| format!("VoxCPM request write failed: {e}"))?;
	if !body_bytes.is_empty() {
		stream
			.write_all(body_bytes)
			.map_err(|e| format!("VoxCPM body write failed: {e}"))?;
	}

	let mut reader = BufReader::new(stream);
	let mut status_line = String::new();
	reader
		.read_line(&mut status_line)
		.map_err(|e| format!("VoxCPM response failed: {e}"))?;
	let code = status_line
		.split_whitespace()
		.nth(1)
		.and_then(|s| s.parse::<u16>().ok())
		.unwrap_or(0);

	// Skip headers
	loop {
		let mut line = String::new();
		reader
			.read_line(&mut line)
			.map_err(|e| format!("VoxCPM headers failed: {e}"))?;
		if line == "\r\n" || line == "\n" || line.is_empty() {
			break;
		}
	}
	let mut resp_body = String::new();
	reader
		.read_to_string(&mut resp_body)
		.map_err(|e| format!("VoxCPM body read failed: {e}"))?;
	Ok((code, resp_body))
}

fn health_ok() -> Option<serde_json::Value> {
	match http_json("GET", HEALTH_PATH, None) {
		Ok((200, body)) => serde_json::from_str(&body).ok(),
		_ => None,
	}
}

/// PIDs listening on our sidecar port (orphans survive app restart).
fn pids_listening_on_port(port: u16) -> Vec<u32> {
	let Ok(out) = Command::new("netstat").args(["-ano"]).output() else {
		return Vec::new();
	};
	let text = String::from_utf8_lossy(&out.stdout);
	let needle = format!(":{}", port);
	let mut pids = Vec::new();
	for line in text.lines() {
		let lower = line.to_ascii_lowercase();
		if !lower.contains("listening") || !line.contains(&needle) {
			continue;
		}
		// Only local listeners (127.0.0.1 / 0.0.0.0 / [::1] / [::])
		if !(line.contains("127.0.0.1")
			|| line.contains("0.0.0.0")
			|| line.contains("[::1]")
			|| line.contains("[::]"))
		{
			continue;
		}
		if let Some(pid_str) = line.split_whitespace().last() {
			if let Ok(pid) = pid_str.parse::<u32>() {
				if pid > 0 && !pids.contains(&pid) {
					pids.push(pid);
				}
			}
		}
	}
	pids
}

fn kill_pids(pids: &[u32]) {
	for pid in pids {
		#[cfg(windows)]
		{
			let _ = Command::new("taskkill")
				.args(["/F", "/PID", &pid.to_string()])
				.stdout(Stdio::null())
				.stderr(Stdio::null())
				.status();
		}
		#[cfg(not(windows))]
		{
			let _ = Command::new("kill")
				.args(["-9", &pid.to_string()])
				.stdout(Stdio::null())
				.stderr(Stdio::null())
				.status();
		}
	}
}

fn reclaim_port_if_unhealthy(port: u16) {
	if health_ok().is_some() {
		return;
	}
	let pids = pids_listening_on_port(port);
	if pids.is_empty() {
		return;
	}
	log::warn!(
		"[voxcpm] Port {port} held by stale PID(s) {pids:?} — reclaiming so a fresh server can start"
	);
	kill_pids(&pids);
	thread::sleep(Duration::from_millis(500));
}

fn spawn_server(app: &AppHandle) -> Result<(), String> {
	let p = port();
	if health_ok().is_some() {
		SERVER_STARTED.store(true, Ordering::SeqCst);
		return Ok(());
	}
	// App restart leaves orphan Python holding :18765 but not answering /health.
	reclaim_port_if_unhealthy(p);

	let python = find_python()?;
	let script = find_script(app)?;
	let root = project_root();

	// Prefer a relative script path so spaces in the project folder
	// (e.g. `D:\My Project\...`) cannot break Windows process spawning.
	let script_arg: PathBuf = script
		.strip_prefix(&root)
		.map(|rel| rel.to_path_buf())
		.unwrap_or_else(|_| script.clone());

	let mut cmd = Command::new(&python);
	cmd.arg("-u")
		.arg(&script_arg)
		.current_dir(&root)
		.env("PDP_VOXCPM_PORT", p.to_string())
		.env("PYTHONUNBUFFERED", "1")
		.env("HF_HUB_DISABLE_PROGRESS_BARS", "0")
		.env("TQDM_MININTERVAL", "1")
		.stdout(Stdio::piped())
		.stderr(Stdio::piped());

	for key in ["HF_TOKEN", "HUGGING_FACE_HUB_TOKEN", "HF_HUB_TOKEN"] {
		if let Ok(val) = std::env::var(key) {
			if !val.trim().is_empty() {
				cmd.env(key, val);
			}
		}
	}
	if std::env::var("HF_HUB_DISABLE_XET").is_err() {
		cmd.env("HF_HUB_DISABLE_XET", "1");
	}

	#[cfg(windows)]
	{
		use std::os::windows::process::CommandExt;
		const CREATE_NO_WINDOW: u32 = 0x0800_0000;
		cmd.creation_flags(CREATE_NO_WINDOW);
	}

	let mut child = cmd
		.spawn()
		.map_err(|e| format!("Failed to start VoxCPM server: {e}\nPython: {python:?}"))?;

	if let Some(out) = child.stdout.take() {
		thread::spawn(move || {
			let reader = BufReader::new(out);
			for line in reader.lines().flatten() {
				log::info!("[voxcpm] {line}");
			}
		});
	}
	if let Some(err) = child.stderr.take() {
		thread::spawn(move || {
			let reader = BufReader::new(err);
			for line in reader.lines().flatten() {
				log::warn!("[voxcpm] {line}");
			}
		});
	}

	{
		let mut guard = CHILD.lock().map_err(|_| "VoxCPM process lock poisoned".to_string())?;
		*guard = Some(child);
	}
	SERVER_STARTED.store(true, Ordering::SeqCst);

	// Server should answer /health in seconds (import torch at startup can be slow).
	let deadline = Instant::now() + Duration::from_secs(180);
	while Instant::now() < deadline {
		if health_ok().is_some() {
			return Ok(());
		}
		{
			let mut guard = CHILD.lock().map_err(|_| "VoxCPM process lock poisoned".to_string())?;
			if let Some(child) = guard.as_mut() {
				if let Ok(Some(status)) = child.try_wait() {
					*guard = None;
					SERVER_STARTED.store(false, Ordering::SeqCst);
					return Err(format!(
						"VoxCPM server exited immediately ({status}). Check that `pnpm voxcpm:setup` completed and Python can import voxcpm."
					));
				}
			}
		}
		thread::sleep(Duration::from_millis(400));
	}
	let _ = stop_server_inner();
	Err(format!(
		"VoxCPM server did not become healthy on 127.0.0.1:{p} within 180s.\n\
		 Try Unload, then: taskkill /F /IM python.exe\n\
		 Restart the app and click Start / Load Model again."
	))
}

fn stop_server_inner() -> Result<(), String> {
	let _ = http_json("POST", "/unload", Some("{}"));
	let mut guard = CHILD.lock().map_err(|_| "VoxCPM process lock poisoned".to_string())?;
	if let Some(mut child) = guard.take() {
		let _ = child.kill();
		let _ = child.wait();
	}
	// Also clear orphans from a previous app session.
	kill_pids(&pids_listening_on_port(port()));
	SERVER_STARTED.store(false, Ordering::SeqCst);
	Ok(())
}

fn wait_until_model_loaded() -> Result<(), String> {
	let deadline = Instant::now() + Duration::from_secs(600);
	while Instant::now() < deadline {
		match health_ok() {
			Some(h) => {
				if h.get("loaded").and_then(|v| v.as_bool()) == Some(true) {
					return Ok(());
				}
				if let Some(err) = h.get("loadError").and_then(|v| v.as_str()) {
					if !err.is_empty() {
						return Err(err.to_string());
					}
				}
			}
			None => {
				return Err(
					"VoxCPM server stopped responding during model load. Click Unload, then Load Model again."
						.into(),
				);
			}
		}
		thread::sleep(Duration::from_secs(2));
	}
	Err(
		"Timed out waiting for VoxCPM to finish loading into VRAM (10 min).\n\
		 Weights may already be on disk — this step is GPU load, not download."
			.into(),
	)
}

fn synthesize_blocking(
	app: &AppHandle,
	args: VoxcpmSynthesizeArgs,
) -> Result<VoxcpmSynthesizeResult, String> {
	let text = args.text.trim();
	if text.is_empty() {
		return Err("Subtitle text is empty — nothing to speak.".into());
	}
	spawn_server(app)?;

	let dir = tts_dir(app)?;
	let stem = sanitize_filename(&args.cue_id);
	let out = dir.join(format!("{stem}_{}.wav", Uuid::new_v4()));

	let body = serde_json::json!({
		"text": text,
		"voicePrompt": args.voice_prompt,
		"referenceWavPath": args.reference_wav_path,
		"outPath": out.to_string_lossy(),
		"cfg": args.cfg,
		"timesteps": args.timesteps,
	});
	let (code, resp) = http_json("POST", "/synthesize", Some(&body.to_string()))?;
	let parsed: serde_json::Value =
		serde_json::from_str(&resp).map_err(|e| format!("Bad VoxCPM JSON: {e}\n{resp}"))?;
	if code >= 400 || parsed.get("ok") == Some(&serde_json::Value::Bool(false)) {
		let err = parsed
			.get("error")
			.and_then(|v| v.as_str())
			.unwrap_or("VoxCPM synthesize failed");
		return Err(err.to_string());
	}

	let file_path = parsed
		.get("filePath")
		.and_then(|v| v.as_str())
		.unwrap_or_else(|| out.to_str().unwrap_or(""))
		.to_string();
	if !Path::new(&file_path).is_file() {
		return Err("VoxCPM did not write an audio file.".into());
	}
	let byte_length = parsed
		.get("byteLength")
		.and_then(|v| v.as_u64())
		.unwrap_or_else(|| fs::metadata(&file_path).map(|m| m.len()).unwrap_or(0))
		as usize;
	let duration_ms = parsed
		.get("durationMs")
		.and_then(|v| v.as_u64())
		.unwrap_or(0);
	let voice = if args.voice_prompt.trim().is_empty() {
		"VoxCPM2".to_string()
	} else {
		args.voice_prompt.trim().chars().take(48).collect()
	};

	Ok(VoxcpmSynthesizeResult {
		file_path,
		voice,
		byte_length,
		engine: "voxcpm".into(),
		duration_ms,
	})
}

#[tauri::command]
pub async fn voxcpm_status() -> Result<VoxcpmStatus, String> {
	let ready = setup_ready();
	let health = health_ok();
	let running = health.is_some() || SERVER_STARTED.load(Ordering::SeqCst);
	let loaded = health
		.as_ref()
		.and_then(|h| h.get("loaded"))
		.and_then(|v| v.as_bool())
		.unwrap_or(false);
	let loading = health
		.as_ref()
		.and_then(|h| h.get("loading"))
		.and_then(|v| v.as_bool())
		.unwrap_or(false);
	let load_progress = health
		.as_ref()
		.and_then(|h| h.get("loadProgress"))
		.and_then(|v| v.as_u64())
		.unwrap_or(0) as u32;
	let load_stage = health
		.as_ref()
		.and_then(|h| h.get("loadStage"))
		.and_then(|v| v.as_str())
		.unwrap_or(if loaded {
			"ready"
		} else if loading {
			"loading"
		} else {
			"idle"
		})
		.to_string();
	let model = health
		.as_ref()
		.and_then(|h| h.get("model"))
		.and_then(|v| v.as_str())
		.unwrap_or("openbmb/VoxCPM2")
		.to_string();
	let cached = weights_cached()
		|| health
			.as_ref()
			.and_then(|h| h.get("cached"))
			.and_then(|v| v.as_bool())
			.unwrap_or(false);
	let message = if !ready {
		"Not set up — run: pnpm voxcpm:setup".into()
	} else if !running {
		if cached {
			"Ready — weights cached locally. Click Start to load into VRAM.".into()
		} else {
			"Ready — click Start (first run may download ~5GB).".into()
		}
	} else if loaded {
		"Running · model loaded — click Stop to free VRAM".into()
	} else if loading {
		format!("Loading… {load_stage} ({load_progress}%)")
	} else if cached {
		"Server up · weights on disk — finishing load…".into()
	} else {
		"Server up · waiting for model…".into()
	};
	Ok(VoxcpmStatus {
		setup_ready: ready,
		server_running: running,
		model_loaded: loaded,
		weights_cached: cached,
		loading,
		load_progress,
		load_stage,
		model,
		port: port(),
		message,
	})
}

#[tauri::command]
pub async fn start_voxcpm_server(app: AppHandle) -> Result<VoxcpmStatus, String> {
	tauri::async_runtime::spawn_blocking(move || spawn_server(&app))
		.await
		.map_err(|e| format!("VoxCPM start task failed: {e}"))??;
	voxcpm_status().await
}

#[tauri::command]
pub async fn stop_voxcpm_server() -> Result<VoxcpmStatus, String> {
	tauri::async_runtime::spawn_blocking(stop_server_inner)
		.await
		.map_err(|e| format!("VoxCPM stop task failed: {e}"))??;
	voxcpm_status().await
}

#[tauri::command]
pub async fn load_voxcpm_model(app: AppHandle) -> Result<VoxcpmStatus, String> {
	tauri::async_runtime::spawn_blocking(move || {
		spawn_server(&app)?;
		let (code, resp) = http_json("POST", "/load", Some("{}"))?;
		if code >= 400 {
			let parsed: serde_json::Value = serde_json::from_str(&resp).unwrap_or_default();
			let err = parsed
				.get("error")
				.and_then(|v| v.as_str())
				.unwrap_or(&resp);
			return Err(err.to_string());
		}
		// /load returns immediately; poll /health until VRAM load finishes.
		wait_until_model_loaded()?;
		Ok(())
	})
	.await
	.map_err(|e| format!("VoxCPM load task failed: {e}"))??;
	voxcpm_status().await
}

#[tauri::command]
pub async fn synthesize_voxcpm_speech(
	app: AppHandle,
	args: VoxcpmSynthesizeArgs,
) -> Result<VoxcpmSynthesizeResult, String> {
	tauri::async_runtime::spawn_blocking(move || synthesize_blocking(&app, args))
		.await
		.map_err(|e| format!("VoxCPM synthesize task failed: {e}"))?
}
