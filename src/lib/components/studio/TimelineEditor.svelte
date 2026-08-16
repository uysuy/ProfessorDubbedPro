<script lang="ts">
	import { Slider } from '$lib/components/ui/slider/index.js';
	import * as Tooltip from '$lib/components/ui/tooltip/index.js';
	import Waveform from '$lib/components/studio/Waveform.svelte';
	import VideoFilmstrip from '$lib/components/studio/VideoFilmstrip.svelte';
	import { playback, projectStore } from '$lib/stores/project.svelte';
	import {
		getVisualPlayheadMs,
		setVisualPlayheadMs,
		consumeMediaSeekMs,
		onMediaSeekRequest,
		setTimelineScrubbing
	} from '$lib/stores/playback-clock';
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
		deltaXToMs,
		type TimelineTrackKind
	} from '$lib/utils/timeline';
	import { resamplePeaks } from '$lib/utils/audio-waveform';
	import { cuePreviewEndMs } from '$lib/utils/tts-fit';
	import { timelineUi } from '$lib/stores/timeline-ui.svelte';
	import { studioUi } from '$lib/stores/studio-ui.svelte';
	import {
		Eye,
		EyeOff,
		Magnet,
		Pause,
		Play,
		Scan,
		Scissors,
		MousePointer2,
		Link2,
		CircleHelp,
		ZoomIn,
		ZoomOut,
		Lock,
		Unlock
	} from '@lucide/svelte';
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
	/** Latest pointer X while scrubbing — drives edge auto-pan (Shift+wheel feel). */
	let scrubPointerClientX = 0;
	let scrubPanRaf = 0;

	/** Select-tool empty-lane drag → marquee time range (not playhead scrub). */
	type MarqueeState = {
		pointerId: number;
		originClientX: number;
		originMs: number;
		currentMs: number;
		moved: boolean;
		additive: boolean;
	};
	let marquee = $state<MarqueeState | null>(null);

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

	/** Title Liver clip drag (move) or edge trim. */
	let titleLiverDrag = $state<{
		id: string;
		mode: 'move' | 'trim-start' | 'trim-end';
		originClientX: number;
		originStartMs: number;
		originEndMs: number;
		durationMs: number;
		startMs: number;
		endMs: number;
		moved: boolean;
		pointerId: number;
	} | null>(null);

	const MIN_TRIM_DURATION_MS = 200;

	const duration = $derived(projectStore.current.durationMs);
	/** Scroller width minus sticky labels — used for fit / min zoom. */
	let viewportContentPx = $state(900);
	/** Media length at current zoom. */
	const mediaWidthPx = $derived(timelineWidthPx(duration, zoom));
	/** Lane width fills the viewport so empty projects aren’t a short strip on the left. */
	const widthPx = $derived(Math.max(mediaWidthPx, viewportContentPx));
	/** Layout width under the scale layer (frozen while dragging the zoom slider). */
	const layoutMediaWidthPx = $derived(timelineWidthPx(duration, layoutZoom));
	const layoutWidthPx = $derived(Math.max(layoutMediaWidthPx, viewportContentPx));
	const zoomScale = $derived(zoom / layoutZoom);
	const ticks = $derived(buildRulerTicks(duration, layoutZoom));
	const displayMs = $derived(scrubMs ?? playback.playheadMs);
	const visibleTracks = $derived(
		TIMELINE_TRACKS.map((t) => {
			const shown = timelineUi.isTrackShown(t.kind);
			return {
				...t,
				shown,
				height: shown ? timelineUi.trackHeight(t.kind, t.height) : 30
			};
		})
	);
	const tracksHeight = $derived(visibleTracks.reduce((sum, t) => sum + t.height, 0));
	const originalAudio = $derived(projectStore.originalAudio);
	/** Zoom out until the full project fits (was a fixed 0.5× that still scrolled). */
	const effectiveMinZoom = $derived(minZoomForView(duration, viewportContentPx));

	const isClipMoving = $derived(clipDrag != null || clipTrim != null);
	const arrangeOn = $derived(timelineUi.arrangeMode);
	/** Local mirrors so toolbar + cursor stay reactive to store changes. */
	const activeTool = $derived(timelineUi.tool);
	const snapOn = $derived(timelineUi.snapEnabled);

	/** Blade hover: preview cut line under the cursor. */
	let bladeHoverMs = $state<number | null>(null);
	let sectionEl: HTMLElement | undefined = $state();

	function focusTimeline() {
		sectionEl?.focus({ preventScroll: true });
	}

	function chooseTool(next: 'select' | 'blade') {
		timelineUi.setTool(next);
		bladeHoverMs = next === 'blade' ? bladeHoverMs : null;
		focusTimeline();
		dndStore.flash(next === 'blade' ? 'Blade — hover to preview cut, click to split' : 'Select tool');
	}

	function toggleSnapUi() {
		const on = timelineUi.toggleSnap();
		focusTimeline();
		dndStore.flash(on ? 'Snap on' : 'Snap off');
	}

	function toggleArrangeUi() {
		const on = timelineUi.toggleArrangeMode();
		bladeHoverMs = null;
		focusTimeline();
		dndStore.flash(on ? 'Arrange — TTS hidden, Title Liver + Video + Subs + Original' : 'Arrange off');
	}

	function updateBladeHover(clientX: number, target: EventTarget | null) {
		if (activeTool !== 'blade') {
			bladeHoverMs = null;
			return;
		}
		const el = target as HTMLElement | null;
		if (!el?.closest?.('[data-slot="timeline-editor"]')) {
			bladeHoverMs = null;
			return;
		}
		// Preview over lanes/clips; hide over headers/toolbar.
		if (el.closest('[data-track-label], .panel-header, .timeline-ruler-corner')) {
			bladeHoverMs = null;
			return;
		}
		if (!el.closest('.timeline-track-lane, [data-clip], .timeline-content')) {
			bladeHoverMs = null;
			return;
		}
		bladeHoverMs = clientXToTimelineMs(clientX);
	}

	function bladeHoverValid(): boolean {
		if (bladeHoverMs == null) return false;
		const cut = bladeHoverMs;
		const minDur = 200;
		return projectStore.current.cues.some(
			(c) => cut >= c.startMs + minDur && cut <= c.endMs - minDur
		);
	}

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
		const lane = Math.max(timelineWidthPx(duration, z), viewportContentPx);
		const w = `${LABEL_WIDTH + lane}px`;
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
			const width = Math.max(timelineWidthPx(duration, z), viewportContentPx);
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
		const lane = Math.max(timelineWidthPx(duration, z), viewportContentPx);
		const contentW = LABEL_WIDTH + lane;
		if (!contentEl) return contentW;
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
		// TTS track: follow spoken Khmer length (and subtitle end), so Generate tails are visible.
		if (trackKind === 'tts') {
			const spoken = cuePreviewEndMs(cue);
			return {
				startMs: cue.startMs,
				endMs: Math.max(cue.startMs + 1, spoken)
			};
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
		if (!clipDrag.moved && Math.abs(dx) < 6) return;

		const deltaMs = deltaXToMs(dx, zoom);
		const rawStart = clipDrag.originStartMs + deltaMs;
		const others = projectStore.current.cues
			.filter((c) => c.id !== clipDrag!.id)
			.map((c) => ({ startMs: c.startMs, endMs: c.endMs }));

		let startMs: number;
		let guideMs: number | null = null;
		let snapKind: ClipDragState['snapKind'] = null;

		if (snapOn) {
			const snapped = snapCueStartMs({
				startMs: rawStart,
				durationMs: clipDrag.durationMs,
				timelineDurationMs: duration,
				zoom,
				playheadMs: playback.playheadMs,
				others
			});
			startMs = snapped.startMs;
			guideMs = snapped.guideMs;
			const playhead = playback.playheadMs;
			snapKind =
				guideMs == null
					? null
					: Math.abs(guideMs - playhead) < 1
						? 'playhead'
						: 'edge';
		} else {
			const maxStart = Math.max(0, duration - clipDrag.durationMs);
			startMs = Math.max(0, Math.min(maxStart, Math.round(rawStart)));
		}

		clipDrag = {
			...clipDrag,
			moved: true,
			startMs,
			endMs: startMs + clipDrag.durationMs,
			guideMs,
			snapKind
		};
	}

	function seekFromClientX(clientX: number, immediate = false) {
		if (!scrollEl) return;
		const rect = scrollEl.getBoundingClientRect();
		const x = Math.max(0, clientX - rect.left + scrollEl.scrollLeft - LABEL_WIDTH);
		const ms = xToMs(x, zoom, duration);
		// Always drive the program monitor via seekMedia — do not thrash the
		// Svelte store every pointer move (that delayed video seeks by seconds).
		setVisualPlayheadMs(ms, { seekMedia: true });
		paintPlayhead(ms);
		if (isScrubbing) {
			scrubMs = ms;
			if (immediate) projectStore.setPlayhead(ms);
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

	function beginScrub(e: PointerEvent & { currentTarget: HTMLElement }) {
		e.preventDefault();
		suppressChase(600);
		isScrubbing = true;
		setTimelineScrubbing(true);
		scrubPointerClientX = e.clientX;
		e.currentTarget.setPointerCapture(e.pointerId);
		seekFromClientX(e.clientX, true);
		startScrubEdgePan();
	}

	function onContentPointerDown(e: PointerEvent & { currentTarget: HTMLElement }) {
		const target = e.target as HTMLElement;
		// Don't start scrub/marquee on interactive clips — original-audio is decorative only.
		if (target.closest('[data-track-label]')) return;
		if (target.closest('[data-clip]:not(.timeline-clip-original):not(.timeline-clip-video)')) return;

		if (isZoomLive) endZoomGesture();

		// Blade on empty lane: seek to click, then cut.
		if (activeTool === 'blade') {
			e.preventDefault();
			seekFromClientX(e.clientX, true);
			const cutMs = scrubMs ?? playback.playheadMs;
			const n = projectStore.splitCuesAtMs(cutMs);
			if (n > 0) {
				dndStore.flash(n === 1 ? 'Split at playhead' : `Split ${n} cues at playhead`);
			} else {
				dndStore.flash('No cue covers this time (need ≥200ms on each side)');
			}
			return;
		}

		// Scrub on the time ruler, Alt-drag anywhere, or on reference media lanes
		// (Original Video / Original Audio) — Select tool marquee stays on Subs/TTS.
		const onRuler = Boolean(target.closest('.timeline-ruler-lane, .timeline-ruler'));
		const onReferenceLane = Boolean(
			target.closest(
				'.timeline-track-row[data-track-kind="video"] .timeline-track-lane, .timeline-track-row[data-track-kind="original"] .timeline-track-lane'
			)
		);
		if (onRuler || onReferenceLane || e.altKey) {
			beginScrub(e);
			return;
		}

		// Select tool: empty lane → marquee (drag) or click-seek (no drag).
		e.preventDefault();
		suppressChase(600);
		const originMs = clientXToTimelineMs(e.clientX);
		marquee = {
			pointerId: e.pointerId,
			originClientX: e.clientX,
			originMs,
			currentMs: originMs,
			moved: false,
			additive: e.shiftKey || e.ctrlKey || e.metaKey
		};
		try {
			e.currentTarget.setPointerCapture(e.pointerId);
		} catch {
			/* ignore */
		}
	}

	function onContentPointerMove(e: PointerEvent) {
		updateBladeHover(e.clientX, e.target);
		if (isScrubbing) {
			scrubPointerClientX = e.clientX;
			seekFromClientX(e.clientX);
			return;
		}
		if (!marquee || e.pointerId !== marquee.pointerId) return;
		const currentMs = clientXToTimelineMs(e.clientX);
		const moved =
			marquee.moved ||
			Math.abs(e.clientX - marquee.originClientX) > 4 ||
			Math.abs(currentMs - marquee.originMs) > 30;
		marquee = { ...marquee, currentMs, moved };
	}

	function onContentPointerUp(e: PointerEvent & { currentTarget: HTMLElement }) {
		if (marquee && e.pointerId === marquee.pointerId) {
			const state = marquee;
			marquee = null;
			try {
				e.currentTarget.releasePointerCapture(e.pointerId);
			} catch {
				/* ignore */
			}
			if (state.moved) {
				selectCuesInTimeRange(state.originMs, state.currentMs, state.additive);
			} else {
				// Plain click: clear selection (unless additive) + move playhead.
				if (!state.additive) projectStore.selectAllCues(false);
				seekFromClientX(e.clientX, true);
			}
			return;
		}

		if (!isScrubbing) return;
		isScrubbing = false;
		setTimelineScrubbing(false);
		stopScrubEdgePan();
		if (scrubMs != null) {
			setVisualPlayheadMs(scrubMs, { seekMedia: true });
			projectStore.setPlayhead(scrubMs);
			paintPlayhead(scrubMs);
			scrubMs = null;
		}
		try {
			e.currentTarget.releasePointerCapture(e.pointerId);
		} catch {
			/* already released */
		}
	}

	/** Select subtitle cues overlapping [a,b] ms (timeline order). */
	function selectCuesInTimeRange(msA: number, msB: number, additive: boolean) {
		const a = Math.min(msA, msB);
		const b = Math.max(msA, msB);
		if (b - a < 40) return;
		const hits = projectStore.current.cues
			.filter((c) => c.endMs > a && c.startMs < b)
			.sort((x, y) => x.startMs - y.startMs || x.index - y.index)
			.map((c) => c.id);
		if (!hits.length) {
			if (!additive) projectStore.selectAllCues(false);
			return;
		}
		const first = hits[0]!;
		const last = hits[hits.length - 1]!;
		if (additive) {
			for (const id of hits) projectStore.setCueSelected(id, true);
			return;
		}
		projectStore.selectCueAt(first);
		if (hits.length > 1) projectStore.selectCueAt(last, { range: true });
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

	/** Frame / half-second nudge; Alt trims start, Ctrl/Meta trims end. */
	function onTimelineKeyDown(e: KeyboardEvent) {
		const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
		if (tag === 'input' || tag === 'textarea' || (e.target as HTMLElement)?.isContentEditable) {
			return;
		}

		if (e.key === 'a' || e.key === 'A') {
			if (!e.ctrlKey && !e.metaKey) {
				e.preventDefault();
				toggleArrangeUi();
			}
			return;
		}
		if (e.key === 'v' || e.key === 'V') {
			if (!e.ctrlKey && !e.metaKey) {
				e.preventDefault();
				chooseTool('select');
			}
			return;
		}
		if (e.key === 'b' || e.key === 'B') {
			if (!e.ctrlKey && !e.metaKey) {
				e.preventDefault();
				chooseTool('blade');
			}
			return;
		}
		if (e.key === 'n' || e.key === 'N') {
			if (!e.ctrlKey && !e.metaKey) {
				e.preventDefault();
				toggleSnapUi();
			}
			return;
		}
		if (e.key === '[' || e.key === ']') {
			e.preventDefault();
			const ok =
				e.key === '['
					? projectStore.setCueStartAtPlayhead()
					: projectStore.setCueEndAtPlayhead();
			dndStore.flash(ok ? (e.key === '[' ? 'Start → playhead' : 'End → playhead') : 'Select a cue');
			return;
		}

		if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
			e.preventDefault();
			const id = projectStore.selectAdjacentCue(e.key === 'ArrowDown' ? 1 : -1);
			if (id) revealCueInTable(id);
			return;
		}

		if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
			const dir = e.key === 'ArrowRight' ? 1 : -1;
			// With selection + no modifier scrub intent: nudge clips.
			if (projectStore.selectedCueIds.length > 0 && !e.ctrlKey && !e.metaKey) {
				e.preventDefault();
				// Shift = 0.5s slide; Alt = trim start; Alt+Shift = trim end.
				const step = e.shiftKey && !e.altKey ? 500 : 40;
				const mode = e.altKey ? (e.shiftKey ? 'end' : 'start') : 'both';
				projectStore.nudgeSelectedCues(dir * step, mode);
				return;
			}
			e.preventDefault();
			const step = e.shiftKey ? 1000 : 100;
			const ms = playback.playheadMs + dir * step;
			setVisualPlayheadMs(ms, { seekMedia: true });
			projectStore.setPlayhead(ms);
			return;
		}

		if ((e.key === 'c' || e.key === 'C') && !e.ctrlKey && !e.metaKey) {
			e.preventDefault();
			const n = projectStore.splitCuesAtMs(playback.playheadMs);
			dndStore.flash(
				n > 0
					? n === 1
						? 'Split at playhead'
						: `Split ${n} cues at playhead`
					: 'Playhead must sit inside a cue (≥200ms padding)'
			);
		}
	}

	function onTitleLiverPointerDown(
		e: PointerEvent & { currentTarget: HTMLElement },
		id: string,
		startMs: number,
		endMs: number,
		mode: 'move' | 'trim-start' | 'trim-end' = 'move'
	) {
		if (isZoomLive) endZoomGesture();
		e.preventDefault();
		e.stopPropagation();
		projectStore.selectTitleLiver(id);
		const ph = playback.playheadMs;
		if (ph < startMs || ph >= endMs) {
			setVisualPlayheadMs(startMs, { seekMedia: true });
			projectStore.setPlayhead(startMs);
		}
		titleLiverDrag = {
			id,
			mode,
			originClientX: e.clientX,
			originStartMs: startMs,
			originEndMs: endMs,
			durationMs: Math.max(400, endMs - startMs),
			startMs,
			endMs,
			moved: false,
			pointerId: e.pointerId
		};
		e.currentTarget.setPointerCapture(e.pointerId);
	}

	function onTitleLiverPointerMove(e: PointerEvent & { currentTarget: HTMLElement }) {
		if (!titleLiverDrag || e.pointerId !== titleLiverDrag.pointerId) return;
		const dx = e.clientX - titleLiverDrag.originClientX;
		if (!titleLiverDrag.moved && Math.abs(dx) < 2) return;
		const deltaMs = deltaXToMs(dx, zoom);
		const minDur = 400;
		if (titleLiverDrag.mode === 'move') {
			const nextStart = Math.max(0, Math.round(titleLiverDrag.originStartMs + deltaMs));
			titleLiverDrag = {
				...titleLiverDrag,
				startMs: nextStart,
				endMs: nextStart + titleLiverDrag.durationMs,
				moved: true
			};
			return;
		}
		if (titleLiverDrag.mode === 'trim-start') {
			const nextStart = Math.max(
				0,
				Math.min(titleLiverDrag.originEndMs - minDur, Math.round(titleLiverDrag.originStartMs + deltaMs))
			);
			titleLiverDrag = {
				...titleLiverDrag,
				startMs: nextStart,
				endMs: titleLiverDrag.originEndMs,
				moved: true
			};
			return;
		}
		const nextEnd = Math.max(
			titleLiverDrag.originStartMs + minDur,
			Math.round(titleLiverDrag.originEndMs + deltaMs)
		);
		titleLiverDrag = {
			...titleLiverDrag,
			startMs: titleLiverDrag.originStartMs,
			endMs: nextEnd,
			moved: true
		};
	}

	function onTitleLiverPointerUp(e: PointerEvent & { currentTarget: HTMLElement }) {
		if (!titleLiverDrag || e.pointerId !== titleLiverDrag.pointerId) return;
		const drag = titleLiverDrag;
		titleLiverDrag = null;
		try {
			e.currentTarget.releasePointerCapture(e.pointerId);
		} catch {
			/* ignore */
		}
		if (!drag.moved) return;
		if (drag.mode === 'move') {
			projectStore.moveTitleLiverTiming(drag.id, drag.startMs);
		} else if (drag.mode === 'trim-start') {
			projectStore.trimTitleLiverEdge(drag.id, 'start', drag.startMs);
		} else {
			projectStore.trimTitleLiverEdge(drag.id, 'end', drag.endMs);
		}
	}

	function clientXToTimelineMs(clientX: number): number {
		if (!scrollEl) return playback.playheadMs;
		const rect = scrollEl.getBoundingClientRect();
		const x = Math.max(0, clientX - rect.left + scrollEl.scrollLeft - LABEL_WIDTH);
		return xToMs(x, zoom, duration);
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

		// Blade tool: cut at the click time on this clip (Premiere-style razor).
		if (activeTool === 'blade' && trackKind === 'subtitles') {
			const cutMs = clientXToTimelineMs(e.clientX);
			setVisualPlayheadMs(cutMs, { seekMedia: true });
			projectStore.setPlayhead(cutMs);
			// Keep multi-select: cut this clip, or all selected that contain the cut.
			if (
				projectStore.selectedCueIds.length > 1 &&
				projectStore.selectedCueIds.includes(cueId)
			) {
				const n = projectStore.splitCuesAtMs(cutMs);
				if (n > 0) dndStore.flash(n === 1 ? 'Split' : `Split ${n} cues`);
				else dndStore.flash('Cut needs ≥200ms on each side of the click');
			} else {
				projectStore.selectCue(cueId);
				revealCueInTable(cueId);
				const id = projectStore.splitCueAtMs(cueId, cutMs);
				if (id) dndStore.flash('Split at click');
				else dndStore.flash('Cut needs ≥200ms on each side of the click');
			}
			return;
		}

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
		updateBladeHover(e.clientX, e.target);
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
		if (pendingDragClientX != null) {
			applyClipDragVisual(pendingDragClientX);
			pendingDragClientX = null;
		}
		clipDrag = null;

		if (drag.moved && drag.trackKind === 'subtitles') {
			projectStore.moveCueTiming(drag.id, drag.startMs);
		}

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
			setContentWidthForZoom(zoom);
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
		setTimelineScrubbing(false);
		if (clipDragMoveRaf) cancelAnimationFrame(clipDragMoveRaf);
		if (clipTrimMoveRaf) cancelAnimationFrame(clipTrimMoveRaf);
		if (zoomVisualRaf) cancelAnimationFrame(zoomVisualRaf);
		if (zoomBakeTimer) clearTimeout(zoomBakeTimer);
		stopScrubEdgePan();
	});
</script>

<section
	bind:this={sectionEl}
	class="timeline-shell flex h-full min-h-0 flex-col bg-transparent"
	data-slot="timeline-editor"
	class:timeline-arrange={arrangeOn}
	class:timeline-blade-cursor={activeTool === 'blade'}
	tabindex="0"
	onkeydown={onTimelineKeyDown}
	onpointerleave={() => {
		bladeHoverMs = null;
	}}
>
	<div class="timeline-toolbar">
		<Tooltip.Provider>
			<!-- Resolve-style: edit tools left -->
			<div class="timeline-tools" role="toolbar" aria-label="Timeline tools">
				<Tooltip.Root>
					<Tooltip.Trigger class="inline-flex">
						{#snippet child({ props })}
							<button
								{...props}
								type="button"
								class="timeline-tool-btn"
								class:timeline-tool-btn-active={activeTool === 'select'}
								aria-label="Selection tool"
								aria-pressed={activeTool === 'select'}
								onpointerdown={(e) => e.stopPropagation()}
								onclick={(e) => {
									e.preventDefault();
									e.stopPropagation();
									chooseTool('select');
								}}
							>
								<MousePointer2 class="size-3.5" stroke-width={1.75} />
							</button>
						{/snippet}
					</Tooltip.Trigger>
					<Tooltip.Content>Selection mode (V)</Tooltip.Content>
				</Tooltip.Root>

				<Tooltip.Root>
					<Tooltip.Trigger class="inline-flex">
						{#snippet child({ props })}
							<button
								{...props}
								type="button"
								class="timeline-tool-btn"
								class:timeline-tool-btn-active={activeTool === 'blade'}
								aria-label="Blade tool"
								aria-pressed={activeTool === 'blade'}
								onpointerdown={(e) => e.stopPropagation()}
								onclick={(e) => {
									e.preventDefault();
									e.stopPropagation();
									chooseTool('blade');
								}}
							>
								<Scissors class="size-3.5" stroke-width={1.75} />
							</button>
						{/snippet}
					</Tooltip.Trigger>
					<Tooltip.Content>Blade / split (B)</Tooltip.Content>
				</Tooltip.Root>

				<span class="timeline-tool-sep" aria-hidden="true"></span>

				<Tooltip.Root>
					<Tooltip.Trigger class="inline-flex">
						{#snippet child({ props })}
							<button
								{...props}
								type="button"
								class="timeline-tool-btn"
								class:timeline-tool-btn-armed={snapOn}
								aria-label="Toggle snapping"
								aria-pressed={snapOn}
								onpointerdown={(e) => e.stopPropagation()}
								onclick={(e) => {
									e.preventDefault();
									e.stopPropagation();
									toggleSnapUi();
								}}
							>
								<Magnet class="size-3.5" stroke-width={1.75} />
							</button>
						{/snippet}
					</Tooltip.Trigger>
					<Tooltip.Content>Snapping {snapOn ? 'on' : 'off'} (N)</Tooltip.Content>
				</Tooltip.Root>

				<Tooltip.Root>
					<Tooltip.Trigger class="inline-flex">
						{#snippet child({ props })}
							<button
								{...props}
								type="button"
								class="timeline-tool-btn"
								class:timeline-tool-btn-active={arrangeOn}
								aria-label="Linked / arrange view"
								aria-pressed={arrangeOn}
								onpointerdown={(e) => e.stopPropagation()}
								onclick={(e) => {
									e.preventDefault();
									e.stopPropagation();
									toggleArrangeUi();
								}}
							>
								<Link2 class="size-3.5" stroke-width={1.75} />
							</button>
						{/snippet}
					</Tooltip.Trigger>
					<Tooltip.Content>Arrange view (A) — focus Video + Original</Tooltip.Content>
				</Tooltip.Root>

				<span class="timeline-tool-sep" aria-hidden="true"></span>

				<Tooltip.Root>
					<Tooltip.Trigger class="inline-flex">
						{#snippet child({ props })}
							<button
								{...props}
								type="button"
								class="timeline-tool-btn"
								aria-label={playback.isPlaying ? 'Pause' : 'Play'}
								onclick={() => projectStore.togglePlayback()}
							>
								{#if playback.isPlaying}
									<Pause class="size-3.5 fill-current" stroke-width={1.75} />
								{:else}
									<Play class="size-3.5 fill-current" stroke-width={1.75} />
								{/if}
							</button>
						{/snippet}
					</Tooltip.Trigger>
					<Tooltip.Content>{playback.isPlaying ? 'Pause' : 'Play'} (Space)</Tooltip.Content>
				</Tooltip.Root>

				<Tooltip.Root>
					<Tooltip.Trigger class="inline-flex">
						{#snippet child({ props })}
							<button
								{...props}
								type="button"
								class="timeline-tool-btn"
								aria-label="Timeline shortcuts"
							>
								<CircleHelp class="size-3.5" stroke-width={1.75} />
							</button>
						{/snippet}
					</Tooltip.Trigger>
					<Tooltip.Content class="max-w-64 text-left text-[11px] leading-relaxed">
						<div class="font-semibold">Shortcuts</div>
						<div>V select · B blade · N snap · A arrange</div>
						<div>Drag ruler / video / original = scrub</div>
						<div>C split at playhead · [ ] nudge</div>
					</Tooltip.Content>
				</Tooltip.Root>
			</div>

			<!-- Center timecode -->
			<div class="timeline-tc" aria-live="polite">
				<span class="timeline-tc-now">{formatTimecode(displayMs, projectStore.current.fps)}</span>
				<span class="timeline-tc-sep">/</span>
				<span class="timeline-tc-dur">{formatTimecode(duration, projectStore.current.fps)}</span>
			</div>

			<!-- Resolve-style: zoom right -->
			<div class="timeline-zoom" role="group" aria-label="Timeline zoom">
				<button
					type="button"
					class="timeline-tool-btn"
					aria-label="Zoom out"
					disabled={zoom <= effectiveMinZoom + 0.001}
					onclick={() => zoomBy(-0.25)}
				>
					<ZoomOut class="size-3.5" stroke-width={1.75} />
				</button>
				<Slider
					type="single"
					class="timeline-zoom-slider w-28"
					value={zoom}
					min={effectiveMinZoom}
					max={MAX_ZOOM}
					step={0.01}
					onValueChange={onZoomSlider}
					onValueCommit={onZoomSliderCommit}
					aria-label="Timeline zoom"
				/>
				<button
					type="button"
					class="timeline-tool-btn"
					aria-label="Zoom in"
					disabled={zoom >= MAX_ZOOM}
					onclick={() => zoomBy(0.25)}
				>
					<ZoomIn class="size-3.5" stroke-width={1.75} />
				</button>
				<button
					type="button"
					class="timeline-tool-btn"
					aria-label="Fit timeline to view"
					onclick={fitTimelineToView}
					title="Full extent"
				>
					<Scan class="size-3.5" stroke-width={1.75} />
				</button>
			</div>
		</Tooltip.Provider>
	</div>

	<div class="timeline-body relative min-h-0 flex-1 overflow-hidden">
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
					onTimelineKeyDown(e);
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
				{#each visibleTracks as track (track.id)}
					<div
						class="timeline-track-row grid"
						class:timeline-track-row-hidden={!track.shown}
						data-track-kind={track.kind}
						style="grid-template-columns: {LABEL_WIDTH}px 1fr; height: {track.height}px;"
					>
						<div
							data-track-label
							class="timeline-track-header"
							class:timeline-track-header-locked={timelineUi.locked[track.kind]}
						>
							<span class="timeline-track-swatch" style="background: {track.color};"></span>
							<div class="timeline-track-id">
								<p class="timeline-track-name">{track.name}</p>
								<p class="timeline-track-role">{track.role}</p>
							</div>
							<div class="timeline-track-controls">
								<button
									type="button"
									class="timeline-track-icon-btn"
									class:timeline-track-icon-btn-active={timelineUi.locked[track.kind]}
									title={timelineUi.locked[track.kind] ? 'Unlock track' : 'Lock track'}
									aria-label={timelineUi.locked[track.kind] ? 'Unlock track' : 'Lock track'}
									aria-pressed={timelineUi.locked[track.kind]}
									onclick={(e) => {
										e.stopPropagation();
										timelineUi.toggleLocked(track.kind as TimelineTrackKind);
									}}
								>
									{#if timelineUi.locked[track.kind]}
										<Lock class="size-3" stroke-width={1.75} />
									{:else}
										<Unlock class="size-3" stroke-width={1.75} />
									{/if}
								</button>
								<button
									type="button"
									class="timeline-track-icon-btn"
									class:timeline-track-icon-btn-active={!timelineUi.visibility[track.kind]}
									title={timelineUi.visibility[track.kind] ? 'Disable track' : 'Enable track'}
									aria-label={timelineUi.visibility[track.kind] ? 'Hide track' : 'Show track'}
									onclick={(e) => {
										e.stopPropagation();
										timelineUi.toggleVisible(track.kind as TimelineTrackKind);
									}}
								>
									{#if timelineUi.visibility[track.kind]}
										<Eye class="size-3" stroke-width={1.75} />
									{:else}
										<EyeOff class="size-3" stroke-width={1.75} />
									{/if}
								</button>
								<button
									type="button"
									class="timeline-track-icon-btn"
									class:timeline-track-icon-btn-solo={timelineUi.solo[track.kind]}
									title={timelineUi.solo[track.kind] ? 'Unsolo' : 'Solo'}
									aria-label={timelineUi.solo[track.kind] ? 'Unsolo track' : 'Solo track'}
									aria-pressed={timelineUi.solo[track.kind]}
									onclick={(e) => {
										e.stopPropagation();
										timelineUi.toggleSolo(track.kind as TimelineTrackKind);
									}}
								>
									S
								</button>
								{#if track.kind === 'original'}
									<button
										type="button"
										class="timeline-track-icon-btn"
										class:timeline-track-icon-btn-active={projectStore.originalAudioMuted ||
											projectStore.originalAudioGain < 0.005}
										title={projectStore.originalAudioMuted ? 'Unmute' : 'Mute'}
										aria-label={projectStore.originalAudioMuted
											? 'Unmute original audio'
											: 'Mute original audio'}
										aria-pressed={projectStore.originalAudioMuted}
										onclick={(e) => {
											e.stopPropagation();
											projectStore.toggleOriginalAudioMute();
										}}
									>
										M
									</button>
								{/if}
							</div>
							{#if track.shown && track.kind === 'original'}
								<div class="timeline-original-mixer">
									<Slider
										type="single"
										class="timeline-original-fader min-w-0 flex-1"
										value={Math.round(projectStore.originalAudioGain * 100)}
										min={0}
										max={100}
										step={1}
										disabled={projectStore.originalAudioMuted ||
											timelineUi.locked.original}
										onValueChange={(v) => {
											const n = typeof v === 'number' ? v : Number(v);
											if (!Number.isFinite(n)) return;
											projectStore.setOriginalAudioGain(n / 100);
											if (projectStore.originalAudioMuted && n > 0) {
												projectStore.setOriginalAudioMuted(false);
											}
										}}
										aria-label="Original audio volume"
									/>
									<span class="timeline-original-pct font-mono">
										{projectStore.originalAudioMuted
											? 'M'
											: `${Math.round(projectStore.originalAudioGain * 100)}`}
									</span>
								</div>
							{/if}
						</div>

						<div
							class="timeline-track-lane relative z-0 overflow-hidden"
							class:timeline-track-lane-locked={timelineUi.locked[track.kind]}
							style="width: {widthPx}px;"
						>
							{#if track.shown}
							<div
								class="timeline-scale-layer absolute inset-y-0 left-0"
								style="width: {layoutWidthPx}px; transform-origin: 0 0;{zoomScale === 1
									? ''
									: ` transform: scaleX(${zoomScale});`}"
							>
							{#each ticks.filter((t) => t.major) as tick}
								<span class="timeline-lane-gridline" style="left: {tick.x}px;"></span>
							{/each}

							{#if track.kind === 'video'}
								{#if projectStore.videoUrl}
									{@const mediaW = msToX(
										Math.min(
											duration,
											projectStore.originalAudio.durationMs > 0
												? projectStore.originalAudio.durationMs
												: duration
										),
										layoutZoom
									)}
									<div
										class="timeline-clip timeline-clip-video pointer-events-none absolute overflow-hidden rounded-none border"
										style="left: 0; width: {Math.max(48, mediaW || layoutWidthPx)}px; top: 0.4rem; bottom: 0.4rem;"
									>
										<VideoFilmstrip
											videoUrl={projectStore.videoUrl}
											durationMs={duration}
											widthPx={Math.max(48, mediaW || layoutWidthPx)}
											heightPx={Math.max(36, track.height - 14)}
										/>
									</div>
								{:else}
									<div
										class="timeline-original-empty pointer-events-none absolute inset-y-1.5 left-1 flex items-center rounded-none border border-dashed px-3"
										style="width: {Math.max(48, layoutWidthPx - 8)}px;"
									>
										<span class="text-[10px] text-muted-foreground">
											Import a video to show frame previews
										</span>
									</div>
								{/if}
							{:else if track.kind === 'titleLiver'}
								{#each projectStore.titleLiverClips as tl (tl.id)}
									{@const dragLive =
										titleLiverDrag?.id === tl.id ? titleLiverDrag : null}
									{@const startMs = dragLive?.startMs ?? tl.startMs}
									{@const endMs = dragLive?.endMs ?? tl.endMs}
									{@const left = msToX(startMs, layoutZoom)}
									{@const width = Math.max(1, msToX(Math.max(0, endMs - startMs), layoutZoom))}
									{@const selected = projectStore.selectedTitleLiverId === tl.id}
									{@const trimming =
										dragLive?.moved &&
										(dragLive.mode === 'trim-start' || dragLive.mode === 'trim-end')}
									{@const micro = width < 14}
									<button
										type="button"
										data-clip
										data-title-liver-id={tl.id}
										aria-pressed={selected}
										class={[
											'timeline-clip absolute overflow-hidden rounded-none border text-left',
											micro ? 'px-0' : 'px-1.5',
											'timeline-clip-title-liver',
											micro ? 'timeline-clip-micro' : '',
											selected ? 'timeline-clip-selected' : '',
											dragLive?.moved && dragLive.mode === 'move' ? 'timeline-clip-dragging' : '',
											trimming ? 'timeline-clip-trimming' : ''
										]
											.filter(Boolean)
											.join(' ')}
										style="left: {left}px; width: {width}px; --tl-accent: {tl.accent};"
										title="{tl.line1} · {tl.line2} — drag to move, edges to trim"
										onpointerdown={(e) => {
											if ((e.target as HTMLElement).closest('[data-trim-handle]')) return;
											onTitleLiverPointerDown(e, tl.id, tl.startMs, tl.endMs, 'move');
										}}
										onpointermove={onTitleLiverPointerMove}
										onpointerup={onTitleLiverPointerUp}
										onpointercancel={onTitleLiverPointerUp}
										onclick={(e) => e.stopPropagation()}
										ondblclick={(e) => {
											e.stopPropagation();
											projectStore.selectTitleLiver(tl.id);
											studioUi.openTitleLiver();
										}}
									>
										<span class="timeline-clip-label pointer-events-none block truncate text-[10px] leading-4">
											{micro ? '' : tl.line1 || 'Title Liver'}
										</span>
										{#if trimming}
											<span class="timeline-trim-badge pointer-events-none">
												{formatTimecode(startMs, projectStore.current.fps)} →
												{formatTimecode(endMs, projectStore.current.fps)}
											</span>
										{/if}
										<span
											data-trim-handle="start"
											class="timeline-trim-handle timeline-trim-handle-start"
											class:timeline-trim-handle-active={trimming &&
												dragLive?.mode === 'trim-start'}
											onpointerdown={(e) => {
												e.stopPropagation();
												onTitleLiverPointerDown(
													e as PointerEvent & { currentTarget: HTMLElement },
													tl.id,
													tl.startMs,
													tl.endMs,
													'trim-start'
												);
											}}
											onpointermove={onTitleLiverPointerMove}
											onpointerup={onTitleLiverPointerUp}
											onpointercancel={onTitleLiverPointerUp}
										></span>
										<span
											data-trim-handle="end"
											class="timeline-trim-handle timeline-trim-handle-end"
											class:timeline-trim-handle-active={trimming && dragLive?.mode === 'trim-end'}
											onpointerdown={(e) => {
												e.stopPropagation();
												onTitleLiverPointerDown(
													e as PointerEvent & { currentTarget: HTMLElement },
													tl.id,
													tl.startMs,
													tl.endMs,
													'trim-end'
												);
											}}
											onpointermove={onTitleLiverPointerMove}
											onpointerup={onTitleLiverPointerUp}
											onpointercancel={onTitleLiverPointerUp}
										></span>
									</button>
								{/each}
								{#if !projectStore.titleLiverClips.length}
									<div
										class="pointer-events-none absolute inset-y-1.5 left-1 flex items-center rounded-none border border-dashed px-3"
										style="width: {Math.max(48, layoutWidthPx - 8)}px;"
									>
										<span class="text-[10px] text-muted-foreground">
											Title Liver → Add at playhead
										</span>
									</div>
								{/if}
							{:else if track.kind === 'subtitles'}
								{#each projectStore.current.cues as cue (cue.id)}
									{@const times = cueDisplayTimes(cue, 'subtitles')}
									{@const left = msToX(times.startMs, layoutZoom)}
									{@const width = Math.max(1, msToX(Math.max(0, times.endMs - times.startMs), layoutZoom))}
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
										1,
										msToX(
											trimming && clipTrim
												? clipTrim.originEndMs - clipTrim.originStartMs
												: cue.endMs - cue.startMs,
											layoutZoom
										)
									)}
									{#if moving || trimming}
										<div
											class="timeline-clip-ghost timeline-clip-subs pointer-events-none absolute overflow-hidden rounded-none border px-1.5"
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
											'timeline-clip absolute overflow-hidden rounded-none border px-1.5 text-left',
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
									{@const width = Math.max(1, msToX(Math.max(0, times.endMs - times.startMs), layoutZoom))}
									{@const originLeft = msToX(cue.startMs, layoutZoom)}
									{@const originWidth = Math.max(
										1,
										msToX(Math.max(0, cue.endMs - cue.startMs), layoutZoom)
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
											class="timeline-clip-ghost timeline-clip-tts pointer-events-none absolute overflow-hidden rounded-none border"
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
											'timeline-clip absolute overflow-hidden rounded-none border',
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
										class="timeline-clip timeline-clip-original pointer-events-none absolute overflow-hidden rounded-none border"
										class:timeline-clip-original-dimmed={projectStore.originalAudioMuted ||
											projectStore.originalAudioGain < 0.05}
										style="left: 0; width: {Math.max(1, originalWidthPx)}px; opacity: {projectStore.originalAudioMuted
											? 0.28
											: Math.max(0.35, 0.35 + projectStore.originalAudioGain * 0.65)};"
										title={originalAudio.label || 'Original Audio'}
									>
										<Waveform peaks={displayPeaks} color={track.color} class="opacity-90" />
										<span class="timeline-original-label">Original Audio</span>
									</div>
								{:else}
									<div
										class="timeline-original-empty pointer-events-none absolute inset-y-1.5 left-1 flex items-center rounded-none border border-dashed px-3"
										style="width: {Math.max(48, layoutWidthPx - 8)}px;"
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
							{/if}
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

				{#if marquee?.moved}
					{@const leftMs = Math.min(marquee.originMs, marquee.currentMs)}
					{@const rightMs = Math.max(marquee.originMs, marquee.currentMs)}
					<div
						class="timeline-marquee pointer-events-none absolute z-[28]"
						style="left: {LABEL_WIDTH + msToX(leftMs, zoom)}px; width: {Math.max(
							2,
							msToX(rightMs - leftMs, zoom)
						)}px; top: {RULER_HEIGHT}px; height: {tracksHeight}px;"
						aria-hidden="true"
					></div>
				{/if}

				{#if activeTool === 'blade' && bladeHoverMs != null}
					{@const valid = bladeHoverValid()}
					<div
						class="timeline-blade-guide pointer-events-none absolute top-0 z-[31]"
						class:timeline-blade-guide-valid={valid}
						class:timeline-blade-guide-invalid={!valid}
						style="transform: translate3d({LABEL_WIDTH +
							Math.round(msToX(bladeHoverMs, zoom))}px, 0, 0); height: {RULER_HEIGHT +
							tracksHeight}px;"
						aria-hidden="true"
					>
						<span class="timeline-blade-guide-cap"></span>
						<span class="timeline-blade-guide-label">{valid ? 'Cut' : '—'}</span>
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
	/* —— Timeline chrome (Resolve tool arrangement, theme colors) —— */
	:global([data-slot='timeline-editor'].timeline-shell) {
		margin: 0.3rem 0.35rem 0.4rem;
		border: 1px solid color-mix(in oklab, var(--border) 85%, transparent);
		border-radius: 6px;
		background: color-mix(in oklab, var(--card) 92%, var(--surface-timeline));
		box-shadow: var(--elevation-panel);
		overflow: hidden;
		isolation: isolate;
	}

	.timeline-toolbar {
		display: grid;
		grid-template-columns: 1fr auto 1fr;
		align-items: center;
		gap: 0.5rem;
		min-height: 2rem;
		padding: 0.2rem 0.45rem;
		border-bottom: 1px solid color-mix(in oklab, var(--border) 80%, transparent);
		background: color-mix(in oklab, var(--sidebar) 88%, var(--card));
	}

	.timeline-tools {
		display: flex;
		align-items: center;
		gap: 1px;
		justify-self: start;
	}

	.timeline-zoom {
		display: flex;
		align-items: center;
		gap: 2px;
		justify-self: end;
	}

	.timeline-tool-sep {
		width: 1px;
		height: 1rem;
		margin-inline: 0.3rem;
		background: color-mix(in oklab, var(--border) 90%, transparent);
	}

	.timeline-tool-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.55rem;
		height: 1.55rem;
		border: 0;
		border-radius: 3px;
		background: transparent;
		color: var(--muted-foreground);
		cursor: pointer;
	}

	.timeline-tool-btn:hover:not(:disabled) {
		color: var(--foreground);
		background: var(--interact-hover);
	}

	.timeline-tool-btn:disabled {
		opacity: 0.35;
		cursor: default;
	}

	.timeline-tool-btn-active {
		color: var(--foreground);
		background: var(--interact-selected);
		box-shadow: inset 0 0 0 1px var(--interact-ring);
	}

	/* Resolve: snapping armed = red accent */
	.timeline-tool-btn-armed {
		color: var(--playhead, #e10600);
		background: color-mix(in oklab, var(--playhead, #e10600) 12%, transparent);
		box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--playhead, #e10600) 40%, transparent);
	}

	.timeline-tc {
		display: inline-flex;
		align-items: baseline;
		gap: 0.25rem;
		justify-self: center;
		font-family: var(--font-mono);
		font-size: 11px;
		font-variant-numeric: tabular-nums;
		font-weight: 600;
		letter-spacing: 0.02em;
		color: var(--foreground);
		user-select: none;
	}

	.timeline-tc-sep {
		opacity: 0.35;
		font-weight: 500;
	}

	.timeline-tc-dur {
		color: var(--muted-foreground);
		font-weight: 500;
	}

	.timeline-body {
		border-radius: 0;
		background: var(--surface-timeline-deep);
	}

	.timeline-scale-layer {
		transform-origin: 0 0;
	}

	.timeline-content.timeline-zoom-animating .timeline-scale-layer {
		will-change: transform;
	}

	.timeline-content {
		transition: none;
		overflow-anchor: none;
		background: var(--timeline-lane-alt);
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

	.timeline-scroller {
		overflow-anchor: none;
		scrollbar-gutter: auto;
		border-radius: 0;
		background: var(--surface-timeline-deep);
	}

	.timeline-ruler-corner,
	.timeline-track-header {
		border-right: 1px solid color-mix(in oklab, var(--border) 85%, transparent);
		background: var(--timeline-header);
		isolation: isolate;
	}

	.timeline-ruler-corner {
		position: sticky;
		left: 0;
		z-index: 40;
		border-bottom: 1px solid color-mix(in oklab, var(--border) 85%, transparent);
	}

	.timeline-ruler-lane {
		position: relative;
		z-index: 0;
		overflow: hidden;
		contain: paint;
		cursor: ew-resize;
		border-bottom: 1px solid color-mix(in oklab, var(--border) 85%, transparent);
		background: var(--timeline-ruler);
	}

	.timeline-tick-major {
		height: 55%;
		bottom: 0;
		background: color-mix(in oklab, var(--foreground) 28%, transparent);
	}

	.timeline-tick-minor {
		height: 28%;
		bottom: 0;
		background: color-mix(in oklab, var(--foreground) 14%, transparent);
	}

	.timeline-tick-label {
		position: absolute;
		top: 0.15rem;
		translate: -50% 0;
		font-family: var(--font-mono);
		font-size: 9px;
		font-variant-numeric: tabular-nums;
		letter-spacing: 0.01em;
		color: var(--muted-foreground);
		font-weight: 500;
	}

	.timeline-track-row {
		border-bottom: 1px solid color-mix(in oklab, var(--border) 80%, transparent);
		box-shadow: none;
	}

	.timeline-track-header {
		position: sticky;
		left: 0;
		z-index: 40;
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		grid-template-rows: auto auto;
		align-items: center;
		column-gap: 0.35rem;
		row-gap: 0.15rem;
		padding: 0.3rem 0.4rem;
		box-shadow: none;
	}

	.timeline-track-swatch {
		grid-row: 1;
		width: 0.4rem;
		height: 0.4rem;
		border-radius: 1px;
		box-shadow: none;
	}

	.timeline-track-id {
		grid-row: 1;
		min-width: 0;
	}

	.timeline-track-controls {
		grid-row: 1;
		display: flex;
		align-items: center;
		gap: 1px;
	}

	.timeline-original-mixer {
		grid-column: 1 / -1;
		grid-row: 2;
		display: flex;
		align-items: center;
		gap: 0.28rem;
		margin-top: 0;
		min-width: 0;
	}

	.timeline-track-name {
		margin: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 11px;
		font-weight: 700;
		letter-spacing: 0.04em;
		color: var(--foreground);
		line-height: 1.1;
		font-family: var(--font-mono);
	}

	.timeline-track-role {
		margin: 0.05rem 0 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 8px;
		font-weight: 500;
		letter-spacing: 0.02em;
		text-transform: none;
		color: var(--muted-foreground);
		line-height: 1.1;
	}

	.timeline-track-icon-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		width: 1.1rem;
		height: 1.1rem;
		border-radius: 2px;
		border: 1px solid transparent;
		background: transparent;
		color: var(--muted-foreground);
		font-size: 8px;
		font-weight: 700;
		line-height: 1;
		cursor: pointer;
	}

	.timeline-track-icon-btn:hover {
		color: var(--foreground);
		background: var(--interact-hover);
	}

	.timeline-track-icon-btn-active {
		color: var(--destructive);
	}

	.timeline-track-icon-btn-solo {
		color: oklch(0.75 0.14 85);
		border-color: color-mix(in oklab, oklch(0.75 0.14 85) 45%, var(--border));
		background: color-mix(in oklab, oklch(0.75 0.14 85) 14%, transparent);
	}

	.timeline-track-header-locked {
		opacity: 0.85;
	}

	.timeline-track-lane-locked :global([data-clip]) {
		pointer-events: none;
		opacity: 0.7;
	}

	.timeline-track-row-hidden .timeline-track-lane {
		opacity: 0.3;
		background: var(--surface-timeline-deep);
	}

	.timeline-original-pct {
		flex-shrink: 0;
		min-width: 1.4rem;
		text-align: right;
		font-size: 9px;
		font-weight: 600;
		color: var(--muted-foreground);
		line-height: 1;
	}

	:global(.timeline-original-fader) {
		height: 1rem;
	}

	:global(.timeline-original-fader [data-slot='slider-track']) {
		height: 0.18rem;
		border-radius: 0;
	}

	:global(.timeline-original-fader [data-slot='slider-thumb']) {
		width: 0.55rem;
		height: 0.55rem;
		border-radius: 1px;
	}

	.timeline-clip-original-dimmed {
		filter: grayscale(0.35) brightness(0.85);
	}

	.timeline-track-row[data-track-kind='original'] .timeline-track-header {
		align-items: center;
		padding-block: 0.3rem;
	}

	.timeline-track-lane {
		position: relative;
		z-index: 0;
		overflow: hidden;
		contain: paint;
		background: var(--timeline-lane);
	}

	.timeline-track-row[data-track-kind='video'] .timeline-track-lane,
	.timeline-track-row[data-track-kind='titleLiver'] .timeline-track-lane,
	.timeline-track-row[data-track-kind='subtitles'] .timeline-track-lane,
	.timeline-track-row[data-track-kind='tts'] .timeline-track-lane,
	.timeline-track-row[data-track-kind='original'] .timeline-track-lane {
		background: var(--timeline-lane);
	}

	.timeline-lane-gridline {
		position: absolute;
		inset-block: 0;
		width: 1px;
		background: color-mix(in oklab, var(--foreground) 5%, transparent);
		pointer-events: none;
	}

	.timeline-marquee {
		border: 1px solid var(--playhead, #e10600);
		background: color-mix(in oklab, var(--playhead, #e10600) 12%, transparent);
		border-radius: 0;
	}

	:global([data-slot='timeline-editor'].timeline-blade-cursor) {
		cursor: crosshair;
	}

	:global([data-slot='timeline-editor'].timeline-blade-cursor) :global([data-clip]) {
		cursor: crosshair;
	}

	.timeline-blade-guide {
		width: 0;
		border-left: 1px dashed oklch(0.75 0.14 85);
		margin-left: -0.5px;
	}

	.timeline-blade-guide-valid {
		border-left-color: oklch(0.75 0.14 85);
	}

	.timeline-blade-guide-invalid {
		border-left-color: var(--muted-foreground);
		opacity: 0.55;
	}

	.timeline-blade-guide-cap {
		position: absolute;
		top: 0;
		left: -4px;
		width: 8px;
		height: 8px;
		border-radius: 0;
		background: oklch(0.75 0.14 85);
		transform: rotate(45deg);
		transform-origin: center;
	}

	.timeline-blade-guide-invalid .timeline-blade-guide-cap {
		background: var(--muted-foreground);
	}

	.timeline-blade-guide-label {
		position: absolute;
		top: 10px;
		left: 6px;
		padding: 0 4px;
		border-radius: 3px;
		font-size: 9px;
		font-weight: 700;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: oklch(0.22 0.04 55);
		background: color-mix(in oklab, oklch(0.82 0.14 85) 92%, white);
		white-space: nowrap;
	}

	.timeline-blade-guide-invalid .timeline-blade-guide-label {
		display: none;
	}

	.timeline-ruler-lane {
		cursor: ew-resize;
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

	/* Resolve-style head: flat red house / inverted chevron on the ruler. */
	.timeline-playhead-head {
		position: absolute;
		top: 0;
		left: 50%;
		z-index: 2;
		width: 11px;
		height: 10px;
		transform: translateX(-50%);
		background: var(--playhead, #e10600);
		clip-path: polygon(0 0, 100% 0, 100% 55%, 50% 100%, 0 55%);
		filter: none;
		border: 0;
	}

	.timeline-playhead-stem {
		position: absolute;
		top: 9px;
		bottom: 0;
		left: 50%;
		z-index: 1;
		width: 1px;
		transform: translateX(-50%);
		border-radius: 0;
		background: var(--playhead, #e10600);
		box-shadow: none;
	}

	:global(:root:not(.dark)) .timeline-playhead-head {
		background: var(--playhead, #e10600);
	}

	:global(:root:not(.dark)) .timeline-playhead-stem {
		background: var(--playhead, #e10600);
		box-shadow: none;
	}

	.timeline-playhead-label {
		position: absolute;
		top: 11px;
		left: 8px;
		z-index: 3;
		padding: 1px 5px;
		border-radius: 1px;
		border: 1px solid #111;
		background: #1a1a1a;
		color: #f0f0f0;
		font-family: var(--font-mono);
		font-size: 9px;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		letter-spacing: 0.02em;
		line-height: 1.35;
		white-space: nowrap;
		box-shadow: none;
		backdrop-filter: none;
		pointer-events: none;
	}

	:global(.dark) .timeline-playhead-label {
		padding: 1px 5px;
		font-weight: 600;
		background: #1a1a1a;
		color: #f0f0f0;
		border-color: #111;
		box-shadow: none;
	}

	.timeline-playhead-label-left {
		left: auto;
		right: 8px;
	}

	.timeline-original-label {
		pointer-events: none;
		position: absolute;
		top: 0.2rem;
		left: 0.35rem;
		border-radius: 1px;
		background: rgb(0 0 0 / 45%);
		padding: 0.05rem 0.3rem;
		font-family: var(--font-mono);
		font-size: 8px;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: #ddd;
	}

	.timeline-original-empty {
		pointer-events: none;
		border-color: #444;
		border-style: dashed;
		background: transparent;
		box-shadow: none;
		border-radius: 1px;
	}

	.timeline-clip-video {
		border-color: #2a5078;
		background: var(--clip-video-bg, #3a6ea5);
		box-shadow: none;
		cursor: default;
		border-radius: 1px;
	}

	.timeline-clip-original {
		border-color: #1f6a3c;
		background: var(--clip-original-bg, #2f8a52);
		cursor: default;
		box-shadow: none;
		border-radius: 1px;
	}

	:global(.dark) .timeline-clip-original {
		border-color: #1f6a3c;
		background: var(--clip-original-bg, #2f8a52);
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
		opacity: 0.45 !important;
		transform: none;
	}

	.timeline-clip {
		z-index: 2;
		top: 0.28rem;
		bottom: 0.28rem;
		border-radius: 1px;
		cursor: grab;
		touch-action: none;
		user-select: none;
		outline: 1px solid transparent;
		outline-offset: 0;
		box-shadow: none;
		transition:
			outline-color 80ms ease,
			filter 80ms ease,
			opacity 80ms ease;
	}

	.timeline-content.timeline-has-selection .timeline-clip:not(.timeline-clip-selected):not(
			.timeline-clip-dragging
		):not(.timeline-clip-original):not(.timeline-clip-video) {
		opacity: 0.72;
		filter: saturate(0.9);
	}

	.timeline-clip:hover:not(.timeline-clip-dragging):not(.timeline-clip-trimming):not(
			.timeline-clip-original
		):not(.timeline-clip-video) {
		filter: brightness(1.08);
		transform: none;
		box-shadow: none;
	}

	:global(:root:not(.dark))
		.timeline-clip:hover:not(.timeline-clip-dragging):not(.timeline-clip-trimming):not(
			.timeline-clip-original
		):not(.timeline-clip-video) {
		box-shadow: none;
	}

	.timeline-content.timeline-has-selection
		.timeline-clip:not(.timeline-clip-selected):not(.timeline-clip-dragging):not(
			.timeline-clip-original
		):not(.timeline-clip-video):hover {
		opacity: 0.9;
		filter: brightness(1.08);
	}

	.timeline-clip:active:not(.timeline-clip-dragging) {
		cursor: grabbing;
		transform: none;
		filter: brightness(0.96);
	}

	.timeline-content.timeline-clip-moving .timeline-clip:not(.timeline-clip-dragging) {
		transition: opacity 80ms ease, filter 80ms ease;
	}

	.timeline-clip-ghost {
		z-index: 3;
		top: 0.28rem;
		bottom: 0.28rem;
		opacity: 0.35;
		border-style: dashed !important;
		border-radius: 1px;
		filter: none;
		box-shadow: none !important;
		outline: none !important;
		animation: none;
	}

	.timeline-clip-dragging {
		z-index: 20 !important;
		opacity: 0.95 !important;
		filter: brightness(1.1);
		transform: none;
		box-shadow: none !important;
		outline: 1px solid #e10600 !important;
		outline-offset: 0;
		cursor: grabbing;
		transition: none !important;
		will-change: left;
	}

	.timeline-clip-trimming {
		z-index: 21 !important;
		opacity: 1 !important;
		filter: brightness(1.06);
		transform: none;
		box-shadow: none !important;
		outline: 1px solid #e10600 !important;
		outline-offset: 0;
		cursor: ew-resize;
		transition: none !important;
		overflow: visible !important;
		will-change: left, width;
	}

	:global(.dark) .timeline-clip-dragging,
	:global(.dark) .timeline-clip-trimming {
		box-shadow: none !important;
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
		border-color: #2a5078;
		background: var(--clip-subs-bg, #3d6f9c);
		color: #f2f6fa;
	}

	.timeline-clip-title-liver {
		border-color: color-mix(in oklab, var(--tl-accent, #6b4c9a) 65%, #111);
		background: var(--tl-accent, var(--clip-title-liver-bg, #6b4c9a));
		color: #f5f0ff;
		box-shadow: none;
	}

	.timeline-clip-micro {
		border-radius: 1px;
		box-shadow: none;
	}

	.timeline-clip-micro .timeline-trim-handle {
		width: 10px;
		opacity: 0.55;
	}

	.timeline-clip-micro .timeline-trim-handle-start {
		left: -4px;
	}

	.timeline-clip-micro .timeline-trim-handle-end {
		right: -4px;
	}

	:global(.dark) .timeline-clip-subs {
		border-color: #2a5078;
		background: var(--clip-subs-bg, #3d6f9c);
		color: #f2f6fa;
		box-shadow: none;
	}

	:global(.dark) .timeline-clip-title-liver {
		border-color: color-mix(in oklab, var(--tl-accent, #6b4c9a) 65%, #111);
		background: var(--tl-accent, var(--clip-title-liver-bg, #6b4c9a));
		color: #f5f0ff;
	}

	.timeline-clip-tts {
		border-color: #4a3570;
		background: var(--clip-tts-bg, #6b4f9a);
		color: #f3ecff;
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
		border-color: #4a3570;
		background: var(--clip-tts-bg, #6b4f9a);
		color: #f3ecff;
		box-shadow: none;
	}

	.timeline-clip-label {
		color: inherit;
		font-weight: 550;
	}

	/* Resolve selection — red outline, keep clip fill */
	.timeline-clip-selected {
		z-index: 4;
		opacity: 1 !important;
		filter: none;
		border-color: #e10600 !important;
		outline: 1px solid #e10600;
		outline-offset: 0;
		box-shadow: none;
	}

	.timeline-clip-selected:hover {
		filter: brightness(1.06);
		transform: none;
		outline-offset: 0;
	}

	:global(.dark) .timeline-clip-selected {
		outline: 1px solid #e10600;
		box-shadow: none;
	}

	.timeline-clip-playing {
		z-index: 5;
		border-color: #3dd68c !important;
		box-shadow: none;
	}

	.timeline-clip-tts.timeline-clip-playing {
		outline: 1px solid #3dd68c;
		animation: none;
	}

	@keyframes tts-clip-playing-glow {
		0%,
		100% {
			box-shadow: none;
		}
		50% {
			box-shadow: none;
		}
	}

	.timeline-clip-selected.timeline-clip-playing {
		z-index: 6;
		border-color: #e10600 !important;
		outline: 1px solid #e10600;
		box-shadow: none;
	}
</style>
