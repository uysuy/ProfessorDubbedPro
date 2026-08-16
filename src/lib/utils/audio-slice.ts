import { invoke } from '@tauri-apps/api/core';
import { isTauriRuntime } from '$lib/utils/platform';

export type SliceAudioResult = {
	filePath: string;
	durationMs: number;
};

/**
 * Cut [startMs, endMs) from a local TTS file via FFmpeg.
 * Returns a new file under the app TTS folder.
 */
export async function sliceAudioFile(opts: {
	sourcePath: string;
	cueId: string;
	startMs: number;
	endMs: number;
}): Promise<SliceAudioResult> {
	if (!isTauriRuntime()) {
		throw new Error('Audio slice requires the desktop app.');
	}
	const startMs = Math.max(0, Math.round(opts.startMs));
	const endMs = Math.max(startMs + 40, Math.round(opts.endMs));
	const result = await invoke<SliceAudioResult>('slice_audio', {
		args: {
			sourcePath: opts.sourcePath,
			cueId: opts.cueId,
			startMs,
			endMs
		}
	});
	return {
		filePath: result.filePath,
		durationMs: Math.max(80, Math.round(result.durationMs))
	};
}
