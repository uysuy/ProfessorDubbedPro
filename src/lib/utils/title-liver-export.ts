/**
 * Render Title Liver clips to full-frame transparent PNGs for FFmpeg overlay burn-in.
 * Uses the same TitleLiverGraphic markup as the studio preview.
 */

import { mount, unmount } from 'svelte';
import { toPng } from 'html-to-image';
import { invoke } from '@tauri-apps/api/core';
import type { TitleLiverClip } from '$lib/types/project';
import TitleLiverExportFrame from '$lib/components/studio/TitleLiverExportFrame.svelte';

export type TitleLiverOverlayExport = {
	pngPath: string;
	startMs: number;
	endMs: number;
};

const CHUNK = 4 * 1024 * 1024;

function dataUrlToBytes(dataUrl: string): Uint8Array {
	const comma = dataUrl.indexOf(',');
	const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

async function stagePngBytes(bytes: Uint8Array, fileName: string): Promise<string> {
	const path = await invoke<string>('begin_staged_file', { fileName });
	try {
		let offset = 0;
		while (offset < bytes.length) {
			const end = Math.min(offset + CHUNK, bytes.length);
			const chunk = Array.from(bytes.subarray(offset, end));
			await invoke('append_staged_file', { path, chunk });
			offset = end;
		}
		return path;
	} catch (err) {
		await invoke('cleanup_staged_file', { path }).catch(() => undefined);
		throw err;
	}
}

function waitFrames(n = 2): Promise<void> {
	return new Promise((resolve) => {
		const step = (left: number) => {
			if (left <= 0) {
				resolve();
				return;
			}
			requestAnimationFrame(() => step(left - 1));
		};
		step(n);
	});
}

async function renderOneClip(
	clip: TitleLiverClip,
	width: number,
	height: number
): Promise<string> {
	const host = document.createElement('div');
	host.setAttribute('data-tl-export-host', '1');
	host.style.cssText = [
		'position:fixed',
		'left:-100000px',
		'top:0',
		`width:${width}px`,
		`height:${height}px`,
		'overflow:hidden',
		'pointer-events:none',
		'z-index:-1',
		'background:transparent'
	].join(';');
	document.body.appendChild(host);

	const app = mount(TitleLiverExportFrame, {
		target: host,
		props: { clip, width, height }
	});

	try {
		await document.fonts.ready.catch(() => undefined);
		await waitFrames(3);
		const node = host.firstElementChild as HTMLElement | null;
		if (!node) throw new Error('Title Liver export frame failed to mount');

		const dataUrl = await toPng(node, {
			width,
			height,
			pixelRatio: 1,
			cacheBust: true,
			skipAutoScale: true,
			// Keep alpha so FFmpeg overlay matches the transparent preview graphic.
			backgroundColor: undefined,
			style: {
				transform: 'none',
				margin: '0',
				background: 'transparent',
				backgroundColor: 'transparent'
			}
		});
		const bytes = dataUrlToBytes(dataUrl);
		return stagePngBytes(bytes, `tl-${clip.id}.png`);
	} finally {
		unmount(app);
		host.remove();
	}
}

/** Probe encoded video size via FFmpeg (Tauri). */
export async function probeExportVideoSize(
	videoPath: string
): Promise<{ width: number; height: number }> {
	const [width, height] = await invoke<[number, number]>('probe_export_video_size', {
		videoPath
	});
	return {
		width: Math.max(16, width || 1280),
		height: Math.max(16, height || 720)
	};
}

/**
 * Render each Title Liver clip to a full-frame transparent PNG staged for FFmpeg.
 */
export async function renderTitleLiverOverlays(
	clips: TitleLiverClip[],
	videoPath: string,
	onStatus?: (msg: string) => void
): Promise<TitleLiverOverlayExport[]> {
	if (!clips.length) return [];
	onStatus?.('Measuring video for Title Liver…');
	const { width, height } = await probeExportVideoSize(videoPath);
	const out: TitleLiverOverlayExport[] = [];
	for (let i = 0; i < clips.length; i++) {
		const clip = clips[i]!;
		if (clip.endMs <= clip.startMs) continue;
		onStatus?.(`Rendering live title ${i + 1}/${clips.length}…`);
		const pngPath = await renderOneClip(clip, width, height);
		out.push({
			pngPath,
			startMs: Math.max(0, Math.round(clip.startMs)),
			endMs: Math.max(0, Math.round(clip.endMs))
		});
	}
	return out;
}
