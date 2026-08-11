import type { SubtitleCue } from '$lib/types/project';
import { cueAudioEndMs, cuePlayThroughMs } from '$lib/utils/tts-fit';

/** Breath between TTS clips when packing (Tighten silent gaps). */
export const ALIGN_BREATH_MS = 520;
/**
 * @deprecated Subtitle hang after speech — kept for call-site compat.
 * Align sync locks subtitle end to audio end; hang is no longer applied to TTS cues.
 */
export const ALIGN_HANG_PAD_MS = 0;
/**
 * @deprecated Measured-TTS tail pad — packing now uses play-through only so
 * next-cue starts match cueAudioEndMs (audio ↔ subtitle).
 */
export const ALIGN_SPEECH_TAIL_MS = 0;

export type TightenGapsOptions = {
	/**
	 * Breath between the end of one TTS clip and the start of the next (ms).
	 * ASR silences are discarded — cues are packed. Default ALIGN_BREATH_MS.
	 */
	maxGapMs?: number;
	/** @deprecated Use maxGapMs as the breath gap. Kept for call-site compat. */
	minGapMs?: number;
	/** Ignored for TTS cues — subtitle end = audio end. Kept for call-site compat. */
	hangPadMs?: number;
};

export type CueTimingPatch = {
	id: string;
	startMs: number;
	endMs: number;
};

/** Speech length for packing — same oracle as preview / SRT / export. */
function speechDurationMs(cue: SubtitleCue): number {
	return cuePlayThroughMs(cue);
}

/**
 * Pack cues so TTS plays with a clear breath gap (not hard-abutted / overlapping).
 * Long Chinese ASR silences are removed — that was the “too much silent gap”
 * after Generate from Khmer script.
 *
 * endMs = start + play-through (subtitle window = audio window).
 * Manual only — Import SRT / Generate must not call this.
 */
export function planTightenedCueGaps(
	cues: SubtitleCue[],
	opts: TightenGapsOptions = {}
): { patches: CueTimingPatch[]; pulledMs: number } {
	const breath = Math.max(360, Math.round(opts.maxGapMs ?? ALIGN_BREATH_MS));

	const sorted = [...cues].sort((a, b) => a.startMs - b.startMs || a.index - b.index);
	if (!sorted.length) return { patches: [], pulledMs: 0 };

	const patches: CueTimingPatch[] = [];
	let pulledMs = 0;
	/** Previous clip’s audio end — next speech starts after breath. */
	let prevAudioEnd = 0;

	for (let i = 0; i < sorted.length; i++) {
		const cue = sorted[i]!;
		const speechMs = speechDurationMs(cue);

		let start: number;
		if (i === 0) {
			start = Math.max(0, Math.round(cue.startMs));
		} else {
			// Always pack after previous speech + breath — never overlap.
			const packed = prevAudioEnd + breath;
			const original = Math.max(0, Math.round(cue.startMs));
			if (original > packed) {
				pulledMs += original - packed;
				start = packed;
			} else {
				start = packed;
			}
		}

		const end = start + speechMs;
		patches.push({ id: cue.id, startMs: start, endMs: Math.max(start + 200, end) });
		prevAudioEnd = start + speechMs;
	}

	return { patches, pulledMs };
}

/** Content end after patches (or live cues). */
export function patchedContentEndMs(cues: SubtitleCue[], patches: CueTimingPatch[]): number {
	const byId = new Map(patches.map((p) => [p.id, p]));
	let max = 0;
	for (const cue of cues) {
		const p = byId.get(cue.id);
		if (p) {
			max = Math.max(max, p.endMs);
			continue;
		}
		max = Math.max(max, cueAudioEndMs(cue), cue.endMs);
	}
	return max;
}

/** Estimate Edge MP3 duration when waveform probe is unavailable (48 kbps CBR). */
export function estimateEdgeMp3DurationMs(byteLength: number): number {
	if (!Number.isFinite(byteLength) || byteLength <= 0) return 0;
	return Math.max(200, Math.round((byteLength * 8 * 1000) / 48_000));
}
