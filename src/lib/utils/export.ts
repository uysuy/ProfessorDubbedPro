import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import type { SubtitleCue, SubtitleStyle } from '$lib/types/project';
import { DEFAULT_SUBTITLE_STYLE } from '$lib/types/project';
import {
	detectPreviewFrameSize,
	ensureWrapFontLoaded,
	wrapSubtitleText,
	type SubtitleWrapStyle
} from '$lib/utils/khmer-wrap';
import { isTauriRuntime } from '$lib/utils/platform';
import { cuesToSrt } from '$lib/utils/srt';
import { renderTitleLiverOverlays } from '$lib/utils/title-liver-export';

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

export type ExportDubClip = {
	path: string;
	startMs: number;
	/** Linear 0–1 */
	volume: number;
	/** Play-through length after tempo (ms) — keeps mix from chopping the end. */
	durationMs?: number;
	/** Align / fit tempo applied via FFmpeg atempo (1 = natural). */
	playbackRate?: number;
};

export type RunExportOptions = {
	mode: ExportMode;
	cues: SubtitleCue[];
	projectName: string;
	/** Absolute filesystem path when known (preferred). */
	videoPath?: string | null;
	/** In-memory source file used to stage when no path is available. */
	videoFile?: File | null;
	/** Original Audio fader (0 = muted). Default 1. */
	originalAudioGain?: number;
	/** Generated TTS clips to mix into the exported video. */
	dubClips?: ExportDubClip[];
	/** Preview-matched burn-in style (font / size / position). */
	subtitleStyle?: SubtitleStyle | null;
	/** Title Liver clips burned into video (burned-in mode). */
	titleLiverClips?: import('$lib/types/project').TitleLiverClip[] | null;
	onStatus?: (message: string) => void;
};

function isVideoMode(mode: ExportMode): boolean {
	return mode === 'videoSoftSubs' || mode === 'videoBurnedIn';
}

function burnInWrapStyle(style: SubtitleStyle): SubtitleWrapStyle {
	const frame = detectPreviewFrameSize();
	return {
		fontFamily: style.fontFamily,
		fontSizePx: style.fontSizePx,
		maxWidthPct: style.maxWidthPct ?? DEFAULT_SUBTITLE_STYLE.maxWidthPct,
		frameWidth: frame.width,
		frameHeight: frame.height,
		look: style.look ?? 'outline'
	};
}

/**
 * Run an export: pick destination, then write SRT or mux/burn via Tauri/FFmpeg.
 * In the browser (non-Tauri), only SRT download is supported.
 */
export async function runProjectExport(opts: RunExportOptions): Promise<ExportProjectResult> {
	const style = opts.subtitleStyle ?? DEFAULT_SUBTITLE_STYLE;
	let srtContent: string;
	if (opts.mode === 'videoBurnedIn') {
		const wrapStyle = burnInWrapStyle(style);
		opts.onStatus?.('Matching subtitle wrap to preview…');
		await ensureWrapFontLoaded(wrapStyle);
		srtContent = cuesToSrt(opts.cues, {
			mapText: (text) => wrapSubtitleText(text, wrapStyle)
		});
	} else {
		srtContent = cuesToSrt(opts.cues);
	}
	if (!srtContent.trim()) {
		const hasTitles = (opts.titleLiverClips ?? []).length > 0;
		if (!(opts.mode === 'videoBurnedIn' && hasTitles)) {
			throw new Error('No subtitle cues to export. Add translation text first.');
		}
		srtContent = '1\n00:00:00,000 --> 00:00:00,040\n \n\n';
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
	let stagedTitlePngs: string[] = [];
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
			const gain = Number.isFinite(opts.originalAudioGain) ? Number(opts.originalAudioGain) : 1;
			const clips = opts.dubClips ?? [];
			if (clips.length) {
				opts.onStatus?.(
					gain < 0.02
						? `Mixing ${clips.length} TTS clip(s) (original muted)…`
						: `Mixing ${clips.length} TTS clip(s) with original audio…`
				);
			} else if (gain < 0.02) {
				opts.onStatus?.('Exporting with original audio muted…');
			} else if (opts.mode === 'videoBurnedIn') {
				opts.onStatus?.('Burning subtitles into video (FFmpeg)…');
			} else {
				opts.onStatus?.('Muxing soft subtitles with FFmpeg…');
			}

			if (gain < 0.02 && clips.length === 0) {
				throw new Error(
					'Original Audio is muted and there is no TTS to mix.\nGenerate Selected Audio first, or unmute Original Audio before export.'
				);
			}
		} else {
			opts.onStatus?.('Writing SRT…');
		}

		let titleLiverOverlays: Array<{ pngPath: string; startMs: number; endMs: number }> = [];
		if (video && opts.mode === 'videoBurnedIn' && videoPath) {
			const tlClips = opts.titleLiverClips ?? [];
			if (tlClips.length) {
				titleLiverOverlays = await renderTitleLiverOverlays(tlClips, videoPath, opts.onStatus);
				stagedTitlePngs = titleLiverOverlays.map((o) => o.pngPath);
			}
			opts.onStatus?.('Burning subtitles & live titles into video…');
		}

		const result = await invoke<ExportProjectResult>('export_project', {
			args: {
				mode: opts.mode,
				srtContent,
				outputPath,
				videoPath,
				originalAudioGain: Number.isFinite(opts.originalAudioGain)
					? opts.originalAudioGain
					: 1,
				dubClips: (opts.dubClips ?? []).map((c) => ({
					path: c.path,
					startMs: Math.max(0, Math.round(c.startMs)),
					volume: Math.max(0, Math.min(1, c.volume)),
					durationMs:
						typeof c.durationMs === 'number' && c.durationMs > 0
							? Math.round(c.durationMs)
							: undefined,
					playbackRate:
						typeof c.playbackRate === 'number' && c.playbackRate > 0
							? Math.max(0.5, Math.min(1.5, c.playbackRate))
							: undefined
				})),
				subtitleStyle: {
					fontFamily: style.fontFamily,
					fontFile: style.fontFile ?? null,
					fontSizePx: style.fontSizePx,
					x: style.x,
					y: style.y,
					look: style.look ?? 'outline',
					maxWidthPct: style.maxWidthPct ?? 0.96,
					outlineWidth: style.outlineWidth ?? 1
				},
				titleLiverClips: titleLiverOverlays
			}
		});

		opts.onStatus?.('Export complete');
		return result;
	} finally {
		if (stagedPath) {
			await invoke('cleanup_staged_file', { path: stagedPath }).catch(() => undefined);
		}
		for (const p of stagedTitlePngs) {
			await invoke('cleanup_staged_file', { path: p }).catch(() => undefined);
		}
	}
}
