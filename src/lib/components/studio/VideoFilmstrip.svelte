<script lang="ts">
	import { onDestroy } from 'svelte';
	import { isTimelineScrubbing, onTimelineScrubbing } from '$lib/stores/playback-clock';

	interface Props {
		videoUrl: string | null;
		durationMs: number;
		/** Lane width in layout pixels (pre-zoom-scale). */
		widthPx: number;
		heightPx?: number;
		class?: string;
	}

	let {
		videoUrl,
		durationMs,
		widthPx,
		heightPx = 56,
		class: className = ''
	}: Props = $props();

	let canvasEl: HTMLCanvasElement | undefined = $state();
	let status = $state<'idle' | 'loading' | 'ready' | 'error'>('idle');
	let genToken = 0;
	let debounceTimer = 0;
	let videoEl: HTMLVideoElement | null = null;
	let scrubPaused = false;
	/** Only rebuild frames when media identity changes — not on every zoom. */
	let paintedKey = '';

	const TILE_GAP = 1;
	/** Internal paint width: enough detail, independent of timeline zoom. */
	const PAINT_WIDTH = 960;

	function disposeVideo() {
		if (!videoEl) return;
		try {
			videoEl.pause();
			videoEl.removeAttribute('src');
			videoEl.load();
		} catch {
			/* ignore */
		}
		videoEl = null;
	}

	function clearCanvas() {
		const canvas = canvasEl;
		if (!canvas) return;
		const ctx = canvas.getContext('2d');
		if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
		canvas.width = 1;
		canvas.height = 1;
		canvas.style.width = '0px';
		canvas.style.height = '0px';
		paintedKey = '';
	}

	function applyDisplaySize() {
		const canvas = canvasEl;
		if (!canvas || status !== 'ready') return;
		const h = Math.max(24, Math.round(heightPx));
		canvas.style.width = `${Math.max(1, Math.round(widthPx))}px`;
		canvas.style.height = `${h}px`;
	}

	function mediaKey(url: string, dur: number): string {
		// Bucket duration so tiny Align length tweaks don't force a full rebuild.
		return `${url}|${Math.round(Math.max(0, dur) / 500)}`;
	}

	function waitSeek(video: HTMLVideoElement, t: number): Promise<void> {
		return new Promise((resolve, reject) => {
			const onSeeked = () => {
				cleanup();
				resolve();
			};
			const onError = () => {
				cleanup();
				reject(new Error('seek failed'));
			};
			const cleanup = () => {
				video.removeEventListener('seeked', onSeeked);
				video.removeEventListener('error', onError);
			};
			video.addEventListener('seeked', onSeeked, { once: true });
			video.addEventListener('error', onError, { once: true });
			try {
				const sec = Math.max(0, Math.min(t, Math.max(0, video.duration - 0.04)));
				const fast = (video as HTMLVideoElement & { fastSeek?: (s: number) => void }).fastSeek;
				if (typeof fast === 'function') fast.call(video, sec);
				else video.currentTime = sec;
			} catch (err) {
				cleanup();
				reject(err);
			}
		});
	}

	async function ensureVideo(url: string): Promise<HTMLVideoElement> {
		if (videoEl?.dataset.src === url) {
			return videoEl;
		}
		disposeVideo();
		const video = document.createElement('video');
		video.muted = true;
		video.playsInline = true;
		video.preload = 'auto';
		if (url.startsWith('blob:') || url.startsWith('http')) {
			video.crossOrigin = 'anonymous';
		}
		video.dataset.src = url;
		video.src = url;
		await new Promise<void>((resolve, reject) => {
			const onReady = () => {
				cleanup();
				resolve();
			};
			const onError = () => {
				cleanup();
				reject(new Error('video load failed'));
			};
			const cleanup = () => {
				video.removeEventListener('loadeddata', onReady);
				video.removeEventListener('error', onError);
			};
			video.addEventListener('loadeddata', onReady, { once: true });
			video.addEventListener('error', onError, { once: true });
		});
		videoEl = video;
		return video;
	}

	async function paintFilmstrip(token: number) {
		const canvas = canvasEl;
		const url = videoUrl;
		if (!canvas || !url || durationMs < 200) {
			clearCanvas();
			status = 'idle';
			return;
		}

		const key = mediaKey(url, durationMs);
		// Zoom / lane resize only — stretch the existing strip.
		if (status === 'ready' && paintedKey === key && canvas.width > 1) {
			applyDisplaySize();
			return;
		}

		if (isTimelineScrubbing() || scrubPaused) {
			return;
		}

		status = 'loading';
		try {
			const video = await ensureVideo(url);
			if (token !== genToken) return;

			const h = Math.max(24, Math.round(heightPx));
			const aspect =
				video.videoWidth > 0 && video.videoHeight > 0
					? video.videoWidth / video.videoHeight
					: 16 / 9;
			const tileW = Math.max(28, Math.round(h * aspect));
			const count = Math.min(36, Math.max(8, Math.ceil(PAINT_WIDTH / (tileW + TILE_GAP))));
			const paintW = Math.max(PAINT_WIDTH, count * (tileW + TILE_GAP));
			const stepPx = paintW / count;
			const drawTileW = Math.max(1, stepPx - TILE_GAP);
			const dpr = Math.min(2, window.devicePixelRatio || 1);

			canvas.width = Math.max(1, Math.round(paintW * dpr));
			canvas.height = Math.round(h * dpr);

			const ctx = canvas.getContext('2d');
			if (!ctx) {
				status = 'error';
				return;
			}
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			ctx.fillStyle = 'oklch(0.22 0.02 260)';
			ctx.fillRect(0, 0, paintW, h);

			const mediaSec = Math.max(0.05, Math.min(durationMs / 1000, video.duration || durationMs / 1000));

			for (let i = 0; i < count; i++) {
				if (token !== genToken || isTimelineScrubbing() || scrubPaused) {
					disposeVideo();
					return;
				}
				const t = Math.min(mediaSec - 0.04, ((i + 0.5) / count) * mediaSec);
				try {
					await waitSeek(video, t);
				} catch {
					continue;
				}
				if (token !== genToken || isTimelineScrubbing() || scrubPaused) {
					disposeVideo();
					return;
				}

				const x = i * stepPx;
				const drawW = Math.min(drawTileW, paintW - x);
				if (drawW <= 0) break;
				ctx.drawImage(video, x, 0, drawW, h);
				ctx.fillStyle = 'oklch(0 0 0 / 18%)';
				ctx.fillRect(x + drawW - 1, 0, 1, h);
			}

			disposeVideo();
			if (token === genToken && !isTimelineScrubbing()) {
				paintedKey = key;
				status = 'ready';
				applyDisplaySize();
			}
		} catch {
			disposeVideo();
			if (token === genToken) {
				paintedKey = '';
				status = 'error';
			}
		}
	}

	function schedulePaint() {
		if (debounceTimer) clearTimeout(debounceTimer);
		const token = ++genToken;
		debounceTimer = window.setTimeout(() => {
			debounceTimer = 0;
			void paintFilmstrip(token);
		}, 220);
	}

	$effect(() => {
		// Rebuild only when the media itself changes — not on zoom.
		void videoUrl;
		void durationMs;
		if (!videoUrl) {
			genToken += 1;
			if (debounceTimer) clearTimeout(debounceTimer);
			debounceTimer = 0;
			disposeVideo();
			clearCanvas();
			status = 'idle';
			return;
		}
		schedulePaint();
	});

	$effect(() => {
		// Cheap CSS stretch when the lane zooms / resizes.
		void widthPx;
		void heightPx;
		applyDisplaySize();
	});

	$effect(() => {
		const unsub = onTimelineScrubbing((active) => {
			scrubPaused = active;
			if (active) {
				genToken += 1;
				disposeVideo();
				return;
			}
			// Only resume a build if we don't already have a strip for this media.
			const url = videoUrl;
			if (url && (status !== 'ready' || paintedKey !== mediaKey(url, durationMs))) {
				schedulePaint();
			}
		});
		return unsub;
	});

	onDestroy(() => {
		genToken += 1;
		if (debounceTimer) clearTimeout(debounceTimer);
		disposeVideo();
	});
</script>

<div
	class={['timeline-filmstrip relative h-full w-full overflow-hidden', className].filter(Boolean).join(' ')}
	data-status={status}
>
	<canvas bind:this={canvasEl} class="timeline-filmstrip-canvas pointer-events-none absolute inset-y-0 left-0"></canvas>
	{#if !videoUrl}
		<div class="timeline-filmstrip-empty absolute inset-0 flex items-center px-3">
			<span class="text-[10px] text-muted-foreground">Import a video to show frame previews</span>
		</div>
	{:else if status === 'error'}
		<div class="timeline-filmstrip-empty absolute inset-0 flex items-center px-3">
			<span class="text-[10px] text-muted-foreground">Couldn’t read video frames</span>
		</div>
	{:else if status === 'loading'}
		<div class="timeline-filmstrip-loading absolute inset-0" aria-hidden="true"></div>
	{/if}
</div>

<style>
	.timeline-filmstrip {
		border-radius: 0.35rem;
		background: color-mix(in oklab, var(--track-video, var(--track-subs)) 8%, var(--surface-timeline-deep));
	}

	.timeline-filmstrip-canvas {
		display: block;
		/* Stretch painted frames across the lane — no re-decode on zoom. */
		object-fit: fill;
	}

	.timeline-filmstrip-empty {
		background: color-mix(in oklab, var(--track-video, var(--track-subs)) 6%, transparent);
		border: 1px dashed color-mix(in oklab, var(--track-video, var(--track-subs)) 30%, var(--border));
		border-radius: 0.45rem;
		margin: 0.35rem 0.25rem;
		inset: 0.35rem 0.25rem !important;
	}

	.timeline-filmstrip-loading {
		background: linear-gradient(
			90deg,
			transparent,
			color-mix(in oklab, white 8%, transparent),
			transparent
		);
		background-size: 200% 100%;
		animation: filmstrip-shimmer 1.2s ease-in-out infinite;
		opacity: 0.35;
		pointer-events: none;
	}

	@keyframes filmstrip-shimmer {
		0% {
			background-position: 100% 0;
		}
		100% {
			background-position: -100% 0;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.timeline-filmstrip-loading {
			animation: none;
			opacity: 0.15;
		}
	}
</style>
