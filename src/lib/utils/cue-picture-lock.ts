import type { SubtitleCue } from '$lib/types/project';
import { cuePlayThroughMs } from '$lib/utils/tts-fit';
import {
	ALIGN_FALLBACK_TTS_RATE,
	ALIGN_HARD_MIN_TEMPO,
	ALIGN_MAX_TTS_RATE,
	computeFitToDubTempo,
	type FitToDubPlan
} from '$lib/utils/video-tempo';

/** Tiny gap so adjacent cues never overlap after lock. */
export const PICTURE_LOCK_MIN_GAP_MS = 80;

/**
 * Hard cap on timeline stretch (tempo ≥ 0.5). Never plan a remaster longer than 2×
 * or one short CN window will explode the project into empty multi‑minute tails.
 */
export const PICTURE_LOCK_MAX_SCALE = 2;

export type PictureLockCue = Pick<
	SubtitleCue,
	'id' | 'index' | 'startMs' | 'endMs' | 'pictureStartMs' | 'pictureEndMs' | 'assignedAudio'
>;

export type PictureLockPatch = {
	id: string;
	startMs: number;
	endMs: number;
	fitPlaybackRate: number;
};

/** ASR / hardsub window in *source* timeline (never remaster-scaled). */
export function pictureAnchorStart(cue: PictureLockCue): number {
	const v = cue.pictureStartMs;
	if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return Math.round(v);
	return Math.max(0, Math.round(cue.startMs));
}

export function pictureAnchorEnd(cue: PictureLockCue): number {
	const start = pictureAnchorStart(cue);
	const v = cue.pictureEndMs;
	if (typeof v === 'number' && Number.isFinite(v) && v > start) return Math.round(v);
	return Math.max(start + 120, Math.round(cue.endMs));
}

/** Stamp current times as source anchors when missing (Extract / first Align). */
export function withPictureAnchors<T extends PictureLockCue>(cues: T[]): T[] {
	return cues.map((cue) => {
		const startMs = Math.max(0, Math.round(cue.startMs));
		const endMs = Math.max(startMs + 120, Math.round(cue.endMs));
		const hasStart = typeof cue.pictureStartMs === 'number' && Number.isFinite(cue.pictureStartMs);
		const hasEnd = typeof cue.pictureEndMs === 'number' && Number.isFinite(cue.pictureEndMs);
		if (hasStart && hasEnd) return cue;
		return {
			...cue,
			pictureStartMs: hasStart ? Math.round(cue.pictureStartMs!) : startMs,
			pictureEndMs: hasEnd ? Math.round(cue.pictureEndMs!) : endMs
		};
	});
}

function naturalSpeechMs(cue: PictureLockCue): number {
	const dur = cue.assignedAudio?.durationMs;
	if (typeof dur === 'number' && dur > 80) return Math.round(dur);
	return Math.max(200, cuePlayThroughMs(cue as SubtitleCue));
}

function percentile(sorted: number[], p: number): number {
	if (!sorted.length) return 1;
	const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
	return sorted[i]!;
}

/**
 * Timeline scale S (≥1, ≤2) so most Khmer lines fit their hardsub windows.
 * Uses p90 of per-cue ratios — NOT the max — so one short “哈哈哈” window
 * cannot stretch the whole project to 20+ minutes of empty timeline.
 */
export function computePictureLockScale(opts: {
	cues: PictureLockCue[];
	assumeRate?: number;
	minGapMs?: number;
	maxScale?: number;
}): number {
	const cues = [...opts.cues].sort(
		(a, b) => pictureAnchorStart(a) - pictureAnchorStart(b) || a.index - b.index
	);
	if (!cues.length) return 1;
	const rate = Math.max(1, opts.assumeRate ?? 1);
	const minGap = Math.max(0, opts.minGapMs ?? PICTURE_LOCK_MIN_GAP_MS);
	const maxScale = Math.max(1, Math.min(4, opts.maxScale ?? PICTURE_LOCK_MAX_SCALE));
	const ratios: number[] = [];

	for (let i = 0; i < cues.length; i++) {
		const cue = cues[i]!;
		const start = pictureAnchorStart(cue);
		const hardEnd = pictureAnchorEnd(cue);
		const window = Math.max(120, hardEnd - start);
		const speech = naturalSpeechMs(cue) / rate;
		ratios.push(speech / window);

		const next = cues[i + 1];
		if (next) {
			const nextStart = pictureAnchorStart(next);
			const span = Math.max(120, nextStart - start);
			ratios.push((speech + minGap) / span);
		}
	}

	ratios.sort((a, b) => a - b);
	const S = Math.max(1, percentile(ratios, 0.9));
	return Math.min(maxScale, S);
}

/** Target remastered length ≈ videoMs × S (capped). */
export function pictureLockContentMs(videoMs: number, cues: PictureLockCue[]): number {
	const S = computePictureLockScale({ cues, assumeRate: 1 });
	return Math.max(videoMs, Math.round(videoMs * S));
}

export function computePictureLockPlan(opts: {
	videoMs: number;
	cues: PictureLockCue[];
}): FitToDubPlan {
	const videoMs = Math.max(0, Math.round(opts.videoMs));
	const contentMs = pictureLockContentMs(videoMs, opts.cues);
	return computeFitToDubTempo({
		videoMs,
		contentMs,
		maxTtsRate: ALIGN_FALLBACK_TTS_RATE,
		preferredMinTempo: ALIGN_HARD_MIN_TEMPO
	});
}

/**
 * Map source hardsub anchors → current timeline using cumulative media tempo
 * (`start = anchor / mediaTempoFromSource`). Keep short holds; never start the
 * next line before its hardsub; do not invent multi-minute empty gaps.
 */
export function planPictureLockPatches(
	cues: PictureLockCue[],
	opts?: {
		maxRate?: number;
		minGapMs?: number;
		/** Product of remasters since Extract (1 = source). */
		mediaTempoFromSource?: number;
		/** Remastered / current picture length — clamp last end to this. */
		mediaDurationMs?: number;
	}
): PictureLockPatch[] {
	const maxRate = Math.max(1, Math.min(1.5, opts?.maxRate ?? ALIGN_MAX_TTS_RATE));
	const minGap = Math.max(0, opts?.minGapMs ?? PICTURE_LOCK_MIN_GAP_MS);
	const tempo = Math.max(0.25, Math.min(2, opts?.mediaTempoFromSource ?? 1));
	const mediaMs =
		typeof opts?.mediaDurationMs === 'number' && opts.mediaDurationMs > 500
			? Math.round(opts.mediaDurationMs)
			: Number.POSITIVE_INFINITY;

	const sorted = [...cues].sort(
		(a, b) => pictureAnchorStart(a) - pictureAnchorStart(b) || a.index - b.index
	);
	const patches: PictureLockPatch[] = [];

	for (let i = 0; i < sorted.length; i++) {
		const cue = sorted[i]!;
		const startMs = Math.max(0, Math.round(pictureAnchorStart(cue) / tempo));
		const hardEnd = Math.max(startMs + 120, Math.round(pictureAnchorEnd(cue) / tempo));
		const next = sorted[i + 1];
		const nextStart = next
			? Math.max(0, Math.round(pictureAnchorStart(next) / tempo))
			: Number.POSITIVE_INFINITY;
		const maxEnd = Number.isFinite(nextStart)
			? Math.max(startMs + 120, Math.round(nextStart) - minGap)
			: Math.min(
					mediaMs - 40,
					startMs + Math.max(hardEnd - startMs, naturalSpeechMs(cue) * 2)
				);

		const natural = naturalSpeechMs(cue);
		const hardWindow = Math.max(120, hardEnd - startMs);

		let fitPlaybackRate = 1;
		let endMs: number;

		if (natural <= hardWindow + 40) {
			// Short speech in a longer hardsub hold (哈哈哈) — keep subtitle with CN/EN.
			endMs = Math.min(maxEnd, Math.max(hardEnd, startMs + natural));
			fitPlaybackRate = 1;
		} else if (natural <= maxEnd - startMs + 40) {
			endMs = Math.min(maxEnd, startMs + natural);
			fitPlaybackRate = 1;
		} else {
			const avail = Math.max(200, maxEnd - startMs);
			fitPlaybackRate =
				Math.round(Math.min(maxRate, Math.max(1, natural / avail)) * 1000) / 1000;
			endMs = Math.min(maxEnd, startMs + Math.max(200, Math.ceil(natural / fitPlaybackRate)));
		}

		if (Number.isFinite(mediaMs)) {
			endMs = Math.min(endMs, Math.max(startMs + 120, mediaMs - 20));
		}

		patches.push({
			id: cue.id,
			startMs,
			endMs: Math.max(startMs + 120, endMs),
			fitPlaybackRate
		});
	}

	return patches;
}
