import type { SubtitleCue } from '$lib/types/project';
import { cueAudioEndMs } from '$lib/utils/tts-fit';

/** SRT timestamp: HH:MM:SS,mmm */
export function formatSrtTimestamp(ms: number): string {
	const total = Math.max(0, Math.round(ms));
	const hours = Math.floor(total / 3_600_000);
	const minutes = Math.floor((total % 3_600_000) / 60_000);
	const seconds = Math.floor((total % 60_000) / 1000);
	const millis = total % 1000;
	return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
}

function cueText(cue: SubtitleCue): string {
	const translation = cue.translation?.trim() ?? '';
	if (translation) return translation;
	return cue.source?.trim() ?? '';
}

export type CuesToSrtOptions = {
	/** Transform cue text (e.g. preview-matched soft wrap for burn-in). */
	mapText?: (text: string, cue: SubtitleCue) => string;
};

/**
 * Build a UTF-8 SRT document from project cues.
 * Prefers Khmer translation; falls back to source text.
 * End time follows TTS play-through so burn-in doesn’t linger in dead air.
 */
export function cuesToSrt(cues: SubtitleCue[], opts?: CuesToSrtOptions): string {
	const sorted = [...cues].sort((a, b) => a.startMs - b.startMs || a.index - b.index);
	const blocks: string[] = [];
	let n = 0;

	for (const cue of sorted) {
		let text = cueText(cue);
		if (!text) continue;
		if (opts?.mapText) text = opts.mapText(text, cue);
		if (!text.trim()) continue;
		const start = Math.max(0, Math.round(cue.startMs));
		const end = Math.max(start + 1, Math.round(cueAudioEndMs(cue)));
		n += 1;
		blocks.push(`${n}\n${formatSrtTimestamp(start)} --> ${formatSrtTimestamp(end)}\n${text}`);
	}

	return blocks.length ? `${blocks.join('\n\n')}\n` : '';
}
