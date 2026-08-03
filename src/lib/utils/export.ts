import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import type { SubtitleCue } from '$lib/types/project';
import { isTauriRuntime } from '$lib/utils/platform';
import { cuesToSrt } from '$lib/utils/srt';

export type ExportMode = 'srt' | 'videoSoftSubs' | 'videoBurnedIn';

export type ExportProjectResult = {
	outputPath: string;
	mode: string;
};

const CHUNK_SIZE = 4 * 1024 * 1024;

function downloadBlob(filename: string, content: string, mime: string) {
	const blob = new Blob([content], { type: mime });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	a.click();
	URL.revokeObjectURL(url);
}

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

export type RunExportOptions = {
	mode: ExportMode;
	cues: SubtitleCue[];
	projectName: string;
	/** Absolute filesystem path when known (preferred). */
	videoPath?: string | null;
	/** In-memory source file used to stage when no path is available. */
	videoFile?: File | null;
	onStatus?: (message: string) => void;
};

function isVideoMode(mode: ExportMode): boolean {
	return mode === 'videoSoftSubs' || mode === 'videoBurnedIn';
}

/**
 * Run an export: pick destination, then write SRT or mux/burn via Tauri/FFmpeg.
 * In the browser (non-Tauri), only SRT download is supported.
 */
export async function runProjectExport(opts: RunExportOptions): Promise<ExportProjectResult> {
	const srtContent = cuesToSrt(opts.cues);
	if (!srtContent.trim()) {
		throw new Error('No subtitle cues to export. Add translation text first.');
	}

	const safeBase =
		opts.projectName
			.trim()
			.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '_')
			.replace(/\s+/g, ' ')
			.slice(0, 80) || 'export';

	if (!isTauriRuntime()) {
		if (isVideoMode(opts.mode)) {
			throw new Error('Video export requires the desktop app.');
		}
		opts.onStatus?.('Downloading SRT…');
		downloadBlob(`${safeBase}.srt`, srtContent, 'application/x-subrip;charset=utf-8');
		return { outputPath: `${safeBase}.srt`, mode: 'srt' };
	}

	const video = isVideoMode(opts.mode);
	const title =
		opts.mode === 'videoBurnedIn'
			? 'Export video with burned-in subtitles'
			: opts.mode === 'videoSoftSubs'
				? 'Export video with soft subtitles'
				: 'Export subtitles (SRT)';

	const outputPath = await save({
		title,
		defaultPath: video ? `${safeBase}.mp4` : `${safeBase}.srt`,
		filters: video
			? [{ name: 'MP4 Video', extensions: ['mp4'] }]
			: [{ name: 'SubRip Subtitles', extensions: ['srt'] }]
	});

	if (!outputPath) {
		throw new Error('Export cancelled.');
	}

	let stagedPath: string | null = null;
	let videoPath = opts.videoPath?.trim() || null;

	try {
		if (video) {
			if (!videoPath) {
				if (!opts.videoFile) {
					throw new Error('Load a source video before exporting video with subtitles.');
				}
				opts.onStatus?.('Preparing video for export…');
				stagedPath = await stageVideoFile(opts.videoFile);
				videoPath = stagedPath;
			}
			opts.onStatus?.(
				opts.mode === 'videoBurnedIn'
					? 'Burning subtitles into video (FFmpeg)…'
					: 'Muxing soft subtitles with FFmpeg…'
			);
		} else {
			opts.onStatus?.('Writing SRT…');
		}

		const result = await invoke<ExportProjectResult>('export_project', {
			args: {
				mode: opts.mode,
				srtContent,
				outputPath,
				videoPath
			}
		});

		opts.onStatus?.('Export complete');
		return result;
	} finally {
		if (stagedPath) {
			await invoke('cleanup_staged_file', { path: stagedPath }).catch(() => undefined);
		}
	}
}
