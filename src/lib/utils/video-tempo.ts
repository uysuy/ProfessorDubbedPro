import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { isTauriRuntime } from '$lib/utils/platform';

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

/** Scale cue times for tempo `t` (newTime = oldTime / t). */
export function scaleCueTimesForTempo<T extends { startMs: number; endMs: number }>(
	cues: T[],
	tempo: number
): T[] {
	const t = tempo;
	if (!Number.isFinite(t) || t <= 0) return cues;
	return cues.map((cue) => {
		const startMs = Math.max(0, Math.round(cue.startMs / t));
		let endMs = Math.max(startMs + 1, Math.round(cue.endMs / t));
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
	 * shorten = speed video (tempo &gt; 1) when video is longer than dub.
	 */
	mode: FitToDubMode;
};

/**
 * Compute pitch-safe tempo so remastered video duration ≈ dub/content length.
 * `tempo = videoMs / contentMs`
 * - dub longer → tempo &lt; 1 (stretch picture)
 * - video longer → tempo &gt; 1 (shorten picture — “video feels slower than script”)
 * Caller must remaster WITHOUT scaling cues (timeline already matches the dub).
 */
export function computeFitToDubTempo(opts: {
	videoMs: number;
	contentMs: number;
	/** Extra ms past last cue so the last frame isn’t flush. */
	padMs?: number;
}): FitToDubPlan {
	const pad = Math.max(0, opts.padMs ?? 250);
	const videoMs = Math.max(0, Math.round(opts.videoMs));
	const contentMs = Math.max(0, Math.round(opts.contentMs) + pad);
	if (videoMs < 500 || contentMs < 500) {
		return {
			tempo: 1,
			videoMs,
			contentMs,
			alreadyFits: true,
			tooExtreme: false,
			mode: 'none'
		};
	}
	const delta = contentMs - videoMs;
	if (Math.abs(delta) <= 200) {
		return {
			tempo: 1,
			videoMs,
			contentMs,
			alreadyFits: true,
			tooExtreme: false,
			mode: 'none'
		};
	}
	const raw = videoMs / contentMs;
	if (raw < 0.5 - 1e-6) {
		return {
			tempo: 0.5,
			videoMs,
			contentMs,
			alreadyFits: false,
			tooExtreme: true,
			mode: 'stretch'
		};
	}
	if (raw > 2.0 + 1e-6) {
		return {
			tempo: 2,
			videoMs,
			contentMs,
			alreadyFits: false,
			tooExtreme: true,
			mode: 'shorten'
		};
	}
	const tempo = Math.round(Math.min(2, Math.max(0.5, raw)) * 1000) / 1000;
	const mode: FitToDubMode = tempo < 1 - 1e-6 ? 'stretch' : tempo > 1 + 1e-6 ? 'shorten' : 'none';
	return {
		tempo,
		videoMs,
		contentMs,
		alreadyFits: mode === 'none',
		tooExtreme: false,
		mode
	};
}
