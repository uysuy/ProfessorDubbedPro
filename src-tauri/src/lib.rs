use tauri::Manager;

mod asr_funasr;
mod export;
mod fonts;
mod media_tempo;
mod speakers;
mod transcribe;
mod translate;
mod tts;
mod tts_voxcpm;

/// reqwest + msedge-tts both use rustls. If aws-lc-rs and ring are both linked,
/// rustls 0.23 panics unless a process-level CryptoProvider is installed first.
fn install_rustls_crypto_provider() {
	static ONCE: std::sync::Once = std::sync::Once::new();
	ONCE.call_once(|| {
		let _ = rustls::crypto::ring::default_provider().install_default();
	});
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
	install_rustls_crypto_provider();

	tauri::Builder::default()
		.plugin(tauri_plugin_dialog::init())
		.plugin(tauri_plugin_fs::init())
		.invoke_handler(tauri::generate_handler![
			export::export_project,
			export::begin_staged_file,
			export::append_staged_file,
			export::cleanup_staged_file,
			fonts::list_system_fonts,
			media_tempo::remaster_video_tempo,
			media_tempo::cancel_video_tempo,
			tts::synthesize_speech,
			tts::list_edge_voices,
			tts_voxcpm::voxcpm_status,
			tts_voxcpm::start_voxcpm_server,
			tts_voxcpm::stop_voxcpm_server,
			tts_voxcpm::load_voxcpm_model,
			tts_voxcpm::synthesize_voxcpm_speech,
			transcribe::transcribe_video,
			transcribe::cancel_transcription,
			translate::translate_texts,
			speakers::detect_speakers,
			speakers::save_speaker_lock_wav,
		])
		.setup(|app| {
			if cfg!(debug_assertions) {
				app.handle().plugin(
					tauri_plugin_log::Builder::default()
						.level(log::LevelFilter::Info)
						.build(),
				)?;
			}

			// Keep focus on the main window at launch for keyboard navigation.
			if let Some(window) = app.get_webview_window("main") {
				let _ = window.set_focus();
			}

			Ok(())
		})
		.run(tauri::generate_context!())
		.expect("error while running tauri application");
}