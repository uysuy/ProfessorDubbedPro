import type { SubtitleCue } from '$lib/types/project';
import { cueAudioEndMs } from '$lib/utils/tts-fit';

export type TightenGapsOptions = {
	/**
	 * Breath between the end of one TTS clip and the start of the next (ms).
	 * ASR silences are discarded — cues are packed. Default 100.
	 */
	maxGapMs?: number;
	/** @deprecated Use maxGapMs as the breath gap. Kept for call-site compat. */
	minGapMs?: number;
	/** Extra subtitle hold after TTS audio (ms). Default 40. */
	hangPadMs?: number;
};

export type CueTimingPatch = {
	id: string;
	startMs: number;
	endMs: number;
};

function speechDurationMs(cue: SubtitleCue): number {
	const audio = cue.assignedAudio?.durationMs;
	if (typeof audio === 'number' && audio > 0) {
		return Math.max(200, Math.round(audio));
	}
	return Math.max(200, Math.round(cue.endMs - cue.startMs));
}

/**
 * Pack cues so TTS plays back-to-back with only a short breath gap.
 * Long Chinese ASR silences are removed — that was the “too much silent gap”
 * after Generate from Khmer script.
 */
export function planTightenedCueGaps(
	cues: SubtitleCue[],
	opts: TightenGapsOptions = {}
): { patches: CueTimingPatch[]; pulledMs: number } {
	const breath = Math.max(40, Math.round(opts.maxGapMs ?? 100));
	const hangPad = Math.max(0, Math.round(opts.hangPadMs ?? 40));

	const sorted = [...cues].sort((a, b) => a.startMs - b.startMs || a.index - b.index);
	if (!sorted.length) return { patches: [], pulledMs: 0 };

	const patches: CueTimingPatch[] = [];
	let pulledMs = 0;
	/** Previous clip’s true audio end (no hang pad) — next speech starts after breath. */
	let prevAudioEnd = 0;

	for (let i = 0; i < sorted.length; i++) {
		const cue = sorted[i]!;
		const speechMs = speechDurationMs(cue);
		const hasTts =
			typeof cue.assignedAudio?.durationMs === 'number' && cue.assignedAudio.durationMs > 0;

		let start: number;
		if (i === 0) {
			start = Math.max(0, Math.round(cue.startMs));
		} else {
			// Always pack after previous speech — ignore multi-second ASR holes.
			const packed = prevAudioEnd + breath;
			const original = Math.max(0, Math.round(cue.startMs));
			if (original > packed) {
				pulledMs += original - packed;
				start = packed;
			} else if (original < prevAudioEnd) {
				// Overlap from earlier TTS extend — abut with breath.
				start = packed;
			} else {
				// Already within breath of previous audio — keep a consistent breath.
				start = packed;
			}
		}

		const end = start + speechMs + (hasTts ? hangPad : 0);
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
