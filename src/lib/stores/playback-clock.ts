/**
 * High-frequency playhead clock for visuals.
 * Intentionally NOT Svelte $state — updating $state every frame
 * re-rendered the timeline and made video playback feel ~0.5×.
 */

let visualMs = 0;
/** One-shot seek request for the program monitor (<video>). */
let mediaSeekMs: number | null = null;

export function getVisualPlayheadMs(): number {
	return visualMs;
}

export function setVisualPlayheadMs(ms: number, opts?: { seekMedia?: boolean }) {
	visualMs = Math.max(0, ms);
	if (opts?.seekMedia) {
		mediaSeekMs = visualMs;
	}
}

/** Take and clear a pending media seek (VideoPreview rAF / play start). */
export function consumeMediaSeekMs(): number | null {
	const next = mediaSeekMs;
	mediaSeekMs = null;
	return next;
}
