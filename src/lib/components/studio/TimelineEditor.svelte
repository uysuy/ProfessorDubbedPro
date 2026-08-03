<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { Slider } from '$lib/components/ui/slider/index.js';
	import * as Tooltip from '$lib/components/ui/tooltip/index.js';
	import Waveform from '$lib/components/studio/Waveform.svelte';
	import { playback, projectStore } from '$lib/stores/project.svelte';
	import { getVisualPlayheadMs, setVisualPlayheadMs } from '$lib/stores/playback-clock';
	import { formatTimecode } from '$lib/utils/time';
	import { usesKhmerScript, normalizeDubLanguage } from '$lib/stores/preferences.svelte';
	import {
		LABEL_WIDTH,
		MAX_ZOOM,
		RULER_HEIGHT,
		TIMELINE_TRACKS,
		buildRulerTicks,
		fitZoom,
		minZoomForView,
		msToX,
		snapCueStartMs,
		timelineWidthPx,
		xToMs,
		deltaXToMs
	} from '$lib/utils/timeline';
	import { resamplePeaks } from '$lib/utils/audio-waveform';
	import { Pause, Play, Scan, ZoomIn, ZoomOut } from '@lucide/svelte';
	import { dndStore, MIME_TTS_AUDIO } from '$lib/stores/dnd.svelte';
	import { onDestroy } from 'svelte';

	let zoom = $state(1.75);
	/** Geometry zoom — clip/tick positions. Stable during live zoom gestures. */
	let layoutZoom = $state(1.75);

	const clipUsesKhmer = $derived(
		usesKhmerScript(normalizeDubLanguage(projectStore.current.targetLanguage))
	);
	let scrollEl: HTMLDivElement | undefined = $state();
	let contentEl: HTMLDivElement | undefined = $state();
	let playheadEl: HTMLDivElement | undefined = $state();
	let playheadLabelEl: HTMLDivElement | undefined = $state();
	let isScrubbing = $state(false);
	/** Local scrub position — keeps the red line 1:1 with the pointer (like a slider thumb). */
	let scrubMs = $state<number | null>(null);
	let pendingCommitMs: number | null = null;
	let commitRaf = 0;
	/** Latest pointer X while scrubbing — drives edge auto-pan (Shift+wheel feel). */
	let scrubPointerClientX = 0;
	let scrubPanRaf = 0;

	/** Playhead-anchored zoom — capture once per gesture so slider drag stays fluid. */
	let zoomAnchorMs = 0;
	let zoomAnchorViewportX = 0;
	let zoomGestureActive = false;
	let isZoomLive = $state(false);
	let pendingZoomVisual: number | null = null;
	let zoomVisualRaf = 0;

	type ClipDragState = {
		id: string;
		trackKind: 'subtitles' | 'tts';
		startMs: number;
		endMs: number;
		originClientX: number;
		originStartMs: number;
		durationMs: number;
		moved: boolean;
		guideMs: number | null;
		snapKind: 'playhead' | 'edge' | null;
		pointerId: number;
	};

	let clipDrag = $state<ClipDragState | null>(null);
	let clipDragMoveRaf = 0;
	let pendingDragClientX: number | null = null;

	type ClipTrimState = {
		id: string;
		trackKind: 'subtitles' | 'tts';
		edge: 'start' | 'end';
		startMs: number;
		endMs: number;
		originStartMs: number;
		originEndMs: number;
		originClientX: number;
		active: boolean;
		pointerId: number;
	};

	let clipTrim = $state<ClipTrimState | null>(null);
	let clipTrimMoveRaf = 0;
	let pendingTrimClientX: number | null = null;

	const MIN_TRIM_DURATION_MS = 200;

	const duration = $derived(projectStore.current.durationMs);
	/** Scroller width minus sticky labels — used for fit / min zoom. */
	let viewportContentPx = $state(900);
	/** Visual timeline width (scrollbar / playhead space). */
	const widthPx = $derived(timelineWidthPx(duration, zoom));
	/** Layout width under the scale layer (frozen while dragging the zoom slider). */
	const layoutWidthPx = $derived(timelineWidthPx(duration, layoutZoom));
	const zoomScale = $derived(zoom / layoutZoom);
	const ticks = $derived(buildRulerTicks(duration, layoutZoom));
	const displayMs = $derived(scrubMs ?? playback.playheadMs);
	const tracksHeight = $derived(TIMELINE_TRACKS.reduce((sum, t) => sum + t.height, 0));
	const originalAudio = $derived(projectStore.originalAudio);
	/** Zoom out until the full project fits (was a fixed 0.5× that still scrolled). */
	const effectiveMinZoom = $derived(minZoomForView(duration, viewportContentPx));

	const isClipMoving = $derived(clipDrag != null || clipTrim != null);

	function clampZoom(value: number) {
		return Math.min(MAX_ZOOM, Math.max(effectiveMinZoom, Number(value.toFixed(3))));
	}

	function fitTimelineToView() {
		const z = fitZoom(duration, viewportContentPx);
		zoomAnchorMs = 0;
		zoomAnchorViewportX = LABEL_WIDTH;
		isZoomLive = true;
		applyZoomVisual(z, true);
		bakeZoomLayout();
		isZoomLive = false;
		if (scrollEl) scrollEl.scrollLeft = 0;
	}

	function capturePlayheadAnchor() {
		zoomAnchorMs = displayMs;
		if (!scrollEl) {
			zoomAnchorViewportX = 240;
			return;
		}
		zoomAnchorViewportX = LABEL_WIDTH + msToX(displayMs, zoom) - scrollEl.scrollLeft;
	}

	function captureMouseAnchor(clientX: number) {
		if (!scrollEl) {
			capturePlayheadAnchor();
			return;
		}
		const rect = scrollEl.getBoundingClientRect();
		zoomAnchorViewportX = clientX - rect.left;
		const contentX = Math.max(0, scrollEl.scrollLeft + zoomAnchorViewportX - LABEL_WIDTH);
		zoomAnchorMs = xToMs(contentX, zoom, duration);
	}

	function syncScrollToAnchor() {
		if (!scrollEl) return;
		const contentX = msToX(zoomAnchorMs, zoom);
		scrollEl.scrollLeft = Math.max(0, LABEL_WIDTH + contentX - zoomAnchorViewportX);
	}

	function setContentWidthForZoom(z: number) {
		if (!contentEl) return;
		const w = `${LABEL_WIDTH + timelineWidthPx(duration, z)}px`;
		contentEl.style.width = w;
		contentEl.style.minWidth = w;
	}

	/** Flush coalesced visual zoom (one paint per frame). */
	let zoomBakeTimer = 0;

	function flushZoomVisual() {
		zoomVisualRaf = 0;
		if (pendingZoomVisual == null) return;
		zoom = pendingZoomVisual;
		pendingZoomVisual = null;
		setContentWidthForZoom(zoom);
		syncScrollToAnchor();
		paintPlayhead(scrubMs ?? (playback.isPlaying ? getVisualPlayheadMs() : displayMs));
	}

	/** Visual-only zoom — GPU scale/scroll; clip geometry stays on layoutZoom. */
	function applyZoomVisual(next: number, immediate = false) {
		const z = clampZoom(next);
		if (immediate) {
			pendingZoomVisual = null;
			if (zoomVisualRaf) {
				cancelAnimationFrame(zoomVisualRaf);
				zoomVisualRaf = 0;
			}
			zoom = z;
			setContentWidthForZoom(zoom);
			syncScrollToAnchor();
			const ms = scrubMs ?? (playback.isPlaying ? getVisualPlayheadMs() : displayMs);
			paintPlayhead(ms);
			return;
		}
		pendingZoomVisual = z;
		if (!zoomVisualRaf) {
			zoomVisualRaf = requestAnimationFrame(flushZoomVisual);
		}
	}

	function bakeZoomLayout() {
		if (pendingZoomVisual != null) flushZoomVisual();
		if (Math.abs(layoutZoom - zoom) < 0.0005) return;
		layoutZoom = zoom;
		setContentWidthForZoom(zoom);
		syncScrollToAnchor();
		const ms = scrubMs ?? (playback.isPlaying ? getVisualPlayheadMs() : displayMs);
		paintPlayhead(ms);
	}

	function beginZoomGesture(clientX?: number | null) {
		if (zoomGestureActive) return;
		// Keep layoutZoom frozen — assigning it here used to force an expensive bake.
		zoomGestureActive = true;
		isZoomLive = true;
		if (clientX != null) captureMouseAnchor(clientX);
		else capturePlayheadAnchor();
	}

	/** Bake geometry after a live zoom gesture. */
	function endZoomGesture() {
		if (zoomBakeTimer) {
			clearTimeout(zoomBakeTimer);
			zoomBakeTimer = 0;
		}
		if (!isZoomLive && !zoomGestureActive) return;
		zoomGestureActive = false;
		bakeZoomLayout();
		isZoomLive = false;
	}

	/** Schedule a single bake after wheel zoom settles (avoids mid-play flicker). */
	function scheduleZoomBake(delayMs = 160) {
		if (zoomBakeTimer) clearTimeout(zoomBakeTimer);
		zoomBakeTimer = window.setTimeout(() => {
			zoomBakeTimer = 0;
			endZoomGesture();
		}, delayMs);
	}

	/** +/- : one visual step then bake geometry once. */
	function zoomBy(delta: number) {
		endZoomGesture();
		capturePlayheadAnchor();
		isZoomLive = true;
		applyZoomVisual(zoom + delta, true);
		bakeZoomLayout();
		isZoomLive = false;
	}

	/** Slider: GPU scale while dragging; bake on release. */
	function onZoomSlider(v: number) {
		beginZoomGesture();
		applyZoomVisual(v);
	}

	function onZoomSliderCommit() {
		endZoomGesture();
	}

	/**
	 * Ctrl/Meta + wheel zooms (trackpad pinch also sends ctrlKey on many platforms).
	 * Plain wheel, Shift+wheel, and trackpad swipes pan the timeline horizontally
	 * (same axis as Shift+scroll — time is the primary scroll direction).
	 */
	function onTimelineWheel(e: WheelEvent) {
		if (e.ctrlKey || e.metaKey) {
			e.preventDefault();
			e.stopPropagation();

			let dy = e.deltaY;
			if (e.deltaMode === 1) dy *= 16; // lines → px
			if (e.deltaMode === 2) dy *= heightPxHint(); // pages

			// Mice send big notches; trackpads send small pixel deltas.
			const intensity =
				Math.abs(dy) >= 40
					? Math.min(0.32, Math.abs(dy) * 0.0022)
					: Math.min(0.18, Math.max(0.035, Math.abs(dy) * 0.0035));
			const dir = dy > 0 ? -1 : 1;

			const base = pendingZoomVisual ?? zoom;
			beginZoomGesture(e.clientX);
			applyZoomVisual(base + dir * intensity);
			scheduleZoomBake(playback.isPlaying ? 220 : 160);
			return;
		}

		const scroller = scrollEl;
		if (!scroller) return;

		// User is looking around — don't yank scroll back to the playhead.
		suppressChase(1200);

		let dx = e.deltaX;
		let dy = e.deltaY;
		if (e.deltaMode === 1) {
			dx *= 16;
			dy *= 16;
		} else if (e.deltaMode === 2) {
			dx *= scroller.clientWidth;
			dy *= heightPxHint();
		}

		// Shift+wheel: delta comes on Y — treat as horizontal pan.
		if (e.shiftKey && Math.abs(dx) < Math.abs(dy)) dx = dy;
		// Plain vertical wheel over the timeline → horizontal pan (DAW-style).
		else if (!e.shiftKey && Math.abs(dx) <= Math.abs(dy)) dx = dy;

		if (dx === 0) return;
		e.preventDefault();
		scroller.scrollLeft += dx;
	}

	function heightPxHint() {
		return scrollEl?.clientHeight || 240;
	}

	function paintPlayhead(ms: number) {
		if (!playheadEl) return;
		const z = zoom;
		const scrollLeft = scrollEl?.scrollLeft ?? 0;
		// Viewport X inside the lane overlay (overlay already starts after LABEL_WIDTH).
		// Clipped when off-screen — never drawn under sticky track labels.
		const x = Math.round(msToX(ms, z) - scrollLeft);
		playheadEl.style.transform = `translate3d(${x}px, 0, 0)`;
		playheadEl.style.height = `${RULER_HEIGHT + tracksHeight}px`;
		if (playheadLabelEl) {
			playheadLabelEl.textContent = formatTimecode(ms, projectStore.current.fps);
			const width = timelineWidthPx(duration, z);
			playheadLabelEl.classList.toggle(
				'timeline-playhead-label-left',
				msToX(ms, z) > width - 72
			);
		}
	}

	/**
	 * During playback only: keep the needle clear of the label column.
	 * When paused, the user pans freely — the viewport overlay clips the needle.
	 */
	function ensurePlayheadInLane(ms: number) {
		const scroller = scrollEl;
		if (!scroller || !playback.isPlaying) return;
		if (performance.now() < chaseSuppressedUntil) return;
		const playheadX = LABEL_WIDTH + msToX(ms, zoom);
		const minViewX = LABEL_WIDTH + 14;
		const viewX = playheadX - scroller.scrollLeft;
		if (viewX < minViewX) {
			scroller.scrollLeft = Math.max(0, Math.round(playheadX - minViewX));
		}
	}

	/**
	 * FL Studio follow (native scroll only):
	 * When the playhead crosses the right pin (~72% of the viewport), scroll
	 * forward 1:1 so the needle stays fixed and content slides under it.
	 * Integer pixels + forward-only avoids the edge shake from subpixel fight.
	 */
	let chaseSuppressedUntil = 0;

	function clearFollowTransform() {
		if (contentEl?.style.transform) contentEl.style.transform = '';
	}

	function suppressChase(ms = 800) {
		chaseSuppressedUntil = performance.now() + ms;
	}

	function ensureTimelineWidth(z = zoom) {
		if (!contentEl) return LABEL_WIDTH + timelineWidthPx(duration, z);
		const contentW = LABEL_WIDTH + timelineWidthPx(duration, z);
		const nextW = `${contentW}px`;
		if (contentEl.style.width !== nextW) {
			contentEl.style.width = nextW;
			contentEl.style.minWidth = nextW;
		}
		return contentW;
	}

	function autoSlideTimeline(ms: number, now: number) {
		const scroller = scrollEl;
		// Auto-follow only while playing — paused zoom/pan must not move the tracks.
		if (!playback.isPlaying || !scroller || isScrubbing || isZoomLive) return;
		if (now < chaseSuppressedUntil) return;

		const z = zoom;
		const contentW = ensureTimelineWidth(z);
		const viewW = scroller.clientWidth || 1;
		// Integer maxScroll — fractional clientWidth + scrollbar toggles caused edge shake.
		const maxScroll = Math.max(0, Math.floor(contentW - viewW));
		// Not enough room to follow without fighting the clamp (common at low zoom).
		if (maxScroll < 2) return;

		clearFollowTransform();

		// Same rounding as paintPlayhead — keeps needle and scroll in lockstep.
		const playheadX = Math.round(LABEL_WIDTH + msToX(ms, z));
		// Near the media end: pin to maxScroll so we don't leave a hollow gutter after the last frame.
		const endX = LABEL_WIDTH + timelineWidthPx(duration, z);
		if (playheadX >= endX - 2) {
			if (Math.round(scroller.scrollLeft) < maxScroll) scroller.scrollLeft = maxScroll;
			return;
		}

		// Pin near the right third — FL-style push, not page-jump.
		const pinX = Math.round(Math.max(LABEL_WIDTH + 120, viewW * 0.72));
		const current = Math.round(scroller.scrollLeft);
		const desired = playheadX - pinX;

		// Forward-only: never pull scrollLeft back during playback follow.
		if (desired <= current) return;

		const target = Math.min(maxScroll, desired);
		if (target <= current) return;
		scroller.scrollLeft = target;
	}

	function cueDisplayTimes(
		cue: {
			id: string;
			startMs: number;
			endMs: number;
			assignedAudio?: { durationMs?: number | null } | null;
		},
		trackKind: 'subtitles' | 'tts'
	) {
		if (clipTrim?.active && clipTrim.id === cue.id && clipTrim.trackKind === trackKind) {
			return { startMs: clipTrim.startMs, endMs: clipTrim.endMs };
		}
		if (
			clipDrag?.moved &&
			clipDrag.id === cue.id &&
			clipDrag.trackKind === trackKind
		) {
			return { startMs: clipDrag.startMs, endMs: clipDrag.endMs };
		}
		// TTS clips: lip-synced audio stays on the video cue window; otherwise show full speech.
		if (trackKind === 'tts') {
			const fit = (cue.assignedAudio as { fitPlaybackRate?: number } | null | undefined)
				?.fitPlaybackRate;
			if (typeof fit === 'number' && fit > 0) {
				return { startMs: cue.startMs, endMs: cue.endMs };
			}
			const audioDur = cue.assignedAudio?.durationMs;
			if (typeof audioDur === 'number' && audioDur > 0) {
				return {
					startMs: cue.startMs,
					endMs: Math.max(cue.endMs, cue.startMs + Math.round(audioDur))
				};
			}
		}
		return { startMs: cue.startMs, endMs: cue.endMs };
	}

	function isClipPreview(cueId: string, trackKind: 'subtitles' | 'tts') {
		return Boolean(
			clipDrag?.moved && clipDrag.id === cueId && clipDrag.trackKind === trackKind
		);
	}

	function isClipTrimming(cueId: string, trackKind: 'subtitles' | 'tts') {
		return Boolean(
			clipTrim?.active && clipTrim.id === cueId && clipTrim.trackKind === trackKind
		);
	}

	function applyClipDragVisual(clientX: number) {
		if (!clipDrag) return;
		const dx = clientX - clipDrag.originClientX;
		if (!clipDrag.moved && Math.abs(dx) < 3) return;

		const deltaMs = deltaXToMs(dx, zoom);
		const rawStart = clipDrag.originStartMs + deltaMs;
		const others = projectStore.current.cues
			.filter((c) => c.id !== clipDrag!.id)
			.map((c) => ({ startMs: c.startMs, endMs: c.endMs }));
		const snapped = snapCueStartMs({
			startMs: rawStart,
			durationMs: clipDrag.durationMs,
			timelineDurationMs: duration,
			zoom,
			playheadMs: playback.playheadMs,
			others
		});

		const playhead = playback.playheadMs;
		const snapKind: ClipDragState['snapKind'] =
			snapped.guideMs == null
				? null
				: Math.abs(snapped.guideMs - playhead) < 1
					? 'playhead'
					: 'edge';

		clipDrag = {
			...clipDrag,
			moved: true,
			startMs: snapped.startMs,
			endMs: snapped.startMs + clipDrag.durationMs,
			guideMs: snapped.guideMs,
			snapKind
		};
	}

	function commitPlayhead(ms: number) {
		pendingCommitMs = ms;
		setVisualPlayheadMs(ms, { seekMedia: true });
		if (commitRaf) return;
		commitRaf = requestAnimationFrame(() => {
			commitRaf = 0;
			if (pendingCommitMs == null) return;
			projectStore.setPlayhead(pendingCommitMs);
			setVisualPlayheadMs(pendingCommitMs, { seekMedia: true });
			pendingCommitMs = null;
		});
	}

	function seekFromClientX(clientX: number, immediate = false) {
		if (!scrollEl) return;
		const rect = scrollEl.getBoundingClientRect();
		const x = Math.max(0, clientX - rect.left + scrollEl.scrollLeft - LABEL_WIDTH);
		const ms = xToMs(x, zoom, duration);
		setVisualPlayheadMs(ms, { seekMedia: true });
		paintPlayhead(ms);
		if (isScrubbing) {
			scrubMs = ms;
			if (immediate) projectStore.setPlayhead(ms);
			else commitPlayhead(ms);
			return;
		}
		projectStore.setPlayhead(ms);
	}

	/**
	 * While holding/dragging the playhead when zoomed in: pan the timeline
	 * horizontally when the pointer nears either lane edge (same idea as Shift+wheel).
	 */
	function stopScrubEdgePan() {
		if (scrubPanRaf) {
			cancelAnimationFrame(scrubPanRaf);
			scrubPanRaf = 0;
		}
	}

	function scrubEdgePanTick() {
		scrubPanRaf = 0;
		if (!isScrubbing || !scrollEl) return;

		const scroller = scrollEl;
		const rect = scroller.getBoundingClientRect();
		const laneLeft = rect.left + LABEL_WIDTH;
		const laneRight = rect.right;
		const edge = Math.min(72, Math.max(36, (laneRight - laneLeft) * 0.12));
		const x = scrubPointerClientX;

		let dx = 0;
		if (x >= laneRight - edge) {
			const t = Math.min(1, Math.max(0, (x - (laneRight - edge)) / edge));
			dx = 4 + t * 36;
		} else if (x <= laneLeft + edge) {
			const t = Math.min(1, Math.max(0, (laneLeft + edge - x) / edge));
			dx = -(4 + t * 36);
		} else if (x > laneRight) {
			dx = 40;
		} else if (x < laneLeft) {
			dx = -40;
		}

		if (dx !== 0) {
			const maxScroll = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
			const next = Math.max(0, Math.min(maxScroll, scroller.scrollLeft + dx));
			if (next !== scroller.scrollLeft) {
				scroller.scrollLeft = next;
				seekFromClientX(scrubPointerClientX);
			}
		}

		scrubPanRaf = requestAnimationFrame(scrubEdgePanTick);
	}

	function startScrubEdgePan() {
		if (scrubPanRaf) return;
		scrubPanRaf = requestAnimationFrame(scrubEdgePanTick);
	}

	function onContentPointerDown(e: PointerEvent & { currentTarget: HTMLElement }) {
		const target = e.target as HTMLElement;
		// Don't start scrub on interactive clips — original-audio is decorative only.
		if (target.closest('[data-track-label]')) return;
		if (target.closest('[data-clip]:not(.timeline-clip-original)')) return;

		if (isZoomLive) endZoomGesture();

		// Empty-lane click clears selection (UI only), then scrubs playhead.
		if (!e.shiftKey && !e.ctrlKey && !e.metaKey) {
			projectStore.selectAllCues(false);
		}

		e.preventDefault();
		suppressChase(600);
		isScrubbing = true;
		scrubPointerClientX = e.clientX;
		e.currentTarget.setPointerCapture(e.pointerId);
		seekFromClientX(e.clientX, true);
		startScrubEdgePan();
	}

	function onContentPointerMove(e: PointerEvent) {
		if (!isScrubbing) return;
		scrubPointerClientX = e.clientX;
		seekFromClientX(e.clientX);
	}

	function onContentPointerUp(e: PointerEvent & { currentTarget: HTMLElement }) {
		if (!isScrubbing) return;
		isScrubbing = false;
		stopScrubEdgePan();
		if (scrubMs != null) {
			setVisualPlayheadMs(scrubMs, { seekMedia: true });
			projectStore.setPlayhead(scrubMs);
			paintPlayhead(scrubMs);
			scrubMs = null;
		}
		pendingCommitMs = null;
		if (commitRaf) {
			cancelAnimationFrame(commitRaf);
			commitRaf = 0;
		}
		try {
			e.currentTarget.releasePointerCapture(e.pointerId);
		} catch {
			/* already released */
		}
	}

	/** Shared selection API with the subtitle table (visual only). */
	function applyClipSelection(e: PointerEvent, cueId: string): 'single' | 'toggle' | 'range' {
		if (e.shiftKey) {
			projectStore.selectCueAt(cueId, { range: true });
			return 'range';
		}
		if (e.metaKey || e.ctrlKey) {
			projectStore.selectCueAt(cueId, { toggle: true });
			return 'toggle';
		}
		projectStore.selectCueAt(cueId);
		return 'single';
	}

	function revealCueInTable(cueId: string) {
		const row = document.querySelector(`.cue-row[data-cue-id="${CSS.escape(cueId)}"]`);
		row?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
	}

	function onClipPointerDown(
		e: PointerEvent & { currentTarget: HTMLElement },
		cueId: string,
		startMs: number,
		endMs: number,
		trackKind: 'subtitles' | 'tts'
	) {
		// Alt+drag on TTS keeps HTML5 assign-to-row gesture.
		if (e.altKey) return;
		if ((e.target as HTMLElement).closest('[data-trim-handle]')) return;
		if ((e.target as HTMLElement).closest('.timeline-tts-play')) return;

		// Bake any live wheel/slider zoom so hit-testing matches geometry.
		if (isZoomLive) endZoomGesture();

		e.preventDefault();
		e.stopPropagation();

		const mode = applyClipSelection(e, cueId);
		revealCueInTable(cueId);

		// Shift / Ctrl multi-select is selection-only (no retime drag).
		if (mode !== 'single') return;

		const durationMs = Math.max(1, endMs - startMs);
		clipDrag = {
			id: cueId,
			trackKind,
			startMs,
			endMs,
			originClientX: e.clientX,
			originStartMs: startMs,
			durationMs,
			moved: false,
			guideMs: null,
			snapKind: null,
			pointerId: e.pointerId
		};
		try {
			e.currentTarget.setPointerCapture(e.pointerId);
		} catch {
			/* ignore */
		}
	}

	function onClipPointerMove(e: PointerEvent) {
		if (!clipDrag || e.pointerId !== clipDrag.pointerId) return;
		pendingDragClientX = e.clientX;
		if (clipDragMoveRaf) return;
		clipDragMoveRaf = requestAnimationFrame(() => {
			clipDragMoveRaf = 0;
			if (pendingDragClientX == null) return;
			applyClipDragVisual(pendingDragClientX);
			pendingDragClientX = null;
		});
	}

	function onClipPointerUp(e: PointerEvent) {
		if (!clipDrag || e.pointerId !== clipDrag.pointerId) return;
		const drag = clipDrag;

		if (clipDragMoveRaf) {
			cancelAnimationFrame(clipDragMoveRaf);
			clipDragMoveRaf = 0;
		}
		pendingDragClientX = null;
		clipDrag = null;

		// Plain click on a timeline clip only selects — do not move the playhead.
		// Seeking to cue start is handled by the subtitle table (top panel) on row select.

		try {
			(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
		} catch {
			/* ignore */
		}
	}

	function applyClipTrimVisual(clientX: number) {
		if (!clipTrim) return;
		const dx = clientX - clipTrim.originClientX;
		if (!clipTrim.active && Math.abs(dx) < 2) return;

		const deltaMs = deltaXToMs(dx, zoom);
		const minDur = Math.max(MIN_TRIM_DURATION_MS, deltaXToMs(14, zoom));
		let nextStart = clipTrim.originStartMs;
		let nextEnd = clipTrim.originEndMs;

		if (clipTrim.edge === 'start') {
			nextStart = Math.max(
				0,
				Math.min(clipTrim.originEndMs - minDur, clipTrim.originStartMs + deltaMs)
			);
		} else {
			nextEnd = Math.min(
				duration,
				Math.max(clipTrim.originStartMs + minDur, clipTrim.originEndMs + deltaMs)
			);
		}

		clipTrim = {
			...clipTrim,
			active: true,
			startMs: Math.round(nextStart),
			endMs: Math.round(nextEnd)
		};

		// Live-sync subtitle table + push neighbors so clips never overlap.
		if (clipTrim.trackKind === 'subtitles') {
			projectStore.trimCuePushNeighbors(
				clipTrim.id,
				clipTrim.edge,
				clipTrim.startMs,
				clipTrim.endMs,
				minDur
			);
			const committed = projectStore.current.cues.find((c) => c.id === clipTrim!.id);
			if (committed) {
				clipTrim = {
					...clipTrim,
					startMs: committed.startMs,
					endMs: committed.endMs
				};
			}
		}
	}

	function onTrimPointerDown(
		e: PointerEvent & { currentTarget: HTMLElement },
		cueId: string,
		startMs: number,
		endMs: number,
		edge: 'start' | 'end',
		trackKind: 'subtitles' | 'tts'
	) {
		e.preventDefault();
		e.stopPropagation();

		if (isZoomLive) endZoomGesture();

		projectStore.selectCueAt(cueId);
		revealCueInTable(cueId);
		clipDrag = null;

		clipTrim = {
			id: cueId,
			trackKind,
			edge,
			startMs,
			endMs,
			originStartMs: startMs,
			originEndMs: endMs,
			originClientX: e.clientX,
			active: false,
			pointerId: e.pointerId
		};

		try {
			e.currentTarget.setPointerCapture(e.pointerId);
		} catch {
			/* ignore */
		}
	}

	function onTrimPointerMove(e: PointerEvent) {
		if (!clipTrim || e.pointerId !== clipTrim.pointerId) return;
		pendingTrimClientX = e.clientX;
		if (clipTrimMoveRaf) return;
		clipTrimMoveRaf = requestAnimationFrame(() => {
			clipTrimMoveRaf = 0;
			if (pendingTrimClientX == null) return;
			applyClipTrimVisual(pendingTrimClientX);
			pendingTrimClientX = null;
		});
	}

	function onTrimPointerUp(e: PointerEvent) {
		if (!clipTrim || e.pointerId !== clipTrim.pointerId) return;

		if (clipTrimMoveRaf) {
			cancelAnimationFrame(clipTrimMoveRaf);
			clipTrimMoveRaf = 0;
		}
		if (pendingTrimClientX != null) {
			applyClipTrimVisual(pendingTrimClientX);
			pendingTrimClientX = null;
		}

		const trim = clipTrim;
		clipTrim = null;

		// Final commit for subtitles (neighbors already pushed during drag).
		if (trim.trackKind === 'subtitles' && trim.active) {
			const minDur = Math.max(MIN_TRIM_DURATION_MS, deltaXToMs(14, zoom));
			projectStore.trimCuePushNeighbors(
				trim.id,
				trim.edge,
				trim.startMs,
				trim.endMs,
				minDur
			);
		}

		try {
			(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
		} catch {
			/* ignore */
		}
	}

	function onTtsDragStart(e: DragEvent, cueId: string, index: number) {
		// Only allow HTML5 assign-drag with Alt held (normal drag moves timing).
		if (!e.altKey) {
			e.preventDefault();
			return;
		}
		if (!e.dataTransfer) return;
		e.stopPropagation();
		e.dataTransfer.effectAllowed = 'copy';
		e.dataTransfer.setData(MIME_TTS_AUDIO, cueId);
		e.dataTransfer.setData('text/plain', cueId);
		const blank = document.createElement('canvas');
		blank.width = 1;
		blank.height = 1;
		e.dataTransfer.setDragImage(blank, 0, 0);
		dndStore.start(
			{
				kind: 'tts-audio',
				id: cueId,
				label: `TTS #${index}`,
				subtitle: 'Drop on a subtitle row'
			},
			e.clientX,
			e.clientY
		);
	}

	function onTtsDrag(e: DragEvent) {
		if (e.clientX || e.clientY) dndStore.move(e.clientX, e.clientY);
	}

	function onTtsDragEnd() {
		dndStore.end();
	}

	$effect(() => {
		const el = scrollEl;
		if (!el || typeof ResizeObserver === 'undefined') return;
		const measure = () => {
			viewportContentPx = Math.max(120, el.clientWidth - LABEL_WIDTH);
		};
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	});

	/** Keep zoom at/above fit when duration or viewport shrinks. */
	$effect(() => {
		const minZ = effectiveMinZoom;
		if (zoom >= minZ && layoutZoom >= minZ) return;
		const z = minZ;
		zoom = z;
		layoutZoom = z;
		setContentWidthForZoom(z);
		if (scrollEl) scrollEl.scrollLeft = 0;
	});

	$effect(() => {
		// Imperative playhead + FL follow while playing.
		if (!playback.isPlaying || !playheadEl || !scrollEl) return;

		let raf = 0;

		const loop = (now: number) => {
			if (!playback.isPlaying || !playheadEl) {
				raf = 0;
				return;
			}
			const ms = scrubMs ?? getVisualPlayheadMs();
			autoSlideTimeline(ms, now);
			ensurePlayheadInLane(ms);
			paintPlayhead(ms);
			raf = requestAnimationFrame(loop);
		};

		raf = requestAnimationFrame(loop);
		return () => {
			if (raf) cancelAnimationFrame(raf);
		};
	});

	/** Keep playhead painted when paused / scrubbing (no rAF loop). */
	$effect(() => {
		if (playback.isPlaying) return;
		clearFollowTransform();
		void zoom;
		void displayMs;
		void playheadEl;
		void tracksHeight;
		ensureTimelineWidth();
		paintPlayhead(displayMs);
		// Do not ensurePlayheadInLane here — it fought Shift/wheel horizontal pan.
	});

	/** When a single cue is selected (e.g. from the table), bring its clip into view. */
	$effect(() => {
		if (!scrollEl || playback.isPlaying || clipDrag || isScrubbing || isZoomLive) return;
		const id =
			projectStore.selectedCueIds.length === 1 ? projectStore.selectedCueIds[0] : null;
		if (!id) return;
		const clip = scrollEl.querySelector(
			`[data-clip][data-cue-id="${CSS.escape(id)}"]`
		) as HTMLElement | null;
		clip?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'instant' });
	});

	/** Non-passive wheel so Ctrl/Meta + scroll can zoom without browser page-zoom. */
	$effect(() => {
		const el = scrollEl;
		if (!el) return;
		const onWheel = (e: WheelEvent) => onTimelineWheel(e);
		const onScroll = () => {
			// Keep viewport playhead locked to time while the user pans.
			if (playback.isPlaying) return;
			paintPlayhead(scrubMs ?? (getVisualPlayheadMs() || playback.playheadMs));
		};
		el.addEventListener('wheel', onWheel, { passive: false });
		el.addEventListener('scroll', onScroll, { passive: true });
		return () => {
			el.removeEventListener('wheel', onWheel);
			el.removeEventListener('scroll', onScroll);
		};
	});

	onDestroy(() => {
		if (commitRaf) cancelAnimationFrame(commitRaf);
		if (clipDragMoveRaf) cancelAnimationFrame(clipDragMoveRaf);
		if (clipTrimMoveRaf) cancelAnimationFrame(clipTrimMoveRaf);
		if (zoomVisualRaf) cancelAnimationFrame(zoomVisualRaf);
		if (zoomBakeTimer) clearTimeout(zoomBakeTimer);
		stopScrubEdgePan();
	});
</script>

<section class="flex h-full min-h-0 flex-col bg-transparent" data-slot="timeline-editor">
	<div class="panel-header gap-3">
		<span>Timeline Editor</span>

		<div class="flex flex-1 items-center justify-end gap-2 normal-case tracking-normal">
			<span class="hidden text-[10px] text-muted-foreground sm:inline">
				Ctrl+scroll zoom · Fit button = full project in view · Scroll / Shift+scroll pan · Drag playhead
			</span>
			<Tooltip.Provider>
				<div class="flex items-center gap-1 rounded-md border border-border/60 bg-[var(--surface-toolbar)] p-0.5">
					<Button
						variant="ghost"
						size="icon-xs"
						aria-label={playback.isPlaying ? 'Pause' : 'Play'}
						onclick={() => projectStore.togglePlayback()}
					>
						{#if playback.isPlaying}
							<Pause class="size-3.5 fill-current" />
						{:else}
							<Play class="size-3.5 fill-current" />
						{/if}
					</Button>
				</div>

				<Badge variant="secondary" class="font-mono text-[10px] tracking-normal">
					{formatTimecode(displayMs, projectStore.current.fps)}
					<span class="mx-1 opacity-40">/</span>
					{formatTimecode(duration, projectStore.current.fps)}
				</Badge>

				<div
					class="ml-1 flex items-center gap-1.5 rounded-md border border-border/60 bg-[var(--surface-toolbar)] px-1.5 py-0.5"
				>
					<Tooltip.Root>
						<Tooltip.Trigger class="inline-flex">
							{#snippet child({ props })}
								<Button
									{...props}
									variant="ghost"
									size="icon-xs"
									aria-label="Zoom out"
									disabled={zoom <= effectiveMinZoom + 0.001}
									onclick={() => zoomBy(-0.25)}
								>
									<ZoomOut class="size-3.5" />
								</Button>
							{/snippet}
						</Tooltip.Trigger>
						<Tooltip.Content sideOffset={6}>Zoom out</Tooltip.Content>
					</Tooltip.Root>

					<Slider
						type="single"
						class="timeline-zoom-slider w-24"
						value={zoom}
						min={effectiveMinZoom}
						max={MAX_ZOOM}
						step={0.01}
						onValueChange={onZoomSlider}
						onValueCommit={onZoomSliderCommit}
						aria-label="Timeline zoom"
					/>

					<Tooltip.Root>
						<Tooltip.Trigger class="inline-flex">
							{#snippet child({ props })}
								<Button
									{...props}
									variant="ghost"
									size="icon-xs"
									aria-label="Zoom in"
									disabled={zoom >= MAX_ZOOM}
									onclick={() => zoomBy(0.25)}
								>
									<ZoomIn class="size-3.5" />
								</Button>
							{/snippet}
						</Tooltip.Trigger>
						<Tooltip.Content sideOffset={6}>Zoom in</Tooltip.Content>
					</Tooltip.Root>

					<Tooltip.Root>
						<Tooltip.Trigger class="inline-flex">
							{#snippet child({ props })}
								<Button
									{...props}
									variant="ghost"
									size="icon-xs"
									aria-label="Fit timeline to view"
									onclick={fitTimelineToView}
								>
									<Scan class="size-3.5" />
								</Button>
							{/snippet}
						</Tooltip.Trigger>
						<Tooltip.Content sideOffset={6}>Fit to view</Tooltip.Content>
					</Tooltip.Root>

					<span
						class="w-14 text-right font-mono text-[10px] text-muted-foreground"
						title="Timeline zoom (not playback speed)"
						>Zoom {zoom < 1 ? zoom.toFixed(2) : zoom.toFixed(1)}×</span
					>
				</div>
			</Tooltip.Provider>
		</div>
	</div>

	<div class="relative min-h-0 flex-1 overflow-hidden">
		<div
			bind:this={scrollEl}
			class="timeline-scroller absolute inset-0 overflow-x-auto overflow-y-auto"
			data-timeline-scroller
		>
			<div
				bind:this={contentEl}
				class="timeline-content relative touch-none select-none"
				class:timeline-clip-moving={isClipMoving}
				class:timeline-zoom-animating={isZoomLive}
				class:timeline-has-selection={projectStore.selectedCueIds.length > 0}
				style="width: {LABEL_WIDTH + widthPx}px; min-width: {LABEL_WIDTH + widthPx}px; min-height: 100%;"
				role="slider"
				aria-label="Timeline playhead"
				aria-valuemin={0}
				aria-valuemax={duration}
				aria-valuenow={Math.round(displayMs)}
				tabindex="0"
				onpointerdown={onContentPointerDown}
				onpointermove={onContentPointerMove}
				onpointerup={onContentPointerUp}
				onpointercancel={onContentPointerUp}
				onkeydown={(e) => {
					const step = e.shiftKey ? 1000 : 100;
					if (e.key === 'ArrowRight') {
						e.preventDefault();
						const ms = playback.playheadMs + step;
						setVisualPlayheadMs(ms, { seekMedia: true });
						projectStore.setPlayhead(ms);
					}
					if (e.key === 'ArrowLeft') {
						e.preventDefault();
						const ms = playback.playheadMs - step;
						setVisualPlayheadMs(ms, { seekMedia: true });
						projectStore.setPlayhead(ms);
					}
				}}
			>
				<!-- Time ruler -->
				<div
					class="timeline-ruler sticky top-0 z-20 grid"
					style="grid-template-columns: {LABEL_WIDTH}px 1fr; height: {RULER_HEIGHT}px;"
				>
					<div data-track-label class="timeline-ruler-corner"></div>
					<div class="timeline-ruler-lane relative z-0 overflow-hidden" style="width: {widthPx}px;">
						<div
							class="timeline-scale-layer absolute top-0 left-0 h-full"
							style="width: {layoutWidthPx}px; transform-origin: 0 0;{zoomScale === 1
								? ''
								: ` transform: scaleX(${zoomScale});`}"
						>
							{#each ticks as tick}
								<span
									class="absolute bottom-0 w-px {tick.major
										? 'timeline-tick-major'
										: 'timeline-tick-minor'}"
									style="left: {tick.x}px;"
								></span>
								{#if tick.major}
									<span class="timeline-tick-label" style="left: {tick.x}px;">
										{tick.label}
									</span>
								{/if}
							{/each}
						</div>
					</div>
				</div>

				<!-- Tracks -->
				{#each TIMELINE_TRACKS as track (track.id)}
					<div
						class="timeline-track-row grid"
						data-track-kind={track.kind}
						style="grid-template-columns: {LABEL_WIDTH}px 1fr; height: {track.height}px;"
					>
						<div data-track-label class="timeline-track-header">
							<span class="timeline-track-swatch" style="background: {track.color};"></span>
							<div class="min-w-0 flex-1">
								<p class="timeline-track-name">{track.name}</p>
								<p class="timeline-track-role">{track.role}</p>
							</div>
						</div>

						<div class="timeline-track-lane relative z-0 overflow-hidden" style="width: {widthPx}px;">
							<div
								class="timeline-scale-layer absolute inset-y-0 left-0"
								style="width: {layoutWidthPx}px; transform-origin: 0 0;{zoomScale === 1
									? ''
									: ` transform: scaleX(${zoomScale});`}"
							>
							{#each ticks.filter((t) => t.major) as tick}
								<span class="timeline-lane-gridline" style="left: {tick.x}px;"></span>
							{/each}

							{#if track.kind === 'subtitles'}
								{#each projectStore.current.cues as cue (cue.id)}
									{@const times = cueDisplayTimes(cue, 'subtitles')}
									{@const left = msToX(times.startMs, layoutZoom)}
									{@const width = Math.max(28, msToX(times.endMs - times.startMs, layoutZoom))}
									{@const playing = projectStore.isCuePlaying(cue.id)}
									{@const selected = projectStore.selectedCueIds.includes(cue.id)}
									{@const moving = isClipPreview(cue.id, 'subtitles')}
									{@const trimming = isClipTrimming(cue.id, 'subtitles')}
									{@const originLeft = msToX(
										trimming && clipTrim
											? clipTrim.originStartMs
											: cue.startMs,
										layoutZoom
									)}
									{@const originWidth = Math.max(
										28,
										msToX(
											trimming && clipTrim
												? clipTrim.originEndMs - clipTrim.originStartMs
												: cue.endMs - cue.startMs,
											layoutZoom
										)
									)}
									{#if moving || trimming}
										<div
											class="timeline-clip-ghost timeline-clip-subs pointer-events-none absolute overflow-hidden rounded-md border px-1.5"
											style="left: {originLeft}px; width: {originWidth}px;"
											aria-hidden="true"
										>
											<span
												class="block truncate text-[10px] leading-4 opacity-70"
												class:font-khmer={clipUsesKhmer}
											>
												{cue.index}. {cue.translation.trim() || cue.source.trim() || 'New subtitle'}
											</span>
										</div>
									{/if}
									<button
										type="button"
										data-clip
										data-cue-id={cue.id}
										aria-pressed={selected}
										class={[
											'timeline-clip absolute overflow-hidden rounded-md border px-1.5 text-left',
											'timeline-clip-subs',
											selected ? 'timeline-clip-selected' : '',
											playing ? 'timeline-clip-playing' : '',
											moving ? 'timeline-clip-dragging' : '',
											trimming ? 'timeline-clip-trimming' : ''
										]
											.filter(Boolean)
											.join(' ')}
										style="left: {left}px; width: {width}px;"
										title="{cue.index}. {cue.translation.trim() || cue.source.trim() || 'New subtitle'}"
										onpointerdown={(e) =>
											onClipPointerDown(e, cue.id, cue.startMs, cue.endMs, 'subtitles')}
										onpointermove={onClipPointerMove}
										onpointerup={onClipPointerUp}
										onpointercancel={onClipPointerUp}
										onclick={(e) => e.stopPropagation()}
									>
										<span
											class="timeline-clip-label pointer-events-none block truncate text-[10px] leading-4"
											class:font-khmer={clipUsesKhmer}
										>
											{cue.index}. {cue.translation.trim() || cue.source.trim() || 'New subtitle'}
										</span>
										{#if trimming}
											<span class="timeline-trim-badge pointer-events-none">
												{formatTimecode(times.startMs, projectStore.current.fps)}
												–
												{formatTimecode(times.endMs, projectStore.current.fps)}
											</span>
										{/if}
										<span
											data-trim-handle
											class="timeline-trim-handle timeline-trim-handle-start"
											class:timeline-trim-handle-active={trimming && clipTrim?.edge === 'start'}
											role="slider"
											aria-label="Trim start"
											aria-valuemin={0}
											aria-valuemax={cue.endMs}
											aria-valuenow={times.startMs}
											tabindex="-1"
											onpointerdown={(e) =>
												onTrimPointerDown(
													e,
													cue.id,
													cue.startMs,
													cue.endMs,
													'start',
													'subtitles'
												)}
											onpointermove={onTrimPointerMove}
											onpointerup={onTrimPointerUp}
											onpointercancel={onTrimPointerUp}
										></span>
										<span
											data-trim-handle
											class="timeline-trim-handle timeline-trim-handle-end"
											class:timeline-trim-handle-active={trimming && clipTrim?.edge === 'end'}
											role="slider"
											aria-label="Trim end"
											aria-valuemin={cue.startMs}
											aria-valuemax={duration}
											aria-valuenow={times.endMs}
											tabindex="-1"
											onpointerdown={(e) =>
												onTrimPointerDown(
													e,
													cue.id,
													cue.startMs,
													cue.endMs,
													'end',
													'subtitles'
												)}
											onpointermove={onTrimPointerMove}
											onpointerup={onTrimPointerUp}
											onpointercancel={onTrimPointerUp}
										></span>
									</button>
								{/each}
							{:else if track.kind === 'tts'}
								{#each projectStore.current.cues.filter((c) => projectStore.cueHasTtsAudio(c)) as cue (cue.id)}
									{@const times = cueDisplayTimes(cue, 'tts')}
									{@const left = msToX(times.startMs, layoutZoom)}
									{@const width = Math.max(24, msToX(times.endMs - times.startMs, layoutZoom))}
									{@const originLeft = msToX(cue.startMs, layoutZoom)}
									{@const originWidth = Math.max(
										24,
										msToX(cue.endMs - cue.startMs, layoutZoom)
									)}
									{@const peaks = projectStore.ttsPeaksForCue(cue.id, Math.max(40, width), 2)}
									{@const playing = projectStore.isCuePlaying(cue.id)}
									{@const selected = projectStore.selectedCueIds.includes(cue.id)}
									{@const moving = isClipPreview(cue.id, 'tts')}
									{@const trimming = isClipTrimming(cue.id, 'tts')}
									{@const assigning =
										dndStore.drag?.kind === 'tts-audio' && dndStore.drag.id === cue.id}
									{#if moving || trimming}
										<div
											class="timeline-clip-ghost timeline-clip-tts pointer-events-none absolute overflow-hidden rounded-md border"
											style="left: {originLeft}px; width: {originWidth}px;"
											aria-hidden="true"
										>
											<Waveform {peaks} color={track.color} class="px-0.5 opacity-50" />
										</div>
									{/if}
									<div
										role="group"
										data-clip
										data-cue-id={cue.id}
										data-tts-clip="true"
										draggable="true"
										aria-pressed={selected}
										class={[
											'timeline-clip absolute overflow-hidden rounded-md border',
											'timeline-clip-tts',
											'timeline-clip-tts-enter',
											selected ? 'timeline-clip-selected' : '',
											playing ? 'timeline-clip-playing' : '',
											moving ? 'timeline-clip-dragging' : '',
											trimming ? 'timeline-clip-trimming' : '',
											assigning ? 'tts-clip-dragging' : ''
										]
											.filter(Boolean)
											.join(' ')}
										style="left: {left}px; width: {width}px;"
										onpointerdown={(e) =>
											onClipPointerDown(e, cue.id, cue.startMs, cue.endMs, 'tts')}
										onpointermove={onClipPointerMove}
										onpointerup={onClipPointerUp}
										onpointercancel={onClipPointerUp}
										onclick={(e) => e.stopPropagation()}
										ondblclick={(e) => {
											e.stopPropagation();
											e.preventDefault();
											projectStore.toggleCuePlayback(cue.id);
										}}
										ondragstart={(e) => onTtsDragStart(e, cue.id, cue.index)}
										ondrag={onTtsDrag}
										ondragend={onTtsDragEnd}
										aria-label="TTS clip {cue.index}"
										title={playing
											? `Playing · click ■ to stop · ${cue.assignedAudio?.label ?? `TTS #${cue.index}`}`
											: cue.assignedAudio?.label
												? `${cue.assignedAudio.label} · Play / double-click · Drag · Trim · Del clears`
												: 'Play / double-click · Drag · Trim · Del clears'}
									>
										<Waveform {peaks} color={track.color} class="pointer-events-none px-0.5" />
										<button
											type="button"
											class="timeline-tts-play"
											class:timeline-tts-play-active={playing}
											aria-label={playing
												? `Stop TTS cue ${cue.index}`
												: `Play TTS cue ${cue.index}`}
											title={playing ? 'Stop TTS' : 'Play TTS'}
											onpointerdown={(e) => e.stopPropagation()}
											onclick={(e) => {
												e.stopPropagation();
												e.preventDefault();
												projectStore.toggleCuePlayback(cue.id);
											}}
										>
											{#if playing}
												<Pause class="size-3 fill-current" />
											{:else}
												<Play class="size-3 fill-current" />
											{/if}
										</button>
										<span class="timeline-tts-label pointer-events-none">
											{playing ? 'Playing' : (cue.assignedAudio?.label ?? `TTS #${cue.index}`)}
										</span>
										{#if trimming}
											<span class="timeline-trim-badge pointer-events-none">
												{formatTimecode(times.startMs, projectStore.current.fps)}
												–
												{formatTimecode(times.endMs, projectStore.current.fps)}
											</span>
										{/if}
										<span
											data-trim-handle
											class="timeline-trim-handle timeline-trim-handle-start"
											class:timeline-trim-handle-active={trimming && clipTrim?.edge === 'start'}
											role="slider"
											aria-label="Trim start"
											aria-valuemin={0}
											aria-valuemax={cue.endMs}
											aria-valuenow={times.startMs}
											tabindex="-1"
											onpointerdown={(e) =>
												onTrimPointerDown(e, cue.id, cue.startMs, cue.endMs, 'start', 'tts')}
											onpointermove={onTrimPointerMove}
											onpointerup={onTrimPointerUp}
											onpointercancel={onTrimPointerUp}
										></span>
										<span
											data-trim-handle
											class="timeline-trim-handle timeline-trim-handle-end"
											class:timeline-trim-handle-active={trimming && clipTrim?.edge === 'end'}
											role="slider"
											aria-label="Trim end"
											aria-valuemin={cue.startMs}
											aria-valuemax={duration}
											aria-valuenow={times.endMs}
											tabindex="-1"
											onpointerdown={(e) =>
												onTrimPointerDown(e, cue.id, cue.startMs, cue.endMs, 'end', 'tts')}
											onpointermove={onTrimPointerMove}
											onpointerup={onTrimPointerUp}
											onpointercancel={onTrimPointerUp}
										></span>
									</div>
								{/each}
							{:else if track.kind === 'original'}
								{#if originalAudio.status === 'ready' && originalAudio.peaks.length}
									{@const originalWidthPx = msToX(
										Math.min(
											originalAudio.durationMs > 0 ? originalAudio.durationMs : duration,
											duration
										),
										layoutZoom
									)}
									{@const displayPeaks = resamplePeaks(
										originalAudio.peaks,
										Math.min(
											Math.max(originalAudio.peaks.length, 64),
											Math.max(64, Math.ceil(Math.max(1, originalWidthPx) / 2))
										)
									)}
									<div
										data-clip
										class="timeline-clip timeline-clip-original pointer-events-none absolute overflow-hidden rounded-md border"
										style="left: 0; width: {Math.max(1, originalWidthPx)}px;"
										title={originalAudio.label || 'Original Audio'}
									>
										<Waveform peaks={displayPeaks} color={track.color} class="opacity-90" />
										<span class="timeline-original-label">Original Audio</span>
									</div>
								{:else}
									<div
										class="timeline-original-empty pointer-events-none absolute inset-y-1.5 left-0 flex items-center rounded-md border border-dashed px-3"
										style="width: {layoutWidthPx}px;"
									>
										<span class="text-[10px] text-muted-foreground">
											{#if originalAudio.status === 'loading'}
												Extracting original audio…
											{:else if originalAudio.status === 'error'}
												Couldn’t extract audio from this video
											{:else}
												Import a video to extract original audio
											{/if}
										</span>
									</div>
								{/if}
							{/if}
							</div>
						</div>
					</div>
				{/each}

				<!-- Magnetic snap guide (content-space; temporary while dragging). -->
				{#if clipDrag?.moved && clipDrag.guideMs != null}
					<div
						class="timeline-snap-guide pointer-events-none absolute top-0 z-[30]"
						class:timeline-snap-guide-playhead={clipDrag.snapKind === 'playhead'}
						class:timeline-snap-guide-edge={clipDrag.snapKind === 'edge'}
						style="transform: translate3d({LABEL_WIDTH +
							Math.round(msToX(clipDrag.guideMs, zoom))}px, 0, 0); height: {RULER_HEIGHT +
							tracksHeight}px;"
						aria-hidden="true"
					>
						<span class="timeline-snap-cap"></span>
						<span class="timeline-snap-label">
							{clipDrag.snapKind === 'playhead' ? 'Playhead' : 'Snap'}
						</span>
					</div>
				{/if}
			</div>
		</div>

		<!--
			Viewport playhead overlay: starts after the label column, does not scroll with
			content X — so the needle can never paint under sticky track headers.
			Tracks only auto-scroll while playing (see autoSlideTimeline).
		-->
		<div
			class="timeline-playhead-overlay pointer-events-none absolute top-0 bottom-0 z-[35] overflow-hidden"
			style="left: {LABEL_WIDTH}px; right: 0;"
			aria-hidden="true"
		>
			<div bind:this={playheadEl} class="timeline-playhead timeline-playhead-live">
				<div class="timeline-playhead-head"></div>
				<div class="timeline-playhead-stem"></div>
				<div bind:this={playheadLabelEl} class="timeline-playhead-label"></div>
			</div>
		</div>
	</div>
</section>

<style>
	.timeline-scale-layer {
		transform-origin: 0 0;
	}

	/* Only promote a GPU layer while live-zooming — permanent will-change/translateZ
	   made waveforms composite above sticky track headers when panning. */
	.timeline-content.timeline-zoom-animating .timeline-scale-layer {
		will-change: transform;
	}

	/* Zoom is driven live — never tween clip left/width (that felt stuck/laggy). */
	.timeline-content {
		/* Width is set imperatively during zoom — never ease it. */
		transition: none;
		overflow-anchor: none;
	}

	.timeline-content.timeline-zoom-animating :global([data-clip]),
	.timeline-content.timeline-zoom-animating .timeline-clip,
	.timeline-content.timeline-zoom-animating .timeline-clip-ghost,
	.timeline-content.timeline-zoom-animating .timeline-scale-layer {
		transition: none !important;
	}

	:global(.timeline-zoom-slider [data-slot='slider-range']),
	:global(.timeline-zoom-slider [data-slot='slider-thumb']) {
		transition:
			box-shadow 100ms var(--motion-ease),
			transform 100ms var(--motion-ease) !important;
	}

	/* —— Ruler & track chrome —— */
	.timeline-scroller {
		/* Prevent browser scroll-anchoring from fighting programmatic follow. */
		overflow-anchor: none;
		/* Avoid clientWidth thrash when the scrollbar appears mid-follow. */
		scrollbar-gutter: stable;
	}

	.timeline-ruler-corner,
	.timeline-track-header {
		border-right: 1px solid color-mix(in oklab, var(--border) 88%, transparent);
		/* Fully opaque — translucent + backdrop-filter let lane content show “through/over”. */
		background: var(--sidebar);
		isolation: isolate;
	}

	.timeline-ruler-corner {
		position: sticky;
		left: 0;
		z-index: 40;
		border-bottom: 1px solid color-mix(in oklab, var(--border) 90%, var(--primary) 8%);
	}

	.timeline-ruler-lane {
		position: relative;
		z-index: 0;
		overflow: hidden;
		contain: paint;
		border-bottom: 1px solid color-mix(in oklab, var(--border) 90%, var(--primary) 8%);
		background: linear-gradient(
			180deg,
			color-mix(in oklab, var(--surface-timeline) 70%, var(--card)),
			var(--surface-timeline-deep)
		);
	}

	.timeline-tick-major {
		height: 100%;
		background: color-mix(in oklab, var(--border) 85%, var(--foreground) 10%);
	}

	.timeline-tick-minor {
		height: 0.45rem;
		background: color-mix(in oklab, var(--border) 70%, transparent);
	}

	.timeline-tick-label {
		position: absolute;
		top: 0.3rem;
		translate: -50% 0;
		font-family: var(--font-mono);
		font-size: 10px;
		font-variant-numeric: tabular-nums;
		letter-spacing: 0.02em;
		color: color-mix(in oklab, var(--muted-foreground) 92%, var(--foreground));
	}

	.timeline-track-row {
		border-bottom: 1px solid color-mix(in oklab, var(--border) 78%, transparent);
		box-shadow: inset 0 1px 0 color-mix(in oklab, var(--foreground) 3.5%, transparent);
	}

	.timeline-track-row:last-child {
		border-bottom-color: transparent;
	}

	.timeline-track-header {
		position: sticky;
		left: 0;
		z-index: 40;
		display: flex;
		align-items: center;
		gap: 0.65rem;
		padding-inline: 0.85rem;
		box-shadow: 1px 0 0 color-mix(in oklab, var(--border) 55%, transparent);
	}

	.timeline-track-swatch {
		flex-shrink: 0;
		width: 0.7rem;
		height: 0.7rem;
		border-radius: 0.28rem;
		box-shadow:
			inset 0 1px 0 oklch(1 0 0 / 28%),
			0 0 0 1px color-mix(in oklab, var(--foreground) 8%, transparent);
	}

	.timeline-track-name {
		margin: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 0.75rem;
		font-weight: 650;
		letter-spacing: 0.01em;
		color: var(--foreground);
		line-height: 1.2;
	}

	.timeline-track-role {
		margin: 0.12rem 0 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 9px;
		font-weight: 600;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--muted-foreground);
		line-height: 1.2;
	}

	.timeline-track-lane {
		position: relative;
		z-index: 0;
		/* Clip zoom-scaled waveforms so they cannot paint over the sticky header. */
		overflow: hidden;
		contain: paint;
		background: linear-gradient(180deg, var(--surface-timeline), var(--surface-timeline-deep));
	}

	.timeline-track-row[data-track-kind='subtitles'] .timeline-track-lane {
		background: linear-gradient(
			180deg,
			color-mix(in oklab, var(--track-subs) 5%, var(--surface-timeline)),
			var(--surface-timeline-deep)
		);
	}

	.timeline-track-row[data-track-kind='tts'] .timeline-track-lane {
		background: linear-gradient(
			180deg,
			color-mix(in oklab, var(--track-tts) 5.5%, var(--surface-timeline)),
			var(--surface-timeline-deep)
		);
	}

	.timeline-track-row[data-track-kind='original'] .timeline-track-lane {
		background: linear-gradient(
			180deg,
			color-mix(in oklab, var(--track-original) 5%, var(--surface-timeline)),
			var(--surface-timeline-deep)
		);
	}

	.timeline-lane-gridline {
		position: absolute;
		inset-block: 0;
		width: 1px;
		background: color-mix(in oklab, var(--foreground) 5.5%, transparent);
		pointer-events: none;
	}

	:global(.dark) .timeline-ruler-corner,
	:global(.dark) .timeline-track-header {
		background: var(--sidebar);
	}

	:global(.dark) .timeline-lane-gridline {
		background: color-mix(in oklab, white 5%, transparent);
	}

	:global(:root:not(.dark)) .timeline-ruler-corner,
	:global(:root:not(.dark)) .timeline-track-header {
		background: var(--sidebar);
	}

	:global(:root:not(.dark)) .timeline-lane-gridline {
		background: color-mix(in oklab, var(--foreground) 7%, transparent);
	}

	.timeline-playhead-overlay {
		/* Lane-only mask: left edge is LABEL_WIDTH — never overlaps track headers. */
		isolation: isolate;
	}

	.timeline-playhead {
		position: absolute;
		top: 0;
		left: 0;
		width: 0;
		height: 100%;
		will-change: transform;
		transform: translate3d(0, 0, 0);
		transition: none;
	}

	.timeline-playhead-live {
		transition: none !important;
	}

	/* Down-pointing caret sitting on the ruler, above the slim stem. */
	.timeline-playhead-head {
		position: absolute;
		top: 0;
		left: 50%;
		z-index: 2;
		width: 0;
		height: 0;
		transform: translateX(-50%);
		border-left: 7px solid transparent;
		border-right: 7px solid transparent;
		border-top: 10px solid #ef4444;
		filter: drop-shadow(0 1px 4px oklch(0.55 0.22 25 / 65%));
	}

	.timeline-playhead-stem {
		position: absolute;
		top: 9px;
		bottom: 0;
		left: 50%;
		z-index: 1;
		width: 2px;
		transform: translateX(-50%);
		border-radius: 1px;
		background: #ef4444;
		box-shadow:
			0 0 0 1px color-mix(in oklab, #ef4444 40%, transparent),
			0 0 10px oklch(0.63 0.24 25 / 65%),
			0 0 20px oklch(0.63 0.22 25 / 35%);
	}

	:global(:root:not(.dark)) .timeline-playhead-head {
		border-top-color: var(--playhead, #dc2626);
	}

	:global(:root:not(.dark)) .timeline-playhead-stem {
		background: var(--playhead, #dc2626);
		box-shadow:
			0 0 0 1px color-mix(in oklab, #991b1b 28%, transparent),
			0 0 12px oklch(0.55 0.22 25 / 45%),
			0 0 22px oklch(0.55 0.2 25 / 26%);
	}

	.timeline-playhead-label {
		position: absolute;
		top: 12px;
		left: 10px;
		z-index: 3;
		padding: 2px 7px;
		border-radius: 4px;
		border: 1px solid color-mix(in oklab, #ef4444 45%, var(--border));
		background: color-mix(in oklab, var(--card) 82%, #ef4444 14%);
		color: var(--foreground);
		font-family: var(--font-mono);
		font-size: 10px;
		font-weight: 650;
		font-variant-numeric: tabular-nums;
		letter-spacing: 0.02em;
		line-height: 1.4;
		white-space: nowrap;
		box-shadow: var(--elevation-float);
		backdrop-filter: blur(6px);
		pointer-events: none;
	}

	:global(.dark) .timeline-playhead-label {
		padding: 2px 7px;
		font-weight: 600;
		background: oklch(0.22 0.06 25 / 94%);
		color: oklch(0.96 0.02 25);
		border-color: oklch(0.65 0.2 25 / 48%);
		box-shadow:
			0 2px 8px oklch(0 0 0 / 35%),
			0 0 12px oklch(0.63 0.22 25 / 28%);
	}

	.timeline-playhead-label-left {
		left: auto;
		right: 11px;
	}

	.timeline-original-label {
		pointer-events: none;
		position: absolute;
		top: 0.3rem;
		left: 0.5rem;
		border-radius: 0.25rem;
		background: var(--surface-overlay);
		padding: 0.05rem 0.35rem;
		font-family: var(--font-mono);
		font-size: 9px;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: color-mix(in oklab, var(--foreground) 82%, transparent);
	}

	.timeline-original-empty {
		pointer-events: none;
		border-color: color-mix(in oklab, var(--track-original) 28%, var(--border));
		background: color-mix(in oklab, var(--track-original) 6%, transparent);
	}

	.timeline-clip-original {
		border-color: color-mix(in oklab, var(--track-original) 42%, transparent);
		background: var(--clip-original-bg);
		cursor: default;
		box-shadow:
			0 1px 2px oklch(0 0 0 / 10%),
			inset 0 1px 0 oklch(1 0 0 / 8%);
	}

	:global(.dark) .timeline-clip-original {
		border-color: color-mix(in oklab, var(--track-original) 38%, transparent);
		background: color-mix(in oklab, var(--track-original) 18%, transparent);
	}

	@media (prefers-reduced-motion: reduce) {
		.timeline-playhead,
		.timeline-clip {
			transition: none !important;
		}

		.timeline-clip:hover:not(.timeline-clip-dragging):not(.timeline-clip-trimming),
		.timeline-clip-selected:hover,
		.timeline-clip-dragging,
		.timeline-clip-trimming {
			transform: none;
			filter: none;
		}
	}

	:global(.tts-clip-dragging) {
		opacity: 0.4 !important;
		transform: scale(0.96);
	}

	.timeline-clip {
		z-index: 2;
		top: 0.55rem;
		bottom: 0.55rem;
		cursor: grab;
		touch-action: none;
		user-select: none;
		outline: 2px solid transparent;
		outline-offset: 0;
		box-shadow:
			0 1px 2px oklch(0 0 0 / 10%),
			inset 0 1px 0 oklch(1 0 0 / 8%);
		/* Intentionally no left/width transitions — zoom must track 1:1 with the control. */
		transition:
			box-shadow var(--motion-base) var(--motion-ease),
			border-color var(--motion-base) var(--motion-ease),
			background-color var(--motion-base) var(--motion-ease),
			transform var(--motion-fast) var(--motion-spring),
			opacity var(--motion-base) var(--motion-ease),
			filter var(--motion-base) var(--motion-ease),
			outline-color var(--motion-base) var(--motion-ease),
			outline-offset var(--motion-fast) var(--motion-ease);
	}

	.timeline-content.timeline-has-selection .timeline-clip:not(.timeline-clip-selected):not(
			.timeline-clip-dragging
		):not(.timeline-clip-original) {
		opacity: 0.62;
		filter: saturate(0.82);
	}

	.timeline-clip:hover:not(.timeline-clip-dragging):not(.timeline-clip-trimming):not(
			.timeline-clip-original
		) {
		filter: brightness(1.06) saturate(1.04);
		transform: translateY(-1.5px);
		box-shadow:
			0 4px 12px oklch(0 0 0 / 14%),
			0 0 0 1px color-mix(in oklab, var(--foreground) 10%, transparent),
			inset 0 1px 0 oklch(1 0 0 / 14%);
	}

	:global(:root:not(.dark))
		.timeline-clip:hover:not(.timeline-clip-dragging):not(.timeline-clip-trimming):not(
			.timeline-clip-original
		) {
		box-shadow:
			0 5px 14px oklch(0.4 0.04 265 / 14%),
			0 0 0 1px color-mix(in oklab, var(--primary) 16%, var(--border)),
			inset 0 1px 0 oklch(1 0 0 / 45%);
	}

	.timeline-content.timeline-has-selection
		.timeline-clip:not(.timeline-clip-selected):not(.timeline-clip-dragging):not(
			.timeline-clip-original
		):hover {
		opacity: 0.86;
		filter: brightness(1.06) saturate(0.95);
	}

	.timeline-clip:active:not(.timeline-clip-dragging) {
		cursor: grabbing;
		transform: translateY(0) scale(0.985);
		filter: brightness(0.98);
	}

	.timeline-content.timeline-clip-moving .timeline-clip:not(.timeline-clip-dragging) {
		/* Keep non-dragged clips stable; allow settle transition after release */
		transition:
			box-shadow var(--motion-base) var(--motion-ease),
			border-color var(--motion-base) var(--motion-ease),
			background-color var(--motion-base) var(--motion-ease),
			opacity var(--motion-base) var(--motion-ease),
			filter var(--motion-base) var(--motion-ease);
	}

	.timeline-clip-ghost {
		z-index: 3;
		top: 0.55rem;
		bottom: 0.55rem;
		opacity: 0.38;
		border-style: dashed !important;
		filter: grayscale(0.15);
		box-shadow: none !important;
		outline: none !important;
		animation: clip-ghost-in var(--motion-fast) var(--motion-ease-out);
	}

	.timeline-clip-dragging {
		z-index: 20 !important;
		opacity: 0.98 !important;
		filter: brightness(1.06) saturate(1.08);
		transform: translateY(-5px) scale(1.04);
		box-shadow:
			0 16px 34px oklch(0 0 0 / 28%),
			0 6px 14px oklch(0 0 0 / 14%),
			0 0 0 1.5px color-mix(in oklab, var(--primary) 52%, transparent) !important;
		outline-color: color-mix(in oklab, var(--primary) 45%, transparent);
		outline-offset: 2px;
		cursor: grabbing;
		transition: none !important;
		will-change: left, transform;
	}

	.timeline-clip-trimming {
		z-index: 21 !important;
		opacity: 1 !important;
		filter: brightness(1.05);
		transform: translateY(-2px) scaleY(1.04);
		box-shadow:
			0 10px 24px oklch(0 0 0 / 22%),
			0 0 0 1.5px color-mix(in oklab, var(--primary) 55%, transparent) !important;
		outline-color: color-mix(in oklab, var(--primary) 50%, transparent);
		outline-offset: 1px;
		cursor: ew-resize;
		transition: none !important;
		overflow: visible !important;
		will-change: left, width;
	}

	:global(.dark) .timeline-clip-dragging {
		box-shadow:
			0 18px 40px oklch(0 0 0 / 48%),
			0 0 24px color-mix(in oklab, var(--primary) 30%, transparent),
			0 0 0 1.5px color-mix(in oklab, var(--primary) 58%, transparent) !important;
	}

	:global(.dark) .timeline-clip-trimming {
		box-shadow:
			0 12px 28px oklch(0 0 0 / 42%),
			0 0 18px color-mix(in oklab, var(--primary) 26%, transparent),
			0 0 0 1.5px color-mix(in oklab, var(--primary) 60%, transparent) !important;
	}

	.timeline-trim-handle {
		position: absolute;
		top: 0;
		bottom: 0;
		z-index: 6;
		width: 11px;
		opacity: 0;
		cursor: ew-resize;
		touch-action: none;
		transition:
			opacity var(--motion-fast) var(--motion-ease),
			background-color var(--motion-fast) var(--motion-ease);
	}

	.timeline-trim-handle-start {
		left: 0;
		border-radius: 0.3rem 0 0 0.3rem;
	}

	.timeline-trim-handle-end {
		right: 0;
		border-radius: 0 0.3rem 0.3rem 0;
	}

	.timeline-trim-handle::after {
		content: '';
		position: absolute;
		top: 18%;
		bottom: 18%;
		width: 3px;
		border-radius: 999px;
		background: color-mix(in oklab, white 88%, var(--primary));
		box-shadow:
			0 0 0 1px color-mix(in oklab, var(--primary) 35%, transparent),
			0 1px 4px oklch(0 0 0 / 25%);
		transition:
			transform var(--motion-fast) var(--motion-spring),
			background-color var(--motion-fast) var(--motion-ease),
			box-shadow var(--motion-fast) var(--motion-ease);
	}

	.timeline-trim-handle-start::after {
		left: 3px;
	}

	.timeline-trim-handle-end::after {
		right: 3px;
	}

	.timeline-clip:hover .timeline-trim-handle,
	.timeline-clip-selected .timeline-trim-handle,
	.timeline-clip-trimming .timeline-trim-handle {
		opacity: 1;
	}

	.timeline-clip:hover .timeline-trim-handle {
		background: color-mix(in oklab, var(--primary) 10%, transparent);
	}

	.timeline-clip-selected .timeline-trim-handle,
	.timeline-clip-trimming .timeline-trim-handle {
		background: color-mix(in oklab, var(--primary) 16%, transparent);
	}

	.timeline-trim-handle:hover,
	.timeline-trim-handle-active {
		opacity: 1 !important;
		background: color-mix(in oklab, var(--primary) 28%, transparent) !important;
	}

	.timeline-trim-handle:hover::after,
	.timeline-trim-handle-active::after {
		transform: scaleY(1.12) scaleX(1.15);
		background: color-mix(in oklab, white 95%, var(--primary));
		box-shadow:
			0 0 0 1px color-mix(in oklab, var(--primary) 55%, transparent),
			0 0 10px color-mix(in oklab, var(--primary) 35%, transparent);
	}

	.timeline-trim-badge {
		position: absolute;
		top: 50%;
		left: 50%;
		z-index: 7;
		translate: -50% -50%;
		padding: 1px 6px;
		border-radius: 4px;
		border: 1px solid color-mix(in oklab, var(--primary) 40%, var(--border));
		background: color-mix(in oklab, var(--card) 88%, var(--primary) 12%);
		color: var(--foreground);
		font-family: var(--font-mono);
		font-size: 9px;
		font-weight: 650;
		letter-spacing: 0.02em;
		white-space: nowrap;
		box-shadow: var(--elevation-float);
		backdrop-filter: blur(6px);
		animation: clip-ghost-in var(--motion-fast) var(--motion-ease-out);
	}

	.timeline-snap-guide {
		width: 0;
		border-left: 1.5px dashed color-mix(in oklab, var(--primary) 70%, white);
		opacity: 0.95;
		filter: drop-shadow(0 0 6px color-mix(in oklab, var(--primary) 48%, transparent));
		animation: snap-guide-in var(--motion-fast) var(--motion-ease-out);
	}

	.timeline-snap-guide-playhead {
		border-left-color: color-mix(in oklab, var(--playhead, #dc2626) 75%, white);
		filter: drop-shadow(0 0 7px color-mix(in oklab, var(--playhead, #dc2626) 55%, transparent));
	}

	.timeline-snap-guide-edge {
		border-left-style: solid;
		border-left-width: 2px;
	}

	.timeline-snap-cap {
		position: absolute;
		top: 2px;
		left: 0;
		width: 9px;
		height: 9px;
		translate: -50% 0;
		rotate: 45deg;
		border-radius: 1.5px;
		background: color-mix(in oklab, var(--primary) 85%, white);
		box-shadow: 0 0 10px color-mix(in oklab, var(--primary) 45%, transparent);
	}

	.timeline-snap-guide-playhead .timeline-snap-cap {
		background: color-mix(in oklab, var(--playhead, #dc2626) 80%, white);
		box-shadow: 0 0 10px color-mix(in oklab, var(--playhead, #dc2626) 50%, transparent);
	}

	.timeline-snap-label {
		position: absolute;
		top: 12px;
		left: 8px;
		padding: 1px 6px;
		border-radius: 4px;
		border: 1px solid color-mix(in oklab, var(--primary) 35%, var(--border));
		background: color-mix(in oklab, var(--card) 88%, var(--primary) 10%);
		color: var(--foreground);
		font-size: 9px;
		font-weight: 650;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		white-space: nowrap;
		box-shadow: var(--elevation-float);
		backdrop-filter: blur(6px);
	}

	.timeline-snap-guide-playhead .timeline-snap-label {
		border-color: color-mix(in oklab, var(--playhead, #dc2626) 40%, var(--border));
		background: color-mix(in oklab, var(--card) 85%, var(--playhead, #dc2626) 12%);
	}

	@keyframes clip-ghost-in {
		from {
			opacity: 0;
		}
		to {
			opacity: 0.38;
		}
	}

	@keyframes snap-guide-in {
		from {
			opacity: 0;
		}
		to {
			opacity: 0.95;
		}
	}

	.timeline-clip-subs {
		border-color: color-mix(in oklab, var(--track-subs) 55%, transparent);
		background: var(--clip-subs-bg);
		color: color-mix(in oklab, var(--track-subs) 72%, var(--foreground));
	}

	:global(.dark) .timeline-clip-subs {
		/* Opaque mix against the card — transparent mixes vanish on dark lanes. */
		border-color: color-mix(in oklab, var(--track-subs) 70%, transparent);
		background: color-mix(in oklab, var(--track-subs) 38%, var(--card));
		color: oklch(0.94 0.02 230);
		box-shadow:
			0 1px 3px oklch(0 0 0 / 35%),
			inset 0 1px 0 oklch(1 0 0 / 10%);
	}

	.timeline-clip-tts {
		border-color: color-mix(in oklab, var(--track-tts) 50%, transparent);
		background: var(--clip-tts-bg);
		color: color-mix(in oklab, var(--track-tts) 70%, var(--foreground));
	}

	.timeline-clip-tts-enter {
		animation: tts-clip-in 280ms cubic-bezier(0.22, 1, 0.36, 1) both;
	}

	@keyframes tts-clip-in {
		from {
			opacity: 0;
			transform: scaleX(0.85);
			filter: saturate(0.6);
		}
		to {
			opacity: 1;
			transform: scaleX(1);
			filter: none;
		}
	}

	.timeline-tts-label {
		position: absolute;
		left: 26px;
		bottom: 3px;
		max-width: calc(100% - 32px);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 9px;
		font-weight: 600;
		letter-spacing: 0.02em;
		opacity: 0.85;
		text-shadow: 0 1px 2px color-mix(in oklab, var(--background) 70%, transparent);
	}

	.timeline-tts-play {
		position: absolute;
		left: 4px;
		top: 50%;
		z-index: 4;
		display: inline-flex;
		size: 18px;
		width: 18px;
		height: 18px;
		align-items: center;
		justify-content: center;
		border-radius: 999px;
		border: 1px solid color-mix(in oklab, oklch(1 0 0) 35%, transparent);
		background: color-mix(in oklab, var(--background) 55%, transparent);
		color: inherit;
		transform: translateY(-50%);
		backdrop-filter: blur(4px);
		cursor: pointer;
		opacity: 0.92;
		transition:
			background 120ms ease,
			color 120ms ease,
			box-shadow 120ms ease,
			opacity 120ms ease;
	}

	.timeline-tts-play:hover {
		opacity: 1;
		background: color-mix(in oklab, oklch(0.62 0.16 155) 55%, var(--background));
		color: oklch(0.98 0 0);
	}

	.timeline-tts-play-active {
		background: oklch(0.62 0.16 155);
		color: oklch(0.99 0 0);
		border-color: color-mix(in oklab, oklch(0.72 0.14 155) 70%, transparent);
		box-shadow: 0 0 10px color-mix(in oklab, oklch(0.62 0.16 155) 45%, transparent);
		animation: tts-play-pulse 1.1s ease-in-out infinite;
	}

	@keyframes tts-play-pulse {
		0%,
		100% {
			box-shadow: 0 0 8px color-mix(in oklab, oklch(0.62 0.16 155) 35%, transparent);
		}
		50% {
			box-shadow: 0 0 14px color-mix(in oklab, oklch(0.62 0.16 155) 55%, transparent);
		}
	}

	:global(.dark) .timeline-clip-tts {
		border-color: color-mix(in oklab, var(--track-tts) 68%, transparent);
		background: color-mix(in oklab, var(--track-tts) 34%, var(--card));
		color: oklch(0.94 0.02 292);
		box-shadow:
			0 1px 3px oklch(0 0 0 / 35%),
			inset 0 1px 0 oklch(1 0 0 / 10%);
	}

	.timeline-clip-label {
		color: inherit;
		font-weight: 550;
	}

	/* Linked selection — matches subtitle table primary edge */
	.timeline-clip-selected {
		z-index: 4;
		opacity: 1 !important;
		filter: none;
		border-color: color-mix(in oklab, var(--primary) 78%, transparent) !important;
		background: color-mix(in oklab, var(--primary) 18%, var(--card)) !important;
		outline-color: color-mix(in oklab, var(--primary) 55%, transparent);
		outline-offset: 1px;
		box-shadow:
			0 0 0 1px color-mix(in oklab, var(--primary) 42%, transparent),
			0 4px 14px color-mix(in oklab, var(--primary) 24%, transparent),
			inset 0 1px 0 oklch(1 0 0 / 12%);
	}

	.timeline-clip-selected:hover {
		filter: brightness(1.04);
		transform: translateY(-1px);
		outline-offset: 2px;
	}

	:global(.dark) .timeline-clip-selected {
		background: color-mix(in oklab, var(--primary) 28%, transparent) !important;
		outline-color: color-mix(in oklab, var(--primary) 60%, transparent);
		box-shadow:
			0 0 0 1px color-mix(in oklab, var(--primary) 52%, transparent),
			0 0 18px color-mix(in oklab, var(--primary) 28%, transparent),
			inset 0 1px 0 oklch(1 0 0 / 8%);
	}

	.timeline-clip-playing {
		z-index: 5;
		border-color: color-mix(in oklab, oklch(0.62 0.16 155) 70%, transparent) !important;
		box-shadow:
			0 0 0 1px color-mix(in oklab, oklch(0.62 0.16 155) 35%, transparent),
			0 0 14px color-mix(in oklab, oklch(0.62 0.16 155) 28%, transparent);
	}

	.timeline-clip-tts.timeline-clip-playing {
		outline: 1px solid color-mix(in oklab, oklch(0.62 0.16 155) 55%, transparent);
		animation: tts-clip-playing-glow 1.2s ease-in-out infinite;
	}

	@keyframes tts-clip-playing-glow {
		0%,
		100% {
			box-shadow:
				0 0 0 1px color-mix(in oklab, oklch(0.62 0.16 155) 30%, transparent),
				0 0 10px color-mix(in oklab, oklch(0.62 0.16 155) 22%, transparent);
		}
		50% {
			box-shadow:
				0 0 0 1px color-mix(in oklab, oklch(0.62 0.16 155) 50%, transparent),
				0 0 18px color-mix(in oklab, oklch(0.62 0.16 155) 40%, transparent);
		}
	}

	.timeline-clip-selected.timeline-clip-playing {
		z-index: 6;
		border-color: color-mix(in oklab, var(--primary) 80%, transparent) !important;
		outline-color: color-mix(in oklab, var(--primary) 50%, oklch(0.62 0.16 155));
		box-shadow:
			0 0 0 1px color-mix(in oklab, var(--primary) 45%, transparent),
			0 0 16px color-mix(in oklab, var(--primary) 22%, transparent),
			0 0 12px color-mix(in oklab, oklch(0.62 0.16 155) 22%, transparent);
	}
</style>
