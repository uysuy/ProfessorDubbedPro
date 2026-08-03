fn main() {
	// Used by export.rs to locate the platform-specific bundled FFmpeg sidecar.
	if let Ok(target) = std::env::var("TARGET") {
		println!("cargo:rustc-env=TAURI_ENV_TARGET_TRIPLE={target}");
	} else if let Ok(triple) = std::env::var("TAURI_ENV_TARGET_TRIPLE") {
		println!("cargo:rustc-env=TAURI_ENV_TARGET_TRIPLE={triple}");
	}

	tauri_build::build()
}
