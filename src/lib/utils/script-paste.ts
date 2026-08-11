/**
 * Map translator script lines onto a fixed ASR cue count.
 * Used only when the user opts into “merge extra lines”. Default paste is 1:1
 * with new cues for leftovers (so subtitle #2 “Hahaha” does not swallow #3).
 */

/**
 * Distribute N non-empty lines into `cueCount` slots by merging consecutive
 * lines (character-weighted). Fewer lines than cues → trailing slots empty.
 */
export function packLinesIntoCueSlots(lines: string[], cueCount: number): string[] {
	const n = Math.max(0, Math.floor(cueCount));
	if (n <= 0) return [];
	const cleaned = lines.map((l) => l.trim()).filter((l) => l.length > 0);
	if (cleaned.length === 0) return Array.from({ length: n }, () => '');
	if (cleaned.length <= n) {
		return Array.from({ length: n }, (_, i) => cleaned[i] ?? '');
	}

	const totalChars = cleaned.reduce((s, l) => s + Math.max(1, l.length), 0);
	const target = totalChars / n;
	const groups: string[][] = Array.from({ length: n }, () => []);
	let cueIdx = 0;
	let filled = 0;

	for (let i = 0; i < cleaned.length; i++) {
		const line = cleaned[i]!;
		groups[cueIdx]!.push(line);
		filled += Math.max(1, line.length);

		const remainingLines = cleaned.length - i - 1;
		const remainingCues = n - cueIdx - 1;
		if (remainingCues <= 0) continue;

		// Leave at least one line for each remaining cue.
		if (remainingLines <= remainingCues) {
			cueIdx += 1;
			filled = 0;
			continue;
		}

		if (filled >= target * 0.9) {
			cueIdx += 1;
			filled = 0;
		}
	}

	// Join sentences with a space (translators used newlines as sentence breaks).
	return groups.map((g) => g.join(' ').replace(/\s+/g, ' ').trim());
}

/** Split pasted script into non-empty lines (newline only). */
export function splitScriptLines(script: string): string[] {
	return String(script ?? '')
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l.length > 0);
}

/** Collapse `...` / `….` into a single ellipsis so splitters never emit lone `.`. */
function normalizeEllipsis(text: string): string {
	return text.replace(/\.{2,}/g, '…').replace(/…+/g, '…').replace(/\s+/g, ' ').trim();
}

/** True if the token is real speech, not punctuation crumbs from ellipsis splits. */
function isRealSentence(text: string): boolean {
	const t = text.trim();
	if (t.length < 2) return false;
	// Lone `.` `…` `!` etc. — never map these onto Extract cues.
	if (/^[។៕.!？?…\s"'“”‘’]+$/u.test(t)) return false;
	return true;
}

/**
 * Smart split for Paste Apply: one sentence per Extract cue.
 *
 * Word / Telegram scripts are usually already one line per cue — prefer newlines.
 * Only sentence-split a single blob. Never split inside `...` (that created lone
 * `.` rows and shifted every later cue, as in Video 05.docx).
 */
export function splitKhmerSentences(script: string): string[] {
	const raw = String(script ?? '')
		.replace(/\r\n/g, '\n')
		.trim();
	if (!raw) return [];

	const byNewline = raw
		.split(/\n+/)
		.map((l) => normalizeEllipsis(l))
		.filter(isRealSentence);

	// Already line-broken (docx / one-line-per-cue) → keep those lines intact.
	// Do not further split on `!` / `.` inside a line (would desync Extract order).
	if (byNewline.length >= 2) {
		return byNewline;
	}

	// Single paragraph blob → split on Khmer/Latin sentence ends (ellipsis-safe).
	const blob = normalizeEllipsis(raw);
	const parts = blob.split(/(?<=[។៕!？?…])\s+/);
	const out: string[] = [];
	for (const part of parts) {
		const t = normalizeEllipsis(part);
		if (isRealSentence(t)) out.push(t);
	}
	return out.length ? out : byNewline;
}

/** Rough Khmer TTS length from character count (ms). */
export function estimateKhmerSpeechMs(text: string): number {
	const t = String(text ?? '').trim();
	if (!t) return 0;
	return Math.max(1_400, Math.min(14_000, Math.round(t.length * 90)));
}

/** Sum of estimated speech for all sentences (ms). */
export function estimateScriptSpeechMs(script: string): number {
	return splitKhmerSentences(script).reduce((sum, s) => sum + estimateKhmerSpeechMs(s), 0);
}

/** Planned cue after fitting script lines into the Extract speech span. */
export type FittedScriptCue = {
	startMs: number;
	endMs: number;
	translation: string;
	source: string;
};

export type PlanCuesFromScriptLinesResult = {
	cues: FittedScriptCue[];
	spanStartMs: number;
	spanEndMs: number;
	extractCueCount: number;
};

const FIT_BREATH_MS = 100;
/** Floor so tiny lines still get a readable window inside the span. */
const FIT_MIN_CUE_MS = 900;

/**
 * Split concatenated Extract Chinese into N slots by weight (char budget).
 */
function splitSourceByWeights(joinedSource: string, weights: number[]): string[] {
	const n = weights.length;
	if (n === 0) return [];
	const text = String(joinedSource ?? '').trim();
	if (!text) return Array.from({ length: n }, () => '');

	const chars = [...text];
	const totalW = weights.reduce((s, w) => s + Math.max(1, w), 0);
	const out: string[] = [];
	let cursor = 0;

	for (let i = 0; i < n; i++) {
		const remainingSlots = n - i;
		const remainingChars = chars.length - cursor;
		if (remainingSlots <= 1) {
			out.push(chars.slice(cursor).join('').trim());
			break;
		}
		const share = Math.max(1, weights[i]!);
		let take = Math.round((share / totalW) * chars.length);
		take = Math.max(1, Math.min(remainingChars - (remainingSlots - 1), take));
		out.push(chars.slice(cursor, cursor + take).join('').trim());
		cursor += take;
	}

	while (out.length < n) out.push('');
	return out;
}

/**
 * Rebuild cue count to match script lines, carving times from the Extract
 * speech span [first.start … last.end]. FunASR blobs are only a timeline;
 * your lines are the real hardsub-aligned list.
 */
export function planCuesFromScriptLines(
	lines: string[],
	extractCues: { startMs: number; endMs: number; source?: string }[],
	opts?: { breathMs?: number; minCueMs?: number }
): PlanCuesFromScriptLinesResult {
	const cleaned = lines.map((l) => String(l ?? '').trim()).filter((l) => l.length > 0);
	const sorted = [...extractCues].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
	const extractCueCount = sorted.length;

	if (!cleaned.length) {
		return { cues: [], spanStartMs: 0, spanEndMs: 0, extractCueCount };
	}

	const breath = Math.max(0, Math.round(opts?.breathMs ?? FIT_BREATH_MS));
	const minCue = Math.max(400, Math.round(opts?.minCueMs ?? FIT_MIN_CUE_MS));

	let spanStart = sorted.length
		? Math.max(0, Math.round(sorted[0]!.startMs))
		: 0;
	let spanEnd = sorted.length
		? Math.max(spanStart + minCue, Math.round(sorted[sorted.length - 1]!.endMs))
		: spanStart + cleaned.length * minCue;

	const n = cleaned.length;
	const gapBudget = breath * Math.max(0, n - 1);
	let usable = Math.max(n * minCue, spanEnd - spanStart - gapBudget);

	// If Extract span is shorter than N×floor, grow spanEnd so every line gets minCue.
	const need = n * minCue + gapBudget;
	if (spanEnd - spanStart < need) {
		spanEnd = spanStart + need;
		usable = n * minCue;
	} else {
		usable = spanEnd - spanStart - gapBudget;
	}

	const weights = cleaned.map((line) => Math.max(minCue, estimateKhmerSpeechMs(line)));
	const weightSum = weights.reduce((s, w) => s + w, 0);

	const joinedSource = sorted
		.map((c) => String(c.source ?? '').trim())
		.filter(Boolean)
		.join('');
	const sources = splitSourceByWeights(joinedSource, weights);

	const cues: FittedScriptCue[] = [];
	let cursor = spanStart;
	let used = 0;

	for (let i = 0; i < n; i++) {
		const isLast = i === n - 1;
		let dur: number;
		if (isLast) {
			dur = Math.max(minCue, spanEnd - cursor);
		} else {
			const raw = Math.round((weights[i]! / weightSum) * usable);
			dur = Math.max(minCue, raw);
			// Keep enough room for remaining floors.
			const remainSlots = n - i - 1;
			const maxDur = Math.max(minCue, usable - used - remainSlots * minCue);
			dur = Math.min(dur, maxDur);
			used += dur;
		}

		const startMs = Math.max(0, Math.round(cursor));
		const endMs = Math.max(startMs + minCue, Math.round(startMs + dur));
		cues.push({
			startMs,
			endMs,
			translation: cleaned[i]!,
			source: sources[i] ?? ''
		});
		cursor = endMs + (isLast ? 0 : breath);
	}

	// Snap last end to spanEnd when we didn't overrun.
	if (cues.length) {
		const last = cues[cues.length - 1]!;
		if (last.endMs < spanEnd) {
			last.endMs = spanEnd;
		}
		spanEnd = Math.max(spanEnd, last.endMs);
	}

	return { cues, spanStartMs: spanStart, spanEndMs: spanEnd, extractCueCount };
}
