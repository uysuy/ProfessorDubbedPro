/**
 * Burn-in wrap that mirrors studio preview CSS layout.
 *
 * Important: decide breaks using the *on-screen* preview box (picture layer
 * CSS pixels + designScale font), not native PlayRes. Hard `\N` then locks
 * those same character offsets into ASS — matching what you see in preview.
 */

export type SubtitleWrapStyle = {
	fontFamily: string;
	/** Design size as if picture were 720px tall (matches SubtitleStyle.fontSizePx). */
	fontSizePx: number;
	maxWidthPct: number;
	/** Native video frame size — fallback when preview DOM isn’t available. */
	frameWidth: number;
	frameHeight: number;
	look?: 'outline' | 'box';
};

function fontStack(familyRaw: string): string {
	const family = familyRaw.replace(/"/g, '').trim() || 'Noto Sans Khmer';
	return `"${family}", "Noto Sans Khmer", "Khmer UI", sans-serif`;
}

/** Prefer live preview picture-layer metrics (matches VideoPreview.svelte). */
export function resolveWrapMetrics(style: SubtitleWrapStyle): {
	fontPx: number;
	maxWidthPx: number;
	fontCss: string;
} {
	const picture =
		typeof document !== 'undefined'
			? (document.querySelector('.video-picture-layer') as HTMLElement | null)
			: null;
	const dispW = picture?.clientWidth ?? 0;
	const dispH = picture?.clientHeight ?? 0;

	let boxW: number;
	let fontPx: number;
	if (dispW > 8 && dispH > 8) {
		// Same formulas as VideoPreview: designScale = pictureHeight/720
		fontPx = Math.max(8, style.fontSizePx * (dispH / 720));
		boxW = Math.max(8, style.maxWidthPct * dispW);
	} else {
		const frameW = Math.max(16, style.frameWidth);
		const frameH = Math.max(16, style.frameHeight);
		fontPx = Math.max(8, style.fontSizePx * (frameH / 720));
		boxW = Math.max(8, style.maxWidthPct * frameW);
	}

	const padX = style.look === 'box' ? fontPx * 0.55 : fontPx * 0.12;
	const maxWidthPx = Math.max(8, boxW - padX * 2);
	const fontCss = `500 ${fontPx}px ${fontStack(style.fontFamily)}`;
	return { fontPx, maxWidthPx, fontCss };
}

/** Read line-break offsets from a laid-out text node (UTF-16 indices). */
function extractCssLines(textNode: Text, text: string): string {
	if (!text) return '';
	const range = document.createRange();
	const breaks: number[] = [0];
	let lastTop: number | null = null;

	for (let i = 0; i < text.length; ) {
		const cp = text.codePointAt(i) ?? 0;
		const len = cp > 0xffff ? 2 : 1;
		try {
			range.setStart(textNode, i);
			range.setEnd(textNode, Math.min(text.length, i + len));
		} catch {
			i += len;
			continue;
		}
		const rects = range.getClientRects();
		if (rects.length > 0) {
			const top = Math.round(rects[0]!.top);
			if (lastTop !== null && top > lastTop + 1) {
				breaks.push(i);
			}
			lastTop = top;
		}
		i += len;
	}

	const lines: string[] = [];
	for (let b = 0; b < breaks.length; b++) {
		const start = breaks[b]!;
		const end = b + 1 < breaks.length ? breaks[b + 1]! : text.length;
		const line = text.slice(start, end).replace(/\s+$/u, '');
		if (line) lines.push(line);
	}
	return lines.length ? lines.join('\n') : text;
}

function cssSoftWrapParagraph(paragraph: string, fontCss: string, maxWidthPx: number): string {
	const text = paragraph.replace(/\s+$/u, '');
	if (!text) return '';
	if (typeof document === 'undefined') return text;

	const el = document.createElement('div');
	el.setAttribute('lang', 'km');
	el.className = 'font-khmer';
	el.setAttribute('aria-hidden', 'true');
	el.style.cssText = [
		'position:absolute',
		'left:-99999px',
		'top:0',
		`width:${Math.ceil(maxWidthPx)}px`,
		`font:${fontCss}`,
		'line-height:1.22',
		'text-align:center',
		'white-space:normal',
		'overflow-wrap:normal',
		'word-break:normal',
		'line-break:auto',
		'hyphens:none',
		'font-feature-settings:"kern" 1, "liga" 1, "clig" 1'
	].join(';');

	const node = document.createTextNode(text);
	el.appendChild(node);
	document.body.appendChild(el);
	try {
		void el.offsetWidth;
		return extractCssLines(node, text);
	} finally {
		el.remove();
	}
}

/**
 * Soft-wrap using the browser Khmer line breaker at preview box size.
 * Resulting newlines become ASS `\N` and must not be re-wrapped by FFmpeg.
 */
export function wrapSubtitleText(text: string, style: SubtitleWrapStyle): string {
	const raw = text.replace(/\r\n/g, '\n').trim();
	if (!raw) return '';
	const { fontCss, maxWidthPx } = resolveWrapMetrics(style);
	return raw
		.split('\n')
		.map((p) => cssSoftWrapParagraph(p, fontCss, maxWidthPx))
		.filter(Boolean)
		.join('\n');
}

/** Best-effort native frame size from the preview `<video>`. */
export function detectPreviewFrameSize(): { width: number; height: number } {
	if (typeof document === 'undefined') return { width: 1080, height: 1920 };
	const videos = document.querySelectorAll('video');
	for (const v of videos) {
		if (v.videoWidth > 16 && v.videoHeight > 16) {
			return { width: v.videoWidth, height: v.videoHeight };
		}
	}
	return { width: 1080, height: 1920 };
}

/** Ensure the wrap font is loaded before measuring (call before export). */
export async function ensureWrapFontLoaded(style: SubtitleWrapStyle): Promise<void> {
	if (typeof document === 'undefined' || !document.fonts?.load) return;
	const { fontCss, fontPx } = resolveWrapMetrics(style);
	const family = style.fontFamily.replace(/"/g, '').trim() || 'Noto Sans Khmer';
	try {
		await document.fonts.load(`500 ${fontPx}px "${family}"`);
		await document.fonts.load(fontCss);
		await document.fonts.ready;
	} catch {
		/* system font may already be available */
	}
}
