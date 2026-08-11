import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { isTauriRuntime } from '$lib/utils/platform';
import { TTS_ALIGN_MAX_PLAYBACK } from '$lib/utils/tts-fit';

export type RemasterVideoTempoResult = {
	outputPath: string;
	tempo: number;
	durationMs: number;
};

export type VideoTempoProgress = {
	stage: string;
	message: string;
	percent: number;
};

const CHUNK_SIZE = 4 * 1024 * 1024;

async function stageVideoFile(file: File): Promise<string> {
	const path = await invoke<string>('begin_staged_file', { fileName: file.name });
	try {
		let offset = 0;
		while (offset < file.size) {
			const blob = file.slice(offset, offset + CHUNK_SIZE);
			const buffer = new Uint8Array(await blob.arrayBuffer());
			await invoke('append_staged_file', { path, chunk: Array.from(buffer) });
			offset += CHUNK_SIZE;
		}
		return path;
	} catch (err) {
		await invoke('cleanup_staged_file', { path }).catch(() => undefined);
		throw err;
	}
}

export type RunVideoTempoOptions = {
	tempo: number;
	videoPath?: string | null;
	videoFile?: File | null;
	onProgress?: (p: VideoTempoProgress) => void;
};

/**
 * Pitch-safe remaster via FFmpeg setpts + atempo.
 * Returns a new MP4 path; caller should swap project media and scale cues.
 */
export async function runVideoTempoRemaster(
	opts: RunVideoTempoOptions
): Promise<RemasterVideoTempoResult> {
	if (!isTauriRuntime()) {
		throw new Error('Pitch-safe Tempo requires the desktop app (`pnpm tauri:dev`).');
	}

	let stagedPath: string | null = null;
	let videoPath = opts.videoPath?.trim() || null;
	let unlisten: UnlistenFn | null = null;

	try {
		if (!videoPath) {
			if (!opts.videoFile) {
				throw new Error('Open a video first, then apply Tempo.');
			}
			opts.onProgress?.({
				stage: 'stage',
				message: 'Preparing video file…',
				percent: 2
			});
			stagedPath = await stageVideoFile(opts.videoFile);
			videoPath = stagedPath;
		}

		unlisten = await listen<VideoTempoProgress>('video-tempo-progress', (event) => {
			opts.onProgress?.(event.payload);
		});

		opts.onProgress?.({
			stage: 'start',
			message: 'Starting pitch-safe remaster…',
			percent: 4
		});

		return await invoke<RemasterVideoTempoResult>('remaster_video_tempo', {
			args: {
				videoPath,
				tempo: opts.tempo
			}
		});
	} finally {
		if (unlisten) unlisten();
		if (stagedPath) {
			await invoke('cleanup_staged_file', { path: stagedPath }).catch(() => undefined);
		}
	}
}

export async function cancelVideoTempo(): Promise<void> {
	if (!isTauriRuntime()) return;
	await invoke('cancel_video_tempo').catch(() => undefined);
}

/** Scale cue display times for tempo `t` (newTime = oldTime / t).
 * Picture anchors stay in source time and are NOT scaled (Align maps via mediaTempoFromSource).
 */
export function scaleCueTimesForTempo<
	T extends {
		startMs: number;
		endMs: number;
		pictureStartMs?: number;
		pictureEndMs?: number;
	}
>(cues: T[], tempo: number): T[] {
	const t = tempo;
	if (!Number.isFinite(t) || t <= 0) return cues;
	return cues.map((cue) => {
		const startMs = Math.max(0, Math.round(cue.startMs / t));
		const endMs = Math.max(startMs + 1, Math.round(cue.endMs / t));
		return { ...cue, startMs, endMs };
	});
}

export type FitToDubMode = 'stretch' | 'shorten' | 'none';

export type FitToDubPlan = {
	/** FFmpeg tempo (playback speed of current file). */
	tempo: number;
	videoMs: number;
	contentMs: number;
	/** True when durations already match within tolerance. */
	alreadyFits: boolean;
	/** True when required tempo is outside FFmpeg-safe range (0.5×–2.0×). */
	tooExtreme: boolean;
	/**
	 * stretch = slow video (tempo &lt; 1) when dub is longer;
	 * shorten = unused for Align (we leave picture at 1.00× when video is longer).
	 */
	mode: FitToDubMode;
	/**
	 * Speech playback rate (≥1). Prefer 1.0; mild bump only if video would
	 * need to go slower than ALIGN_HARD_MIN_TEMPO.
	 */
	ttsRate: number;
	/** Content length after applying ttsRate (what video remaster targets). */
	effectiveContentMs: number;
	/** How the plan splits the adjustment. */
	strategy: 'none' | 'tts-only' | 'video-only' | 'hybrid';
};

/**
 * Mild TTS ceiling after remaster (Align prefers natural speech).
 * Used when packing into the remastered picture only.
 */
export const ALIGN_MAX_TTS_RATE = 1.05;
/** Last-resort TTS when remaster is unavailable / fails (gated — not default Align). */
export const ALIGN_FORCE_FIT_MAX_TTS_RATE = TTS_ALIGN_MAX_PLAYBACK;
/** Soft TTS used only when video would need to go slower than 0.50×. */
export const ALIGN_FALLBACK_TTS_RATE = 1.15;
/** @deprecated Prefer ALIGN_MAX_TTS_RATE — kept for call-site compat. */
export const ALIGN_PREFERRED_TTS_RATE = ALIGN_MAX_TTS_RATE;
/** @deprecated Prefer ALIGN_HARD_MIN_TEMPO. */
export const ALIGN_PREFERRED_MIN_TEMPO = 0.5;
/**
 * Slowest pitch-safe video remaster (FFmpeg atempo floor).
 * Align slows the picture to match natural Khmer rather than chipmunk TTS.
 */
export const ALIGN_HARD_MIN_TEMPO = 0.5;

/**
 * Align plan: slow the picture to natural Khmer length (video-first).
 *
 * - Dub longer than video → tempo = videoMs/contentMs (≥ 0.50×), TTS ≈ 1.0.
 *   Only raise TTS (≤ 1.15) if content still needs slower than 0.50×.
 * - Dub shorter than video → leave picture at 1.00× (do not speed to 2×).
 *
 * Burned-in CN/EN hardsubs stretch with the remastered picture.
 * Align uses picture-lock (ASR windows), not breath-packing, so Khmer stays
 * with those hardsubs (e.g. “哈哈哈” hold is not overwritten by the next line).
 */
export function computeFitToDubTempo(opts: {
	videoMs: number;
	contentMs: number;
	/** Extra ms past last cue so the last frame isn’t flush. */
	padMs?: number;
	/** Cap for speech playback rate when tempo hits the floor (default 1.15). */
	maxTtsRate?: number;
	/** Absolute slowest video tempo (default ALIGN_HARD_MIN_TEMPO). */
	preferredMinTempo?: number;
	/** @deprecated Ignored — Align is video-first. */
	preferredMaxTtsRate?: number;
	/** @deprecated Ignored. */
	videoShare?: number;
}): FitToDubPlan {
	const pad = Math.max(0, opts.padMs ?? 100);
	const videoMs = Math.max(0, Math.round(opts.videoMs));
	const contentMs = Math.max(0, Math.round(opts.contentMs) + pad);
	const minTempo = Math.max(
		0.5,
		Math.min(1, opts.preferredMinTempo ?? ALIGN_HARD_MIN_TEMPO)
	);
	const maxTts = Math.max(
		1,
		Math.min(1.5, opts.maxTtsRate ?? ALIGN_FALLBACK_TTS_RATE)
	);

	const empty = (partial: Partial<FitToDubPlan>): FitToDubPlan => ({
		tempo: 1,
		videoMs,
		contentMs,
		alreadyFits: false,
		tooExtreme: false,
		mode: 'none',
		ttsRate: 1,
		effectiveContentMs: contentMs,
		strategy: 'none',
		...partial
	});

	if (videoMs < 500 || contentMs < 500) {
		return empty({ alreadyFits: true, strategy: 'none' });
	}

	const delta = contentMs - videoMs;
	if (Math.abs(delta) <= 200) {
		return empty({ alreadyFits: true, strategy: 'none' });
	}

	// Video longer than dub → leave picture alone (do not speed up to 2×).
	if (contentMs < videoMs) {
		return empty({
			tempo: 1,
			alreadyFits: true,
			mode: 'none',
			strategy: 'none',
			effectiveContentMs: contentMs
		});
	}

	// Dub longer than video → slow picture to match natural Khmer.
	let ttsRate = 1;
	let effectiveContentMs = contentMs;
	let rawTempo = videoMs / effectiveContentMs;

	if (rawTempo < minTempo - 1e-6) {
		// Need slower than floor — mild TTS so remaster stays ≥ minTempo.
		const remasteredLen = videoMs / minTempo;
		ttsRate = Math.round(
			Math.min(maxTts, Math.max(1, contentMs / remasteredLen)) * 1000
		) / 1000;
		effectiveContentMs = Math.max(500, Math.round(contentMs / ttsRate));
		rawTempo = videoMs / effectiveContentMs;
		if (rawTempo < minTempo - 1e-6) {
			rawTempo = minTempo;
			const stillLong = effectiveContentMs > remasteredLen * 1.02;
			return empty({
				tempo: minTempo,
				ttsRate,
				effectiveContentMs,
				alreadyFits: false,
				tooExtreme: stillLong,
				mode: 'stretch',
				strategy: ttsRate > 1.001 ? 'hybrid' : 'video-only'
			});
		}
	}

	const tempo = Math.round(Math.min(1, Math.max(minTempo, rawTempo)) * 1000) / 1000;
	const mode: FitToDubMode = tempo < 1 - 1e-6 ? 'stretch' : 'none';
	let strategy: FitToDubPlan['strategy'] = 'none';
	if (ttsRate > 1.001 && Math.abs(tempo - 1) > 1e-3) strategy = 'hybrid';
	else if (ttsRate > 1.001) strategy = 'tts-only';
	else if (Math.abs(tempo - 1) > 1e-3) strategy = 'video-only';

	return {
		tempo,
		videoMs,
		contentMs,
		alreadyFits: strategy === 'none',
		tooExtreme: false,
		mode,
		ttsRate,
		effectiveContentMs,
		strategy
	};
}
