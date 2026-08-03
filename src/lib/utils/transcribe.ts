import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { isTauriRuntime } from '$lib/utils/platform';
import type { AsrEngine, FunAsrModel } from '$lib/stores/preferences.svelte';

export type TranscriptSegment = {
	startMs: number;
	endMs: number;
	text: string;
};

export type TranscribeVideoResult = {
	segments: TranscriptSegment[];
	language: string;
	model: string;
	/** `funasr` | `whisper` */
	engine?: string;
};

export type TranscriptionProgress = {
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

export type RunTranscriptionOptions = {
	videoPath?: string | null;
	videoFile?: File | null;
	language?: string;
	/** Whisper ggml filename when engine falls back / is whisper. */
	model?: string;
	engine?: AsrEngine;
	funasrModel?: FunAsrModel;
	onProgress?: (p: TranscriptionProgress) => void;
};

/**
 * Local ASR of the source video audio (FunASR SenseVoice for Chinese by default,
 * Whisper.cpp as fallback). Stages an in-memory File when no filesystem path is available.
 */
export async function runLocalTranscription(
	opts: RunTranscriptionOptions
): Promise<TranscribeVideoResult> {
	if (!isTauriRuntime()) {
		throw new Error('Auto transcription runs in the desktop app only. Start with `pnpm tauri:dev`.');
	}

	let stagedPath: string | null = null;
	let videoPath = opts.videoPath?.trim() || null;
	let unlisten: UnlistenFn | null = null;

	try {
		if (!videoPath) {
			if (!opts.videoFile) {
				throw new Error('Open a video first, then run Extract Subs.');
			}
			opts.onProgress?.({
				stage: 'stage',
				message: 'Preparing video file…',
				percent: 2
			});
			stagedPath = await stageVideoFile(opts.videoFile);
			videoPath = stagedPath;
		}

		unlisten = await listen<TranscriptionProgress>('transcription-progress', (event) => {
			opts.onProgress?.(event.payload);
		});

		const result = await invoke<TranscribeVideoResult>('transcribe_video', {
			args: {
				videoPath,
				language: opts.language?.trim() || 'zh',
				model: opts.model?.trim() || '',
				engine: opts.engine ?? 'auto',
				funasrModel: opts.funasrModel ?? 'sensevoice'
			}
		});

		return result;
	} finally {
		if (unlisten) unlisten();
		if (stagedPath) {
			await invoke('cleanup_staged_file', { path: stagedPath }).catch(() => undefined);
		}
	}
}

export async function cancelLocalTranscription(): Promise<void> {
	if (!isTauriRuntime()) return;
	await invoke('cancel_transcription').catch(() => undefined);
}

export function asrEngineLabel(engine: string | null | undefined): string {
	switch ((engine ?? '').toLowerCase()) {
		case 'funasr':
			return 'FunASR';
		case 'whisper':
			return 'Whisper';
		default:
			return engine?.trim() || 'ASR';
	}
}
