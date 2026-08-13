/**
 * Smart Align / Sync planner.
 *
 * Goals:
 * - Keep original subtitle starts (picture anchors) when Khmer fits.
 * - Always keep natural TTS rate/pitch (never auto-speed speech).
 * - Long Khmer → expand gaps and/or pitch-safe video extend.
 * - Prosody pitch/speed change only when the user sets them manually.
 * - Never silently leave TTS far past picture end — callers must warn + offer options.
 */

import type { SubtitleCue } from '$lib/types/project';
import { cuePlayThroughMs } from '$lib/utils/tts-fit';
import {
	pictureAnchorEnd,
	pictureAnchorStart,
	withPictureAnchors,
	type PictureLockCue
} from '$lib/utils/cue-picture-lock';

/** Prefer original starts; only ~0.12s breath when a prior line spills. */
export const SMART_ALIGN_MIN_BREATH_MS = 120;
/** “A little longer” vs picture (ratio). Prefer light video extend, not speech speed-up. */
export const SMART_ALIGN_MILD_RATIO = 1.15;
/** Above this ratio, prefer gap expansion and ask before heavy remaster. */
export const SMART_ALIGN_HEAVY_RATIO = 1.35;
/** @deprecated Align no longer auto-speeds TTS; kept for older callers/UI. */
export const SMART_ALIGN_MILD_TTS_RATE = 1;
/** Smallest pitch-safe video tempo Align remasters automatically (not 0.50×). */
export const SMART_ALIGN_MILD_MIN_TEMPO = 0.88;
/** Still OK to treat as “fits” if only this far past picture (ms). */
export const SMART_ALIGN_FIT_SLOP_MS = 400;
/** Past this overhang (ms) after gap-expand, Align must prompt. */
export const SMART_ALIGN_OVERHANG_WARN_MS = 800;

export type SmartAlignStrategy = 'fits' | 'mild' | 'gap-expand' | 'overhang';

export type SmartAlignPatch = {
	id: string;
	startMs: number;
	endMs: number;
	fitPlaybackRate: number;
};

export type SmartAlignPlan = {
	strategy: SmartAlignStrategy;
	/** Current picture length (ms). */
	videoMs: number;
	/** Sum of natural TTS durations (ms). */
	naturalSpeechMs: number;
	/** Timeline end after placing cues (ms). */
	contentEndMs: number;
	/** How far content past video (ms), ≥0. */
	overhangMs: number;
	/** Suggested uniform TTS playback rate (≥1). */
	ttsRate: number;
	/** Suggested relative video remaster tempo (1 = none). */
	videoTempo: number;
	/** Expected picture length after remaster. */
	effectiveVideoMs: number;
	patches: SmartAlignPatch[];
	/** Human-readable plan summary. */
	summary: string;
};

function naturalSpeechMs(cue: PictureLockCue): number {
	const dur = cue.assignedAudio?.durationMs;
	if (typeof dur === 'number' && dur > 80) return Math.round(dur);
	return Math.max(200, cuePlayThroughMs(cue as SubtitleCue));
}

function roundTempo(n: number): number {
	return Math.round(Math.max(0.5, Math.min(1, n)) * 1000) / 1000;
}

/**
 * Place cues preferring original anchor starts; spill expands the gap before the next line.
 * `mediaTempoFromSource` maps source anchors → current timeline (1 = not remastered).
 *
 * Always keeps `fitPlaybackRate` at 1 — Align must not chipmunk TTS.
 * Prosody pitch/speed are user-controlled only.
 */
export function placeCuesPreferAnchors(
	cues: PictureLockCue[],
	opts: {
		ttsRate?: number;
		minBreathMs?: number;
		/** Product of remasters since Extract (1 = source). */
		mediaTempoFromSource?: number;
		/** Optional hard clamp for last end (trim path). */
		maxEndMs?: number;
	} = {}
): { patches: SmartAlignPatch[]; contentEndMs: number } {
	// Align never auto-speeds speech — ignore legacy ttsRate boosts.
	const rate = 1;
	void opts.ttsRate;
	const breath = Math.max(40, opts.minBreathMs ?? SMART_ALIGN_MIN_BREATH_MS);
	const tempo = Math.max(0.25, Math.min(2, opts.mediaTempoFromSource ?? 1));
	const maxEnd =
		typeof opts.maxEndMs === 'number' && opts.maxEndMs > 500
			? Math.round(opts.maxEndMs)
			: Number.POSITIVE_INFINITY;

	const sorted = [...cues].sort(
		(a, b) => pictureAnchorStart(a) - pictureAnchorStart(b) || a.index - b.index
	);
	const patches: SmartAlignPatch[] = [];
	let prevEnd = 0;

	for (let i = 0; i < sorted.length; i++) {
		const cue = sorted[i]!;
		const anchor = Math.max(0, Math.round(pictureAnchorStart(cue) / tempo));
		const hardEnd = Math.max(anchor + 120, Math.round(pictureAnchorEnd(cue) / tempo));
		const natural = naturalSpeechMs(cue);
		const playMs = Math.max(200, Math.ceil(natural / rate));

		let startMs = Math.max(0, Math.max(anchor, prevEnd > 0 ? prevEnd + breath : 0));
		let endMs = startMs + playMs;

		// Short holds on the original hardsub window (e.g. 哈哈哈).
		if (startMs === anchor && natural + 40 < hardEnd - anchor) {
			endMs = Math.max(endMs, Math.min(hardEnd, Number.isFinite(maxEnd) ? maxEnd : hardEnd));
		}

		if (Number.isFinite(maxEnd) && endMs > maxEnd) {
			// Trim the subtitle window only — do not speed TTS to fit.
			endMs = Math.max(startMs + 120, maxEnd);
			patches.push({
				id: cue.id,
				startMs,
				endMs,
				fitPlaybackRate: 1
			});
			prevEnd = patches[patches.length - 1]!.endMs;
			continue;
		}

		patches.push({
			id: cue.id,
			startMs,
			endMs: Math.max(startMs + 120, endMs),
			fitPlaybackRate: 1
		});
		prevEnd = patches[patches.length - 1]!.endMs;
	}

	return { patches, contentEndMs: prevEnd };
}

function totalNaturalSpeechMs(cues: PictureLockCue[]): number {
	return cues.reduce((sum, c) => sum + naturalSpeechMs(c), 0);
}

/**
 * Build an Align plan from current cues + picture length.
 * Does not mutate project state.
 */
export function planSmartAlign(opts: {
	videoMs: number;
	cues: PictureLockCue[];
	mediaTempoFromSource?: number;
	/**
	 * When true, force content into videoMs (auto-trim path).
	 * Raises TTS rate / pulls starts as needed.
	 */
	forceFitIntoVideo?: boolean;
}): SmartAlignPlan {
	const videoMs = Math.max(0, Math.round(opts.videoMs));
	const cues = withPictureAnchors(opts.cues);
	const mediaTempo = Math.max(0.25, Math.min(2, opts.mediaTempoFromSource ?? 1));
	const naturalSpeechMsTotal = totalNaturalSpeechMs(cues);

	const empty = (partial: Partial<SmartAlignPlan>): SmartAlignPlan => ({
		strategy: 'fits',
		videoMs,
		naturalSpeechMs: naturalSpeechMsTotal,
		contentEndMs: 0,
		overhangMs: 0,
		ttsRate: 1,
		videoTempo: 1,
		effectiveVideoMs: videoMs,
		patches: [],
		summary: 'No cues to align.',
		...partial
	});

	if (!cues.length || videoMs < 500) {
		return empty({ summary: 'Need video length and cues before Align.' });
	}

	const placeOpts = { mediaTempoFromSource: mediaTempo };

	if (opts.forceFitIntoVideo) {
		const placed = placeCuesPreferAnchors(cues, {
			...placeOpts,
			ttsRate: 1,
			maxEndMs: videoMs - 40
		});
		return {
			strategy: 'mild',
			videoMs,
			naturalSpeechMs: naturalSpeechMsTotal,
			contentEndMs: Math.min(videoMs, placed.contentEndMs),
			overhangMs: 0,
			ttsRate: 1,
			videoTempo: 1,
			effectiveVideoMs: videoMs,
			patches: placed.patches,
			summary: 'Auto-trim into picture · natural speech (windows clipped, not sped up)'
		};
	}

	const naturalPlace = placeCuesPreferAnchors(cues, { ...placeOpts, ttsRate: 1 });
	const ratio = naturalPlace.contentEndMs / Math.max(1, videoMs);
	const overhangNatural = Math.max(0, naturalPlace.contentEndMs - videoMs);

	if (overhangNatural <= SMART_ALIGN_FIT_SLOP_MS) {
		return {
			strategy: 'fits',
			videoMs,
			naturalSpeechMs: naturalSpeechMsTotal,
			contentEndMs: naturalPlace.contentEndMs,
			overhangMs: overhangNatural,
			ttsRate: 1,
			videoTempo: 1,
			effectiveVideoMs: videoMs,
			patches: naturalPlace.patches,
			summary: 'Khmer fits picture · anchors kept · natural speech'
		};
	}

	// A little longer → keep natural speech; light pitch-safe video extend if needed.
	if (ratio <= SMART_ALIGN_MILD_RATIO) {
		const contentEndMs = naturalPlace.contentEndMs;
		let videoTempo = 1;
		let effectiveVideoMs = videoMs;

		if (contentEndMs > videoMs + SMART_ALIGN_FIT_SLOP_MS) {
			videoTempo = roundTempo(
				Math.max(SMART_ALIGN_MILD_MIN_TEMPO, videoMs / contentEndMs)
			);
			effectiveVideoMs = Math.round(videoMs / videoTempo);
		}

		// Still past picture after mild extend floor → ask (Auto-extend / trim / manual).
		if (contentEndMs > effectiveVideoMs + SMART_ALIGN_OVERHANG_WARN_MS) {
			return {
				strategy: 'overhang',
				videoMs,
				naturalSpeechMs: naturalSpeechMsTotal,
				contentEndMs,
				overhangMs: Math.max(0, contentEndMs - videoMs),
				ttsRate: 1,
				videoTempo: 1,
				effectiveVideoMs: videoMs,
				patches: naturalPlace.patches,
				summary: `Khmer ~${formatSec(contentEndMs)} vs video ${formatSec(videoMs)} · choose trim, extend, or manual`
			};
		}

		return {
			strategy: videoTempo < 0.995 ? 'mild' : 'gap-expand',
			videoMs,
			naturalSpeechMs: naturalSpeechMsTotal,
			contentEndMs,
			overhangMs: Math.max(0, contentEndMs - effectiveVideoMs),
			ttsRate: 1,
			videoTempo,
			effectiveVideoMs,
			patches: naturalPlace.patches,
			summary:
				videoTempo < 0.995
					? `Natural speech · extend video ${videoTempo.toFixed(2)}×`
					: 'Natural speech · expand gaps · original starts kept'
		};
	}

	// Much longer → gap-expand at natural rate; prompt if still past picture.
	if (
		ratio > SMART_ALIGN_HEAVY_RATIO ||
		overhangNatural > SMART_ALIGN_OVERHANG_WARN_MS
	) {
		return {
			strategy: 'overhang',
			videoMs,
			naturalSpeechMs: naturalSpeechMsTotal,
			contentEndMs: naturalPlace.contentEndMs,
			overhangMs: overhangNatural,
			ttsRate: 1,
			videoTempo: 1,
			effectiveVideoMs: videoMs,
			patches: naturalPlace.patches,
			summary: `Khmer ~${formatSec(naturalPlace.contentEndMs)} vs video ${formatSec(videoMs)} · choose trim, extend, or manual`
		};
	}

	return {
		strategy: 'gap-expand',
		videoMs,
		naturalSpeechMs: naturalSpeechMsTotal,
		contentEndMs: naturalPlace.contentEndMs,
		overhangMs: overhangNatural,
		ttsRate: 1,
		videoTempo: 1,
		effectiveVideoMs: videoMs,
		patches: naturalPlace.patches,
		summary: 'Gap-expand · natural speech · original starts kept when possible'
	};
}

function formatSec(ms: number): string {
	const s = Math.max(0, ms) / 1000;
	const m = Math.floor(s / 60);
	const r = s - m * 60;
	return `${m}:${r.toFixed(1).padStart(4, '0')}`;
}

/**
 * Align plan that never moves subtitle times — only suggests video tempo / overhang choice.
 * Kept for callers that need media-only preview; primary Align uses planSmartAlign.
 */
export function planMediaOnlyAlign(opts: {
	videoMs: number;
	contentEndMs: number;
	naturalSpeechMs?: number;
}): SmartAlignPlan {
	const videoMs = Math.max(0, Math.round(opts.videoMs));
	const contentEndMs = Math.max(0, Math.round(opts.contentEndMs));
	const naturalSpeechMsTotal = Math.max(
		0,
		Math.round(opts.naturalSpeechMs ?? contentEndMs)
	);
	const overhangMs = Math.max(0, contentEndMs - videoMs);
	const emptyPatches: SmartAlignPatch[] = [];

	if (videoMs < 500 || contentEndMs < 200) {
		return {
			strategy: 'fits',
			videoMs,
			naturalSpeechMs: naturalSpeechMsTotal,
			contentEndMs,
			overhangMs: 0,
			ttsRate: 1,
			videoTempo: 1,
			effectiveVideoMs: videoMs,
			patches: emptyPatches,
			summary: 'Need video length and cues before Align.'
		};
	}

	if (overhangMs <= SMART_ALIGN_FIT_SLOP_MS) {
		return {
			strategy: 'fits',
			videoMs,
			naturalSpeechMs: naturalSpeechMsTotal,
			contentEndMs,
			overhangMs,
			ttsRate: 1,
			videoTempo: 1,
			effectiveVideoMs: videoMs,
			patches: emptyPatches,
			summary: 'Khmer fits picture · subtitle times unchanged'
		};
	}

	const videoTempo = roundTempo(videoMs / Math.max(1, contentEndMs));
	const effectiveVideoMs = Math.round(videoMs / Math.max(0.5, videoTempo));

	if (videoTempo >= SMART_ALIGN_MILD_MIN_TEMPO) {
		return {
			strategy: 'mild',
			videoMs,
			naturalSpeechMs: naturalSpeechMsTotal,
			contentEndMs,
			overhangMs: Math.max(0, contentEndMs - effectiveVideoMs),
			ttsRate: 1,
			videoTempo,
			effectiveVideoMs,
			patches: emptyPatches,
			summary: `Video ${videoTempo.toFixed(2)}× to cover Khmer · subtitle times unchanged`
		};
	}

	return {
		strategy: 'overhang',
		videoMs,
		naturalSpeechMs: naturalSpeechMsTotal,
		contentEndMs,
		overhangMs,
		ttsRate: 1,
		videoTempo,
		effectiveVideoMs: videoMs,
		patches: emptyPatches,
		summary: `Khmer ~${formatSec(contentEndMs)} vs video ${formatSec(videoMs)} · choose extend or manual`
	};
}

/** Stats block shown after a successful Align. */
export type AlignResultStats = {
	originalVideoMs: number;
	khmerAudioMs: number;
	videoTempo: number;
	audioStretch: number;
	strategy: SmartAlignStrategy;
	overhangMs: number;
	message: string;
};
