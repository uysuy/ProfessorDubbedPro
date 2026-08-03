export type DesktopPlatform = 'macos' | 'windows' | 'linux' | 'unknown';

/** Best-effort platform detection for Tauri webviews and browsers. */
export function detectPlatform(): DesktopPlatform {
	const nav = typeof navigator !== 'undefined' ? navigator : undefined;
	const ua = (nav?.userAgent ?? '').toLowerCase();
	const platform = (nav?.platform ?? '').toLowerCase();

	if (platform.includes('mac') || ua.includes('mac os') || ua.includes('macintosh')) {
		return 'macos';
	}
	if (platform.includes('linux') || ua.includes('linux')) {
		return 'linux';
	}
	if (platform.includes('win') || ua.includes('windows')) {
		return 'windows';
	}
	return 'unknown';
}

export function isTauriRuntime(): boolean {
	return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}
