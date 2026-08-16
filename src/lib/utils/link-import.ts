import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { isTauriRuntime } from '$lib/utils/platform';

export type LinkImportProgress = {
	stage: string;
	message: string;
	percent: number;
};

export type ResolvedInput = {
	kind: string;
	site: string;
	query: string;
	display: string;
};

export type MediaCandidate = {
	id: string;
	title: string;
	durationS: number | null;
	webpageUrl: string;
	thumbnail: string | null;
	uploader: string | null;
	site: string;
	/** `video` | `series` — series opens an episode list. */
	kind?: string;
};

export type ResolveResult = {
	input: ResolvedInput;
	entries: MediaCandidate[];
	listLabel?: string;
};

export type DownloadLinkResult = {
	videoPath: string;
	subtitlePath: string | null;
	subtitleSource: string | null;
	title: string;
	durationMs: number;
};

export type LinkImportToolsStatus = {
	ytdlp: string | null;
	ocrReady: boolean;
	ocrPython: string | null;
};

export type DownloadLinkOptions = {
	url: string;
	title?: string;
	startS?: number | null;
	endS?: number | null;
	writeSubs?: boolean;
	runOcr?: boolean;
	ocrIntervalS?: number;
};

/** Parse MM:SS or HH:MM:SS (or plain seconds) into seconds. */
export function parseClockToSeconds(raw: string): number | null {
	const t = raw.trim();
	if (!t) return null;
	if (/^\d+(\.\d+)?$/.test(t)) {
		const n = Number(t);
		return Number.isFinite(n) && n >= 0 ? n : null;
	}
	const parts = t.split(':').map((p) => Number(p));
	if (parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
	if (parts.length === 3) {
		const [h, m, s] = parts;
		return h * 3600 + m * 60 + s;
	}
	if (parts.length === 2) {
		const [m, s] = parts;
		return m * 60 + s;
	}
	return null;
}

export function formatSecondsClock(total: number): string {
	const s = Math.max(0, Math.floor(total));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	if (h > 0) {
		return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
	}
	return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

export async function getLinkImportToolsStatus(): Promise<LinkImportToolsStatus> {
	if (!isTauriRuntime()) {
		return { ytdlp: null, ocrReady: false, ocrPython: null };
	}
	return invoke<LinkImportToolsStatus>('link_import_tools_status');
}

export type MediaPreviewInfo = {
	kind: 'embed' | 'stream' | 'none' | string;
	url: string | null;
	thumbnail: string | null;
	title: string;
	durationS: number | null;
	webpageUrl: string;
	site: string;
};

export async function resolveMediaLink(
	raw: string,
	opts?: { playlistStart?: number; playlistEnd?: number }
): Promise<ResolveResult> {
	return invoke<ResolveResult>('resolve_media_link', {
		raw,
		playlistStart: opts?.playlistStart ?? null,
		playlistEnd: opts?.playlistEnd ?? null
	});
}

export async function getMediaPreview(url: string): Promise<MediaPreviewInfo> {
	return invoke<MediaPreviewInfo>('get_media_preview', { url });
}

export async function downloadMediaLink(opts: DownloadLinkOptions): Promise<DownloadLinkResult> {
	return invoke<DownloadLinkResult>('download_media_link', {
		args: {
			url: opts.url,
			title: opts.title ?? null,
			startS: opts.startS ?? null,
			endS: opts.endS ?? null,
			writeSubs: opts.writeSubs ?? true,
			runOcr: opts.runOcr ?? false,
			ocrIntervalS: opts.ocrIntervalS ?? 1
		}
	});
}

export async function cancelLinkImport(): Promise<void> {
	if (!isTauriRuntime()) return;
	await invoke('cancel_link_import');
}

export async function listenLinkImportProgress(
	onProgress: (p: LinkImportProgress) => void
): Promise<UnlistenFn> {
	return listen<LinkImportProgress>('link-import-progress', (ev) => {
		onProgress(ev.payload);
	});
}
