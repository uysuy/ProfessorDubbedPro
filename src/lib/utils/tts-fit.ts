/**
 * Fit TTS speech to the video subtitle window (lip sync).
 *
 * Modes:
 * - `lipsync` (default): mild speed-up only (listenable). If Khmer is still longer
 *   than the Chinese window, extend the cue instead of chipmunk-speed speech.
 * - `preserve`: milder rate change; if still long, extend the cue.
 *
 * Why speeds used to feel random: short windows with long Khmer got Edge 2×
 * *and* Web Audio ~1.85× (~3.7×). Longer windows barely sped up. Caps below
 * keep every line near a natural listening pace.
 */

export type TtsFitMode = 'lipsync' | 'preserve';

/**
 * Max Edge TTS speed in lip-sync mode (absolute multiplier).
 * Above ~1.3× Khmer becomes hard to follow for most listeners.
 */
export const TTS_FIT_MAX_SPEEDUP_LIPSYNC = 1.28;
/** Milder Edge speed-up when preserving natural speech. */
export const TTS_FIT_MAX_SPEEDUP_PRESERVE = 1.32;
/** Max slow-down vs the user’s chosen rate. */
export const TTS_FIT_MAX_SLOWDOWN = 0.88;
/** Within this ratio of the window, keep the first pass (no re-synth). */
export const TTS_FIT_TOLERANCE = 0.08;
/** Ignore tiny overflows (ms) before treating as mismatch. */
export const TTS_FIT_END_PAD_MS = 60;
/**
 * Extra Web Audio squeeze after Edge (lip-sync residual).
 * Kept gentle — heavy playbackRate sounds worse than a slightly longer cue.
 */
export const TTS_FIT_MAX_PLAYBACK = 1.15;
/** Combined Edge × Web Audio soft ceiling used when deciding to extend. */
export const TTS_FIT_MAX_EFFECTIVE = 1.4;

export type TtsFitPlan = {
	/** Speed to use for (re)synthesis. */
	speed: number;
	/** True when a second synthesize pass is recommended. */
	needsResynth: boolean;
	/** After audio is ready, cue end should be at least this (lipsync = window end). */
	targetEndMs: number;
	/** Whether the cue end should grow past the original subtitle window. */
	extendsCue: boolean;
	reason: 'fits' | 'speedup' | 'slowdown' | 'extend' | 'lipsync';
};

function clampSpeed(speed: number, max = 2): number {
	return Math.max(0.5, Math.min(max, Number(speed.toFixed(3))));
}

/**
 * Plan how to fit `naturalDurationMs` (first-pass TTS length) into `[startMs, endMs]`.
 */
export function planTtsFit(opts: {
	startMs: number;
	endMs: number;
	naturalDurationMs: number;
	baseSpeed: number;
	mode?: TtsFitMode;
}): TtsFitPlan {
	const mode: TtsFitMode = opts.mode ?? 'lipsync';
	const startMs = Math.max(0, Math.round(opts.startMs));
	const windowMs = Math.max(200, Math.round(opts.endMs) - startMs);
	const naturalMs = Math.max(120, Math.round(opts.naturalDurationMs));
	const maxSpeed = mode === 'lipsync' ? TTS_FIT_MAX_SPEEDUP_LIPSYNC : TTS_FIT_MAX_SPEEDUP_PRESERVE;
	const baseSpeed = clampSpeed(opts.baseSpeed || 1, maxSpeed);
	const windowEnd = startMs + windowMs;

	const ratio = naturalMs / windowMs; // >1 = audio longer than subtitle window

	// Close enough — keep natural speech.
	if (ratio <= 1 + TTS_FIT_TOLERANCE && ratio >= 1 - TTS_FIT_TOLERANCE) {
		const audioEnd = startMs + naturalMs;
		return {
			speed: baseSpeed,
			needsResynth: false,
			targetEndMs: mode === 'lipsync' ? windowEnd : Math.max(windowEnd, audioEnd),
			extendsCue: mode === 'preserve' && audioEnd > windowEnd + TTS_FIT_END_PAD_MS,
			reason: 'fits'
		};
	}

	// Too long — speed up (listenably), then extend if still needed.
	if (ratio > 1 + TTS_FIT_TOLERANCE) {
		if (mode === 'lipsync') {
			// Only mild Edge speed-up. Residual either soft Web Audio or cue extend.
			const speed = clampSpeed(Math.min(baseSpeed * ratio, maxSpeed), maxSpeed);
			// First pass was at baseSpeed; after resynth at `speed`, duration scales by base/speed.
			const approxMs = Math.round(naturalMs * (baseSpeed / Math.max(speed, 0.5)));
			const canCoverWithPlayback =
				approxMs <= windowMs * TTS_FIT_MAX_PLAYBACK + TTS_FIT_END_PAD_MS;
			return {
				speed,
				needsResynth: Math.abs(speed - baseSpeed) > 0.03,
				targetEndMs: canCoverWithPlayback
					? windowEnd
					: startMs + Math.max(windowMs, Math.ceil(approxMs / TTS_FIT_MAX_PLAYBACK)),
				extendsCue: !canCoverWithPlayback,
				reason: canCoverWithPlayback ? 'lipsync' : 'extend'
			};
		}

		const maxRel = TTS_FIT_MAX_SPEEDUP_PRESERVE;
		if (ratio <= maxRel) {
			const speed = clampSpeed(baseSpeed * ratio, 1.5);
			return {
				speed,
				needsResynth: Math.abs(speed - baseSpeed) > 0.03,
				targetEndMs: windowEnd,
				extendsCue: false,
				reason: 'speedup'
			};
		}

		const speed = clampSpeed(baseSpeed * maxRel, 1.5);
		const expectedMs = Math.round(naturalMs / maxRel);
		return {
			speed,
			needsResynth: Math.abs(speed - baseSpeed) > 0.03,
			targetEndMs: startMs + Math.max(windowMs, expectedMs),
			extendsCue: true,
			reason: 'extend'
		};
	}

	// Too short — mild slowdown (preserve only); lipsync leaves a gap so timing stays locked.
	if (mode === 'preserve' && ratio >= TTS_FIT_MAX_SLOWDOWN) {
		const speed = clampSpeed(baseSpeed * ratio, 1.5);
		return {
			speed,
			needsResynth: Math.abs(speed - baseSpeed) > 0.03,
			targetEndMs: windowEnd,
			extendsCue: false,
			reason: 'slowdown'
		};
	}

	return {
		speed: baseSpeed,
		needsResynth: false,
		targetEndMs: windowEnd,
		extendsCue: false,
		reason: 'fits'
	};
}

/**
 * Extra Web Audio playback rate so measured TTS finishes inside the video window.
 * 1 = no extra squeeze. Capped so speech stays listenable.
 */
export function computePlaybackFitRate(
	audioDurationMs: number,
	windowMs: number,
	mode: TtsFitMode = 'lipsync'
): number {
	if (mode !== 'lipsync') return 1;
	const window = Math.max(200, Math.round(windowMs));
	const audio = Math.max(120, Math.round(audioDurationMs));
	if (audio <= window + TTS_FIT_END_PAD_MS) return 1;
	const rate = audio / window;
	return Math.max(1, Math.min(TTS_FIT_MAX_PLAYBACK, Number(rate.toFixed(3))));
}

/**
 * Cue end after lip-sync fit: lock to the video window when speech fits at a
 * listenable rate; otherwise extend so the full sentence can be heard.
 */
export function resolveLipSyncEndMs(opts: {
	startMs: number;
	windowEndMs: number;
	audioDurationMs: number;
	fitPlaybackRate: number;
}): { endMs: number; extendsCue: boolean } {
	const startMs = Math.max(0, Math.round(opts.startMs));
	const windowEnd = Math.max(startMs + 200, Math.round(opts.windowEndMs));
	const windowMs = windowEnd - startMs;
	const audio = Math.max(120, Math.round(opts.audioDurationMs));
	const fit = Math.max(1, opts.fitPlaybackRate || 1);
	const playThroughMs = Math.ceil(audio / fit);
	if (playThroughMs <= windowMs + TTS_FIT_END_PAD_MS) {
		return { endMs: windowEnd, extendsCue: false };
	}
	return { endMs: startMs + playThroughMs, extendsCue: true };
}

/** Effective play end aligned to video when lip-synced; otherwise full audio. */
export function cueAudioEndMs(cue: {
	startMs: number;
	endMs: number;
	assignedAudio?: {
		durationMs?: number | null;
		fitPlaybackRate?: number | null;
	} | null;
}): number {
	// Lip-sync generation always stores fitPlaybackRate (>=1) and locks to the cue window
	// when it fits; when the cue was extended, endMs already covers full speech.
	if (
		typeof cue.assignedAudio?.fitPlaybackRate === 'number' &&
		cue.assignedAudio.fitPlaybackRate > 0
	) {
		const dur = cue.assignedAudio.durationMs;
		if (typeof dur === 'number' && dur > 0) {
			const playThrough = Math.ceil(dur / cue.assignedAudio.fitPlaybackRate);
			return Math.max(cue.endMs, cue.startMs + playThrough);
		}
		return cue.endMs;
	}
	const audioDur = cue.assignedAudio?.durationMs;
	if (typeof audioDur === 'number' && audioDur > 0) {
		return Math.max(cue.endMs, cue.startMs + Math.round(audioDur));
	}
	return cue.endMs;
}

/** Combined transport × lip-sync fit rate for Web Audio. */
export function cueEffectivePlaybackRate(
	cue: { assignedAudio?: { fitPlaybackRate?: number | null } | null },
	transportRate = 1
): number {
	const fit =
		typeof cue.assignedAudio?.fitPlaybackRate === 'number' && cue.assignedAudio.fitPlaybackRate > 0
			? cue.assignedAudio.fitPlaybackRate
			: 1;
	// Keep stacked rate listenable even if an old project stored a high fit value.
	const cappedFit = Math.min(fit, TTS_FIT_MAX_PLAYBACK);
	return Math.max(0.5, Math.min(2.0, transportRate * cappedFit));
}
