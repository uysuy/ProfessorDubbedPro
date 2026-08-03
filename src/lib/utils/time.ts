export function pad2(value: number): string {
	return String(Math.floor(value)).padStart(2, '0');
}

/** Format milliseconds as HH:MM:SS:FF at the given frame rate. */
export function formatTimecode(ms: number, fps = 24): string {
	const totalSeconds = Math.max(0, ms) / 1000;
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = Math.floor(totalSeconds % 60);
	const frames = Math.floor((totalSeconds % 1) * fps);

	return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}:${pad2(frames)}`;
}

export function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}:${pad2(seconds)}`;
}

/** Compact player clock — H:MM:SS when needed, otherwise MM:SS. */
export function formatClock(ms: number, showHours = false): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (showHours || hours > 0) {
		return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
	}
	return `${pad2(minutes)}:${pad2(seconds)}`;
}

/**
 * Parse HH:MM:SS:FF or MM:SS:FF or SS:FF into milliseconds.
 * Returns null when the value cannot be parsed.
 */
export function parseTimecode(value: string, fps = 24): number | null {
	const parts = value
		.trim()
		.split(':')
		.map((part) => Number(part));
	if (parts.some((n) => Number.isNaN(n) || n < 0)) return null;

	let hours = 0;
	let minutes = 0;
	let seconds = 0;
	let frames = 0;

	if (parts.length === 4) {
		[hours, minutes, seconds, frames] = parts;
	} else if (parts.length === 3) {
		[minutes, seconds, frames] = parts;
	} else if (parts.length === 2) {
		[seconds, frames] = parts;
	} else {
		return null;
	}

	const safeFps = Math.max(1, fps);
	return ((hours * 3600 + minutes * 60 + seconds) * 1000) + (frames / safeFps) * 1000;
}
