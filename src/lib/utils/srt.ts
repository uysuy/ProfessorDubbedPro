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

/** Parse `HH:MM:SS,mmm` or `HH:MM:SS.mmm` → milliseconds. */
export function parseSrtTimestamp(raw: string): number | null {
	const m = raw
		.trim()
		.match(/^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/);
	if (!m) return null;
	const hours = Number(m[1]);
	const minutes = Number(m[2]);
	const seconds = Number(m[3]);
	const millis = Number(m[4]!.padEnd(3, '0').slice(0, 3));
	if (![hours, minutes, seconds, millis].every((n) => Number.isFinite(n))) return null;
	return ((hours * 3600 + minutes * 60 + seconds) * 1000) + millis;
}

export type ParsedSrtCue = {
	index: number;
	startMs: number;
	endMs: number;
	text: string;
};

/**
 * Parse a UTF-8 (or UTF-8 BOM) SRT document into timed cues.
 * Tolerates blank lines, Windows/Mac newlines, and optional cue numbers.
 */
export function parseSrt(raw: string): ParsedSrtCue[] {
	const text = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
	if (!text) return [];

	const blocks = text.split(/\n\s*\n/);
	const cues: ParsedSrtCue[] = [];

	for (const block of blocks) {
		const lines = block.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim() !== '');
		if (!lines.length) continue;

		let timingLine = '';
		let textStart = 0;
		if (/-->/.test(lines[0]!)) {
			timingLine = lines[0]!;
			textStart = 1;
		} else if (lines.length >= 2 && /^\d+$/.test(lines[0]!.trim()) && /-->/.test(lines[1]!)) {
			timingLine = lines[1]!;
			textStart = 2;
		} else {
			const found = lines.findIndex((l) => /-->/.test(l));
			if (found < 0) continue;
			timingLine = lines[found]!;
			textStart = found + 1;
		}

		const tm = timingLine.match(
			/(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})/
		);
		if (!tm) continue;
		const startMs = parseSrtTimestamp(tm[1]!);
		const endMs = parseSrtTimestamp(tm[2]!);
		if (startMs == null || endMs == null) continue;

		const body = lines
			.slice(textStart)
			.map((l) => l.replace(/<[^>]+>/g, '').trim())
			.filter(Boolean)
			.join('\n')
			.trim();
		if (!body) continue;

		const start = Math.max(0, startMs);
		const end = Math.max(start + 120, endMs);
		cues.push({
			index: cues.length + 1,
			startMs: start,
			endMs: end,
			text: body
		});
	}

	return cues.sort((a, b) => a.startMs - b.startMs || a.index - b.index);
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

/** Keep burn-in / SRT from overlapping the next cue (safety net; packing should prevent this). */
const SRT_CUE_GAP_MS = 40;

/**
 * Build a UTF-8 SRT document from project cues.
 * Prefers Khmer translation; falls back to source text.
 * End time follows TTS play-through so burn-in doesn’t linger in dead air,
 * and is clamped before the next cue so titles never overlap.
 */
export function cuesToSrt(cues: SubtitleCue[], opts?: CuesToSrtOptions): string {
	const sorted = [...cues].sort((a, b) => a.startMs - b.startMs || a.index - b.index);
	const blocks: string[] = [];
	let n = 0;

	for (let i = 0; i < sorted.length; i++) {
		const cue = sorted[i]!;
		let text = cueText(cue);
		if (!text) continue;
		if (opts?.mapText) text = opts.mapText(text, cue);
		if (!text.trim()) continue;
		const start = Math.max(0, Math.round(cue.startMs));
		let end = Math.max(start + 1, Math.round(cueAudioEndMs(cue)));
		const next = sorted[i + 1];
		if (next) {
			const nextStart = Math.max(0, Math.round(next.startMs));
			if (nextStart > start + 1) {
				end = Math.min(end, nextStart - SRT_CUE_GAP_MS);
			}
		}
		end = Math.max(start + 1, end);
		n += 1;
		blocks.push(`${n}\n${formatSrtTimestamp(start)} --> ${formatSrtTimestamp(end)}\n${text}`);
	}

	return blocks.length ? `${blocks.join('\n\n')}\n` : '';
}
