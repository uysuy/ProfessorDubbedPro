/**
 * High-frequency playhead clock for visuals.
 * Intentionally NOT Svelte $state — updating $state every frame
 * re-rendered the timeline and made video playback feel ~0.5×.
 */

let visualMs = 0;
/** One-shot seek request for the program monitor (<video>). */
let mediaSeekMs: number | null = null;
/** True while the user is dragging the timeline playhead. */
let timelineScrubbing = false;

type MediaSeekListener = (ms: number) => void;
type ScrubListener = (active: boolean) => void;

const mediaSeekListeners = new Set<MediaSeekListener>();
const scrubListeners = new Set<ScrubListener>();

export function getVisualPlayheadMs(): number {
	return visualMs;
}

export function setVisualPlayheadMs(ms: number, opts?: { seekMedia?: boolean }) {
	visualMs = Math.max(0, ms);
	if (opts?.seekMedia) {
		mediaSeekMs = visualMs;
		for (const listener of mediaSeekListeners) listener(visualMs);
	}
}

/** Take and clear a pending media seek (VideoPreview rAF / play start). */
export function consumeMediaSeekMs(): number | null {
	const next = mediaSeekMs;
	mediaSeekMs = null;
	return next;
}

/**
 * Subscribe to timeline/program seek requests without Svelte reactivity.
 * Used so VideoPreview can follow scrubbing at pointer rate while paused.
 */
export function onMediaSeekRequest(listener: MediaSeekListener): () => void {
	mediaSeekListeners.add(listener);
	return () => {
		mediaSeekListeners.delete(listener);
	};
}

export function isTimelineScrubbing(): boolean {
	return timelineScrubbing;
}

export function setTimelineScrubbing(active: boolean) {
	const next = Boolean(active);
	if (timelineScrubbing === next) return;
	timelineScrubbing = next;
	for (const listener of scrubListeners) listener(next);
}

export function onTimelineScrubbing(listener: ScrubListener): () => void {
	scrubListeners.add(listener);
	return () => {
		scrubListeners.delete(listener);
	};
}
