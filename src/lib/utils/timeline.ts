import { formatClock } from '$lib/utils/time';

export type TimelineTrackKind = 'titleLiver' | 'video' | 'subtitles' | 'tts' | 'original';

export interface TimelineTrackDef {
	id: string;
	kind: TimelineTrackKind;
	name: string;
	/** Short role label shown under the track name (UI only). */
	role: string;
	color: string;
	height: number;
}

export const TIMELINE_TRACKS: TimelineTrackDef[] = [
	{
		id: 'trk-title-liver',
		kind: 'titleLiver',
		name: 'V2',
		role: 'Title Liver',
		color: 'var(--track-title-liver)',
		height: 48
	},
	{
		id: 'trk-subs',
		kind: 'subtitles',
		name: 'V1',
		role: 'Subtitles',
		color: 'var(--track-subs)',
		height: 48
	},
	{
		id: 'trk-tts',
		kind: 'tts',
		name: 'A2',
		role: 'TTS Audio',
		color: 'var(--track-tts)',
		height: 64
	},
	{
		id: 'trk-video',
		kind: 'video',
		name: 'V',
		role: 'Original Video',
		color: 'var(--track-video)',
		height: 56
	},
	{
		id: 'trk-original',
		kind: 'original',
		name: 'A1',
		role: 'Original Audio',
		color: 'var(--track-original)',
		height: 64
	}
];

export const LABEL_WIDTH = 152;
export const RULER_HEIGHT = 26;
export const BASE_PX_PER_SEC = 48;
/** Absolute floor — real min zoom is usually “fit to viewport”. */
export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 6;
/** Legacy fixed min (kept for docs / defaults). Prefer `fitZoom`. */
export const DEFAULT_ZOOM = 1.25;

export function pxPerMs(zoom: number): number {
	return (BASE_PX_PER_SEC * zoom) / 1000;
}

export function timelineWidthPx(durationMs: number, zoom: number): number {
	// Exact media length — a large min width used to leave empty space after the end.
	return Math.max(1, durationMs * pxPerMs(zoom));
}

/**
 * Zoom level that fits the full duration into `viewportContentPx`
 * (scroller width minus the sticky track label column).
 */
export function fitZoom(durationMs: number, viewportContentPx: number): number {
	if (durationMs < 500) return DEFAULT_ZOOM;
	const view = Math.max(120, viewportContentPx);
	const z = view / ((durationMs / 1000) * BASE_PX_PER_SEC);
	return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(z.toFixed(4))));
}

/** Effective minimum zoom for the current timeline + viewport (fit, with a tiny pad). */
export function minZoomForView(durationMs: number, viewportContentPx: number): number {
	if (durationMs < 500) return MIN_ZOOM;
	const fit = fitZoom(durationMs, viewportContentPx);
	// Allow a hair under fit so edges aren’t clipped by scrollbars.
	return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number((fit * 0.98).toFixed(4))));
}

export function msToX(ms: number, zoom: number): number {
	return ms * pxPerMs(zoom);
}

export function xToMs(x: number, zoom: number, durationMs: number): number {
	const ms = x / pxPerMs(zoom);
	return Math.max(0, Math.min(durationMs, ms));
}

/** Convert a horizontal pixel delta to milliseconds (no clamping). */
export function deltaXToMs(dx: number, zoom: number): number {
	return dx / pxPerMs(zoom);
}

/** Pixel distance within which clips magnetically snap. */
export const SNAP_THRESHOLD_PX = 12;

/**
 * Snap a moving cue's start time to nearby cue edges or the playhead.
 * Preserves duration; clamps within [0, timelineDuration - duration].
 */
export function snapCueStartMs(opts: {
	startMs: number;
	durationMs: number;
	timelineDurationMs: number;
	zoom: number;
	playheadMs: number;
	others: { startMs: number; endMs: number }[];
}): { startMs: number; guideMs: number | null } {
	const { durationMs, timelineDurationMs, zoom, playheadMs, others } = opts;
	const threshold = SNAP_THRESHOLD_PX / pxPerMs(zoom);
	const maxStart = Math.max(0, timelineDurationMs - durationMs);

	const targets: { startAs: number; guide: number }[] = [
		{ startAs: playheadMs, guide: playheadMs },
		{ startAs: playheadMs - durationMs, guide: playheadMs }
	];
	for (const o of others) {
		targets.push(
			{ startAs: o.startMs, guide: o.startMs },
			{ startAs: o.endMs, guide: o.endMs },
			{ startAs: o.startMs - durationMs, guide: o.startMs },
			{ startAs: o.endMs - durationMs, guide: o.endMs }
		);
	}

	let best = opts.startMs;
	let bestDist = Infinity;
	let guideMs: number | null = null;

	for (const t of targets) {
		const dist = Math.abs(opts.startMs - t.startAs);
		if (dist <= threshold && dist < bestDist) {
			bestDist = dist;
			best = t.startAs;
			guideMs = t.guide;
		}
	}

	const startMs = Math.max(0, Math.min(maxStart, Math.round(best)));
	const snapped = Math.abs(startMs - Math.round(best)) < 1 && guideMs != null;
	return { startMs, guideMs: snapped ? guideMs : null };
}

export interface RulerTick {
	ms: number;
	x: number;
	major: boolean;
	label: string;
}

/** Choose a readable major tick interval from zoom level. */
export function majorIntervalMs(zoom: number): number {
	if (zoom >= 4) return 1_000;
	if (zoom >= 2.5) return 2_000;
	if (zoom >= 1.5) return 5_000;
	if (zoom >= 1) return 10_000;
	if (zoom >= 0.75) return 15_000;
	return 30_000;
}

export function buildRulerTicks(durationMs: number, zoom: number): RulerTick[] {
	const major = majorIntervalMs(zoom);
	const minor = major / 5;
	const ticks: RulerTick[] = [];
	// Cap tick count — long videos at high zoom used to spawn thousands of DOM nodes and freeze bake.
	const rawSteps = Math.ceil(durationMs / minor);
	const maxSteps = 800;
	const stride = rawSteps > maxSteps ? Math.ceil(rawSteps / maxSteps) : 1;

	for (let i = 0; i <= rawSteps; i += stride) {
		const ms = Math.min(durationMs, Math.round(i * minor));
		const isMajor = i % 5 === 0;
		ticks.push({
			ms,
			x: msToX(ms, zoom),
			major: isMajor,
			label: isMajor ? formatClock(ms, durationMs >= 3600_000) : ''
		});
	}

	return ticks;
}

/** Deterministic pseudo-random in [0, 1). */
function hash01(seed: number): number {
	const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
	return x - Math.floor(x);
}

/**
 * Generate a waveform peak array for visualization.
 * Peaks are normalized 0–1 and shaped with an envelope for a realistic look.
 */
export function generateWaveformPeaks(
	seed: string,
	count: number,
	opts?: { density?: number; noise?: number }
): number[] {
	const density = opts?.density ?? 0.72;
	const noise = opts?.noise ?? 0.35;
	let s = 0;
	for (let i = 0; i < seed.length; i++) s = (s + seed.charCodeAt(i) * (i + 1)) % 10_000;

	const peaks: number[] = [];
	for (let i = 0; i < count; i++) {
		const t = i / Math.max(1, count - 1);
		const envelope = Math.sin(Math.PI * t) ** 0.65;
		const tone =
			0.45 * Math.sin((i + s) * 0.33) +
			0.3 * Math.sin((i + s) * 0.71) +
			0.25 * Math.sin((i + s) * 1.37);
		const n = (hash01(s + i * 17) - 0.5) * 2 * noise;
		const value = Math.max(0.05, Math.min(1, (0.55 + tone * 0.35 + n) * envelope * density));
		peaks.push(value);
	}
	return peaks;
}

const peakCache = new Map<string, number[]>();

export function peaksForClip(id: string, widthPx: number, barWidth = 2): number[] {
	const count = Math.max(8, Math.floor(widthPx / barWidth));
	const key = `${id}:${count}`;
	let peaks = peakCache.get(key);
	if (!peaks) {
		peaks = generateWaveformPeaks(id, count);
		peakCache.set(key, peaks);
	}
	return peaks;
}
