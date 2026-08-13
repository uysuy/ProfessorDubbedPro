<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import * as Tooltip from '$lib/components/ui/tooltip/index.js';
	import { playback, projectStore } from '$lib/stores/project.svelte';
	import { tempoStore } from '$lib/stores/tempo.svelte';
	import { getVisualPlayheadMs, setVisualPlayheadMs, consumeMediaSeekMs, onMediaSeekRequest, isTimelineScrubbing } from '$lib/stores/playback-clock';
	import { classifyMediaFile, dndStore, isFileDrag } from '$lib/stores/dnd.svelte';
	import { usesKhmerScript, normalizeDubLanguage } from '$lib/stores/preferences.svelte';
	import { formatClock, formatTimecode } from '$lib/utils/time';
	import { TtsPlaybackMixer } from '$lib/utils/tts-playback';
	import { cuePreviewEndMs } from '$lib/utils/tts-fit';
	import { isTauriRuntime } from '$lib/utils/platform';
	import {
		FolderOpen,
		Maximize,
		Minimize,
		Pause,
		Play,
		Upload,
		ZoomIn,
		ZoomOut
	} from '@lucide/svelte';

	interface Props {
		class?: string;
	}

	let { class: className = '' }: Props = $props();

	const speeds = ['0.5', '0.75', '1', '1.25', '1.5', '2'] as const;

	let shellEl: HTMLElement | undefined = $state();
	let videoEl: HTMLVideoElement | undefined = $state();
	let fileInput: HTMLInputElement | undefined = $state();
	let playbackRate = $state('1');
	let zoom = $state(1);
	let isFullscreen = $state(false);
	let mediaDurationMs = $state(0);
	let isSeeking = $state(false);
	let dropActive = $state(false);
	let dropDepth = $state(0);

	const ttsMixer = new TtsPlaybackMixer();
	let ttsResolverReady = false;
	/** User Original Audio fader (0 when muted) — silenced while TTS is active (no double dialogue). */
	const baseVideoVolume = $derived(projectStore.originalAudioEffectiveGain);
	/** After timeline scrub, hold publishing stale video.currentTime so TTS does not restart twice. */
	let seekHoldUntil = 0;
	let seekHoldTargetMs: number | null = null;

	$effect(() => {
		projectStore.setTtsInvalidateHandler((id) => {
			if (id) ttsMixer.invalidate(id);
		});
		return () => projectStore.setTtsInvalidateHandler(null);
	});

	async function ensureTtsResolver() {
		if (ttsResolverReady || !isTauriRuntime()) return;
		ttsResolverReady = true;
		try {
			const { convertFileSrc } = await import('@tauri-apps/api/core');
			ttsMixer.setUrlResolver((path) => {
				try {
					return convertFileSrc(path);
				} catch {
					return null;
				}
			});
		} catch {
			ttsResolverReady = false;
		}
	}

	function cueHasTtsInWindow(playheadMs: number, playing: boolean): boolean {
		if (!playing) return false;
		return projectStore.current.cues.some((c) => {
			if (!c.assignedAudio || !(c.assignedAudio.url || c.assignedAudio.filePath)) {
				return false;
			}
			return playheadMs >= c.startMs && playheadMs < cuePreviewEndMs(c);
		});
	}

	/** Mute original bed under TTS so preview is not Chinese + Khmer together. */
	function applyVideoDuck(playheadMs: number, playing: boolean) {
		if (!videoEl) return;
		const hasTts = cueHasTtsInWindow(playheadMs, playing);
		const target = hasTts ? 0 : baseVideoVolume;
		if (Math.abs(videoEl.volume - target) > 0.01) {
			videoEl.volume = Math.max(0, Math.min(1, target));
		}
	}

	function syncTts(playheadMs: number, playing: boolean) {
		void ensureTtsResolver();
		ttsMixer.sync({
			playheadMs,
			isPlaying: playing,
			playbackRate: rateValue(),
			preferredCueId: playback.focusedCueId,
			cues: projectStore.current.cues
		});
		applyVideoDuck(playheadMs, playing);
	}

	/** Apply fader immediately when mute/gain changes (including while paused). */
	$effect(() => {
		const gain = baseVideoVolume;
		const el = videoEl;
		if (!el) return;
		untrack(() => {
			const playing = playback.isPlaying;
			const ms = getVisualPlayheadMs() || playback.playheadMs;
			const hasTts = cueHasTtsInWindow(ms, playing);
			el.volume = Math.max(0, Math.min(1, hasTts ? 0 : gain));
		});
	});

	const src = $derived(projectStore.videoUrl);
	const durationMs = $derived(
		mediaDurationMs > 0 ? mediaDurationMs : projectStore.current.durationMs
	);
	const dubOverhangSec = $derived(Math.round(tempoStore.dubOverhangMs / 1000));
	const videoUnderhangSec = $derived(Math.round(tempoStore.videoUnderhangMs / 1000));
	const showSyncBanner = $derived(
		tempoStore.dubOverhangMs > 800 || tempoStore.videoUnderhangMs > 800
	);
	const syncBannerIsShorten = $derived(
		tempoStore.videoUnderhangMs > tempoStore.dubOverhangMs
	);
	/** Coarse clock for paused UI / empty-state (not updated every frame). */
	let transportMs = $state(0);
	const showHours = $derived(durationMs >= 3600_000);
	const videoName = $derived(projectStore.videoAsset?.name ?? null);
	/**
	 * Burn-in text — updated from the visual clock (same as TTS), not the
	 * ~100ms-throttled store playhead (that made text lag the picture).
	 */
	let overlayText = $state<string | null>(null);

	function resolveOverlayText(ms: number): string | null {
		const cues = projectStore.current.cues;
		// Same window as TTS mixer (Align fit-aware) so title ↔ audio match.
		const cue = cues.find((c) => ms >= c.startMs && ms < cuePreviewEndMs(c));
		if (!cue) return null;
		const text = cue.translation?.trim() || cue.source?.trim();
		return text ? text : null;
	}

	function paintOverlay(ms: number) {
		const next = resolveOverlayText(ms);
		if (next !== overlayText) overlayText = next;
	}

	const overlayUsesKhmer = $derived(
		usesKhmerScript(normalizeDubLanguage(projectStore.current.targetLanguage))
	);
	const subStyle = $derived(
		projectStore.current.subtitleStyle ?? {
			fontFamily: 'Noto Sans Khmer',
			fontFile: null,
			fontSizePx: 20,
			x: 0.5,
			y: 0.84,
			look: 'outline' as const,
			maxWidthPct: 0.96,
			outlineWidth: 1
		}
	);

	let frameEl: HTMLElement | undefined = $state();
	let pictureEl: HTMLElement | undefined = $state();
	/** object-contain picture rect inside the 16:9 frame (fractions 0–1). */
	let pictureBox = $state({ left: 0, top: 0, width: 1, height: 1 });
	/** CSS px scale so design sizes (720p-tall) match burn-in. */
	let designScale = $state(1);

	function updatePictureBox() {
		if (!frameEl) return;
		const fw = frameEl.clientWidth;
		const fh = frameEl.clientHeight;
		if (fw < 2 || fh < 2) return;

		const vw = videoEl?.videoWidth || 16;
		const vh = videoEl?.videoHeight || 9;
		const scale = Math.min(fw / vw, fh / vh);
		const w = vw * scale;
		const h = vh * scale;
		pictureBox = {
			left: (fw - w) / 2 / fw,
			top: (fh - h) / 2 / fh,
			width: w / fw,
			height: h / fh
		};
		// Same 720p-tall design space as export ASS mapping.
		designScale = Math.max(0.25, h / 720);
	}

	function outlineTextShadow(widthPx: number): string {
		const d = Math.max(0, Math.min(5, widthPx));
		if (d < 0.05) return 'none';
		const a = d.toFixed(2);
		return [
			`-${a}px -${a}px 0 #000`,
			`${a}px -${a}px 0 #000`,
			`-${a}px ${a}px 0 #000`,
			`${a}px ${a}px 0 #000`,
			`-${a}px 0 0 #000`,
			`${a}px 0 0 #000`,
			`0 -${a}px 0 #000`,
			`0 ${a}px 0 #000`
		].join(', ');
	}

	const overlayFontPx = $derived(subStyle.fontSizePx * designScale);
	const overlayOutlinePx = $derived((subStyle.outlineWidth ?? 1) * designScale);
	const overlayShadow = $derived(outlineTextShadow(overlayOutlinePx));
	let raf = 0;
	let lastTick = 0;
	let playToken = 0;
	let lastStorePushAt = 0;
	let durationChecked = false;
	let currentTimeEl: HTMLSpanElement | undefined = $state();
	let durationTimeEl: HTMLSpanElement | undefined = $state();
	let progressFillEl: HTMLDivElement | undefined = $state();
	let scrubTrackEl: HTMLDivElement | undefined = $state();

	function rateValue() {
		const n = Number(playbackRate);
		return Number.isFinite(n) && n > 0 ? n : 1;
	}

	function applyPlaybackRate(el: HTMLVideoElement | undefined = videoEl) {
		if (!el) return;
		const rate = rateValue();
		try {
			el.playbackRate = rate;
			el.defaultPlaybackRate = rate;
		} catch {
			/* some engines throw on unsupported rates */
		}
	}

	function videoDurationSec(): number {
		const d = videoEl?.duration;
		return typeof d === 'number' && Number.isFinite(d) && d > 0 ? d : 0;
	}

	function isNearEnd(el: HTMLVideoElement) {
		const dur = el.duration;
		if (el.ended) return true;
		if (!Number.isFinite(dur) || dur <= 0) return false;
		return el.currentTime >= dur - 0.05;
	}

	function ensureMediaDuration() {
		if (!videoEl || durationChecked) return;
		const sec = videoDurationSec();
		if (!sec) return;
		const ms = sec * 1000;
		durationChecked = true;
		if (Math.abs(ms - mediaDurationMs) > 250) mediaDurationMs = ms;
		if (Math.abs(ms - projectStore.current.durationMs) > 500) {
			projectStore.setDurationMs(ms);
		}
		if (durationTimeEl) {
			durationTimeEl.textContent = formatClock(ms, ms >= 3600_000);
		}
	}

	let subSelected = $state(false);
	type SubDragKind =
		| 'move'
		| 'resize-nw'
		| 'resize-ne'
		| 'resize-sw'
		| 'resize-se'
		| 'resize-e'
		| 'resize-w';
	let subDrag: {
		kind: SubDragKind;
		pointerId: number;
		startX: number;
		startY: number;
		originX: number;
		originY: number;
		originSize: number;
		originMaxW: number;
	} | null = $state(null);

	function deselectSub() {
		subSelected = false;
		endSubDrag();
	}

	function endSubDrag() {
		if (!subDrag) return;
		subDrag = null;
		window.removeEventListener('pointermove', onWindowSubPointerMove);
		window.removeEventListener('pointerup', onWindowSubPointerUp);
		window.removeEventListener('pointercancel', onWindowSubPointerUp);
	}

	function beginSubDrag(kind: SubDragKind, e: PointerEvent) {
		subSelected = true;
		subDrag = {
			kind,
			pointerId: e.pointerId,
			startX: e.clientX,
			startY: e.clientY,
			originX: subStyle.x,
			originY: subStyle.y,
			originSize: subStyle.fontSizePx,
			originMaxW: subStyle.maxWidthPct ?? 0.96
		};
		window.addEventListener('pointermove', onWindowSubPointerMove);
		window.addEventListener('pointerup', onWindowSubPointerUp);
		window.addEventListener('pointercancel', onWindowSubPointerUp);
	}

	function onSubPointerDown(e: PointerEvent) {
		if (e.button !== 0) return;
		// Ignore clicks that started on a resize handle (handles stopPropagation too).
		if ((e.target as HTMLElement | null)?.closest?.('.video-subtitle-handle')) return;
		e.preventDefault();
		e.stopPropagation();
		beginSubDrag('move', e);
	}

	function onHandlePointerDown(kind: SubDragKind, e: PointerEvent) {
		if (e.button !== 0) return;
		e.preventDefault();
		e.stopPropagation();
		beginSubDrag(kind, e);
	}

	function onWindowSubPointerMove(e: PointerEvent) {
		if (!subDrag || e.pointerId !== subDrag.pointerId) return;
		e.preventDefault();
		const box = pictureEl?.getBoundingClientRect() ?? frameEl?.getBoundingClientRect();
		if (!box || box.width < 8 || box.height < 8) return;

		if (subDrag.kind === 'move') {
			const dx = (e.clientX - subDrag.startX) / box.width;
			const dy = (e.clientY - subDrag.startY) / box.height;
			projectStore.setSubtitleStyle({
				x: Math.max(0.05, Math.min(0.95, subDrag.originX + dx)),
				y: Math.max(0.03, Math.min(0.97, subDrag.originY + dy))
			});
			return;
		}

		if (subDrag.kind === 'resize-e' || subDrag.kind === 'resize-w') {
			// Grow/shrink box width from center (anchor stays put via translate -50%).
			const dx = (e.clientX - subDrag.startX) / box.width;
			const signed = subDrag.kind === 'resize-e' ? dx : -dx;
			projectStore.setSubtitleStyle({
				maxWidthPct: Math.max(0.2, Math.min(0.98, subDrag.originMaxW + signed * 2))
			});
			return;
		}

		// Corner: scale font size by distance change from center.
		const cx = box.left + subDrag.originX * box.width;
		const cy = box.top + subDrag.originY * box.height;
		const startDist = Math.hypot(subDrag.startX - cx, subDrag.startY - cy) || 1;
		const nowDist = Math.hypot(e.clientX - cx, e.clientY - cy);
		const scale = nowDist / startDist;
		projectStore.setSubtitleStyle({
			fontSizePx: Math.max(12, Math.min(72, Math.round(subDrag.originSize * scale)))
		});
	}

	function onWindowSubPointerUp(e: PointerEvent) {
		if (!subDrag || e.pointerId !== subDrag.pointerId) return;
		endSubDrag();
	}

	function onFramePointerDown(e: PointerEvent) {
		// Click empty frame area → deselect subtitle chrome.
		if ((e.target as HTMLElement | null)?.closest?.('.video-subtitle-overlay')) return;
		deselectSub();
	}

	$effect(() => {
		if (!overlayText) deselectSub();
	});

	/** While paused/scrubbing, keep burn-in in sync with store playhead + cue edits. */
	$effect(() => {
		const cues = projectStore.current.cues;
		const ms = playback.playheadMs;
		void cues;
		if (playback.isPlaying) return;
		paintOverlay(ms);
	});

	function paintTransport(ms: number) {
		const dur = Math.max(durationMs, 1);
		if (currentTimeEl) {
			currentTimeEl.textContent = formatClock(ms, showHours);
		}
		if (progressFillEl) {
			progressFillEl.style.width = `${Math.min(100, (ms / dur) * 100)}%`;
		}
	}

	function publishClock(ms: number, now = performance.now(), forceStore = false) {
		const safe = Math.max(0, ms);
		setVisualPlayheadMs(safe);
		// Paint timer/progress via DOM — never feed a Bits UI slider every frame
		// (that re-triggered seek and made playback crawl).
		paintTransport(safe);
		paintOverlay(safe);

		if (forceStore || now - lastStorePushAt >= 100) {
			lastStorePushAt = now;
			transportMs = safe;
			projectStore.setPlayhead(safe);
		}
	}

	/** Freeze clock on the real media time (avoids snap-back from throttled store). */
	function syncClockFromMedia(forceStore = true) {
		if (videoEl && Number.isFinite(videoEl.currentTime) && !videoEl.ended) {
			publishClock(videoEl.currentTime * 1000, performance.now(), forceStore);
			return;
		}
		publishClock(getVisualPlayheadMs(), performance.now(), forceStore);
	}

	function pushPlayheadFromVideo(forceStore = false) {
		if (!videoEl) return;
		if (isSeeking) return;

		const videoMs = videoEl.currentTime * 1000;
		const requested = consumeMediaSeekMs();
		const now = performance.now();

		// Honor an intentional scrub/jump once, then hold until <video> catches up
		// so we never publish stale currentTime (that restarted TTS as a double attack).
		if (requested != null && Number.isFinite(requested)) {
			const dur = videoDurationSec();
			if (dur) {
				videoEl.currentTime = Math.min(dur, Math.max(0, requested / 1000));
			}
			seekHoldTargetMs = requested;
			seekHoldUntil = now + 140;
			publishClock(requested, now, true);
			return;
		}

		if (seekHoldTargetMs != null && now < seekHoldUntil) {
			const delta = Math.abs(videoMs - seekHoldTargetMs);
			if (delta > 60) {
				// Keep visual/TTS on the requested time; re-nudge media if it slipped.
				if (delta > 250 && videoDurationSec()) {
					try {
						videoEl.currentTime = Math.max(0, seekHoldTargetMs / 1000);
					} catch {
						/* ignore */
					}
				}
				publishClock(seekHoldTargetMs, now, forceStore);
				return;
			}
			seekHoldTargetMs = null;
			seekHoldUntil = 0;
		}

		// While playing, the <video> element is the source of truth.
		publishClock(videoMs, now, forceStore);

		if (playback.isPlaying && isNearEnd(videoEl)) {
			finishPlayback();
		}
	}

	/** Media finished — show Play and keep playhead at the end. */
	function finishPlayback() {
		projectStore.pausePlayback();
		isSeeking = false;
		if (!videoEl) return;
		const sec = videoDurationSec();
		const endMs = sec > 0 ? sec * 1000 : projectStore.current.durationMs;
		publishClock(endMs, performance.now(), true);
	}

	function advanceDemo(now: number) {
		if (!lastTick) lastTick = now;
		const delta = (now - lastTick) * rateValue();
		lastTick = now;
		const next = getVisualPlayheadMs() + delta;
		if (next >= durationMs) {
			publishClock(durationMs, now, true);
			projectStore.pausePlayback();
			return;
		}
		publishClock(next, now);
	}

	function stopClock() {
		if (raf) {
			cancelAnimationFrame(raf);
			raf = 0;
		}
		lastTick = 0;
	}

	function startClock(token: number) {
		stopClock();
		let lastPlayAttempt = 0;
		const loop = (now: number) => {
			if (token !== playToken || !playback.isPlaying) {
				raf = 0;
				return;
			}

			if (videoEl) {
				applyPlaybackRate(videoEl);
				if (videoEl.paused && !videoEl.ended) {
					// Retry play, but not every frame — rapid play() spam stalls WebView2.
					if (now - lastPlayAttempt > 280) {
						lastPlayAttempt = now;
						void videoEl.play().catch(() => {
							if (token === playToken) projectStore.pausePlayback();
						});
					}
				} else {
					pushPlayheadFromVideo();
				}
				const ms = getVisualPlayheadMs();
				projectStore.finishFocusedCueIfPast(ms);
				if (!playback.isPlaying) {
					ttsMixer.pauseAll();
					if (videoEl) videoEl.volume = baseVideoVolume;
					raf = 0;
					return;
				}
				syncTts(ms, true);
			} else {
				advanceDemo(now);
				const ms = getVisualPlayheadMs();
				projectStore.finishFocusedCueIfPast(ms);
				if (!playback.isPlaying) {
					ttsMixer.pauseAll();
					raf = 0;
					return;
				}
				syncTts(ms, true);
			}

			raf = requestAnimationFrame(loop);
		};
		raf = requestAnimationFrame(loop);
	}

	async function startVideoPlayback(token: number) {
		const el = videoEl;
		if (!el) {
			startClock(token);
			return;
		}

		isSeeking = false;
		durationChecked = false;
		// Avoid tracking project/duration inside the play effect — use untracked reads.
		untrack(() => ensureMediaDuration());
		applyPlaybackRate(el);

		try {
			const { stopVoicePreview } = await import('$lib/tts/voice-preview');
			stopVoicePreview();
		} catch {
			/* ignore */
		}

		// Apply any pending timeline scrub before starting.
		const requested = consumeMediaSeekMs();
		if (requested != null && Number.isFinite(requested)) {
			applyVideoCurrentTime(requested);
			seekHoldTargetMs = requested;
			seekHoldUntil = performance.now() + 140;
			publishClock(requested, performance.now(), true);
		} else if (isNearEnd(el)) {
			el.currentTime = 0;
			publishClock(0, performance.now(), true);
		}

		try {
			await el.play();
		} catch {
			if (token === playToken && playback.isPlaying) projectStore.pausePlayback();
			return;
		}

		applyPlaybackRate(el);

		if (token !== playToken || !playback.isPlaying) {
			el.pause();
			ttsMixer.pauseAll();
			return;
		}
		publishClock(el.currentTime * 1000, performance.now(), true);
		startClock(token);
	}

	$effect(() => {
		const el = videoEl;
		void playbackRate;
		untrack(() => applyPlaybackRate(el));
	});

	/**
	 * Play/pause orchestration.
	 * CRITICAL: only depend on `isPlaying`. Any other reactive reads (videoEl, project,
	 * duration, playhead) must be untracked — otherwise the effect re-runs mid-playback,
	 * stops the rAF clock, and leaves the UI stuck on the Pause icon at 00:00.
	 */
	let lastPlaying = false;
	$effect(() => {
		const playing = playback.isPlaying;
		if (playing === lastPlaying) return;
		lastPlaying = playing;

		untrack(() => {
			const token = ++playToken;
			stopClock();

			if (!playing) {
				try {
					videoEl?.pause();
				} catch {
					/* ignore */
				}
				seekHoldTargetMs = null;
				seekHoldUntil = 0;
				syncClockFromMedia(true);
				ttsMixer.pauseAll();
				if (videoEl) videoEl.volume = baseVideoVolume;
				return;
			}

			void startVideoPlayback(token);
		});
	});

	// Keep local transport in sync when scrubbing from timeline while paused.
	$effect(() => {
		const playing = playback.isPlaying;
		const seeking = isSeeking;
		if (playing || seeking) return;
		const ms = playback.playheadMs;
		untrack(() => {
			transportMs = ms;
			setVisualPlayheadMs(ms);
			paintTransport(ms);
			syncTts(ms, false);
		});
	});

	// Reset local media duration when source changes.
	$effect(() => {
		void src;
		untrack(() => {
			mediaDurationMs = 0;
			isSeeking = false;
			durationChecked = false;
			transportMs = 0;
			lastStorePushAt = 0;
			seekHoldTargetMs = null;
			seekHoldUntil = 0;
			setVisualPlayheadMs(0);
			paintTransport(0);
			ttsMixer.pauseAll();
			// If we were "playing" against a dead element, drop back to paused.
			if (playback.isPlaying) projectStore.pausePlayback();
			lastPlaying = false;
		});
	});

	// Warm TTS buffers when clips appear (untracked — must not interrupt playback).
	$effect(() => {
		const clips = projectStore.current.cues.filter(
			(c) => c.assignedAudio && (c.assignedAudio.url || c.assignedAudio.filePath)
		);
		if (!clips.length) return;
		untrack(() => {
			void ensureTtsResolver().then(() => ttsMixer.warmup(clips));
		});
	});

	onDestroy(() => {
		playToken += 1;
		lastPlaying = false;
		stopClock();
		endSubDrag();
		ttsMixer.dispose();
	});

	function togglePlay() {
		isSeeking = false;
		projectStore.togglePlayback();
	}

	function onVideoEnded() {
		finishPlayback();
	}

	function onTimeUpdate() {
		// rAF owns the clock while playing — also syncing here fought seeks and
		// restarted TTS (duplicate syllable). Paused seeks use the store effect.
		if (playback.isPlaying || isSeeking) return;
	}

	function onRateChange() {
		if (!videoEl) return;
		applyPlaybackRate(videoEl);
	}

	function onLoadedMetadata() {
		if (!videoEl) return;
		durationChecked = false;
		ensureMediaDuration();
		applyPlaybackRate(videoEl);
		updatePictureBox();
		const ms = videoDurationSec() * 1000;
		if (ms > 0) {
			mediaDurationMs = ms;
			projectStore.setDurationMs(ms);
		}
	}

	$effect(() => {
		const frame = frameEl;
		const video = videoEl;
		void src;
		if (!frame) return;
		updatePictureBox();
		const ro = new ResizeObserver(() => updatePictureBox());
		ro.observe(frame);
		if (video) ro.observe(video);
		return () => ro.disconnect();
	});

	/** Seek the media element; clears `ended` so scrubbing after finish works. */
	function applyVideoCurrentTime(ms: number) {
		queueProgramSeek(ms, true);
	}

	/**
	 * Latest-wins seek queue. Spamming `currentTime` every pointer move makes
	 * WebView2/Chromium backlog seeks for seconds — wait for `seeked`, then jump
	 * straight to the newest target.
	 */
	let programSeekTargetSec: number | null = null;
	let programSeekInFlight = false;
	let programSeekSafetyTimer = 0;
	let programSeekEpoch = 0;

	function clearProgramSeekSafety() {
		if (programSeekSafetyTimer) {
			clearTimeout(programSeekSafetyTimer);
			programSeekSafetyTimer = 0;
		}
	}

	function queueProgramSeek(ms: number, forceImmediate = false) {
		if (!videoEl) return;
		const dur = videoDurationSec();
		if (!dur) return;
		const t = Math.min(dur, Math.max(0, ms / 1000));
		programSeekTargetSec = t;
		if (forceImmediate && !programSeekInFlight) {
			kickProgramSeek();
			return;
		}
		kickProgramSeek();
	}

	function kickProgramSeek() {
		const el = videoEl;
		if (!el || programSeekTargetSec == null) return;
		if (programSeekInFlight) return;

		const t = programSeekTargetSec;
		programSeekTargetSec = null;

		if (Math.abs(el.currentTime - t) < 0.035) {
			if (programSeekTargetSec != null) kickProgramSeek();
			return;
		}

		programSeekInFlight = true;
		const epoch = ++programSeekEpoch;

		const finish = () => {
			if (epoch !== programSeekEpoch) return;
			clearProgramSeekSafety();
			el.removeEventListener('seeked', finish);
			el.removeEventListener('error', finish);
			programSeekInFlight = false;
			if (programSeekTargetSec != null) kickProgramSeek();
		};

		el.addEventListener('seeked', finish, { once: true });
		el.addEventListener('error', finish, { once: true });
		clearProgramSeekSafety();
		// If seeked never fires (some WebView2 edge cases), unblock quickly.
		programSeekSafetyTimer = window.setTimeout(finish, 180);

		try {
			if (el.ended) el.pause();
			const fast = (el as HTMLVideoElement & { fastSeek?: (sec: number) => void }).fastSeek;
			if (typeof fast === 'function') fast.call(el, t);
			else el.currentTime = t;
			if (el.ended && t < (videoDurationSec() || t) - 0.05) {
				requestAnimationFrame(() => {
					if (!videoEl || epoch !== programSeekEpoch) return;
					try {
						videoEl.currentTime = t;
					} catch {
						/* ignore */
					}
				});
			}
		} catch {
			finish();
		}
	}

	function seekTo(ms: number) {
		const maxMs = Math.max(durationMs, projectStore.current.durationMs, 1);
		const clamped = Math.max(0, Math.min(maxMs, ms));
		seekHoldTargetMs = clamped;
		seekHoldUntil = performance.now() + 140;
		setVisualPlayheadMs(clamped, { seekMedia: true });
		publishClock(clamped, performance.now(), true);
		queueProgramSeek(clamped);
		syncTts(clamped, playback.isPlaying);
	}

	/** Keep the HTML video element aligned when playhead is scrubbed (timeline / keys). */
	$effect(() => {
		const playing = playback.isPlaying;
		const seeking = isSeeking;
		const el = videoEl;
		if (!el || seeking || playing) return;
		const targetMs = playback.playheadMs;

		untrack(() => {
			const videoMs = el.currentTime * 1000;
			const delta = Math.abs(targetMs - videoMs);
			// Paused: ignore tiny lag / throttle noise.
			if (delta <= 40) return;
			if (!videoDurationSec()) return;

			queueProgramSeek(targetMs);
			setVisualPlayheadMs(targetMs);
			paintTransport(targetMs);
			paintOverlay(targetMs);
			syncTts(targetMs, false);
		});
	});

	/**
	 * Timeline scrub sets seekMedia every move — drain with a latest-wins seek
	 * queue so the program monitor stays live without seek backlog.
	 */
	$effect(() => {
		const el = videoEl;
		if (!el) return;

		let uiMs: number | null = null;
		let uiRaf = 0;

		const paintUi = () => {
			uiRaf = 0;
			const ms = uiMs;
			uiMs = null;
			if (ms == null) return;
			transportMs = ms;
			paintTransport(ms);
			paintOverlay(ms);
			// Skip TTS while scrubbing — mixer work was adding seek lag.
			if (!playback.isPlaying && !isSeeking && !isTimelineScrubbing()) syncTts(ms, false);
		};

		const unsub = onMediaSeekRequest((ms) => {
			// While playing, the rAF clock owns seeks via consumeMediaSeekMs().
			if (isSeeking || playback.isPlaying) return;
			consumeMediaSeekMs();
			uiMs = ms;
			if (!uiRaf) uiRaf = requestAnimationFrame(paintUi);
			queueProgramSeek(ms);
		});

		return () => {
			unsub();
			if (uiRaf) cancelAnimationFrame(uiRaf);
			clearProgramSeekSafety();
			programSeekEpoch += 1;
			programSeekInFlight = false;
			programSeekTargetSec = null;
		};
	});

	function msFromScrubPointer(clientX: number) {
		if (!scrubTrackEl) return 0;
		const rect = scrubTrackEl.getBoundingClientRect();
		const t = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
		return Math.max(0, Math.min(1, t)) * Math.max(durationMs, 1);
	}

	function onScrubPointerDown(e: PointerEvent & { currentTarget: HTMLElement }) {
		e.preventDefault();
		isSeeking = true;
		e.currentTarget.setPointerCapture(e.pointerId);
		seekTo(msFromScrubPointer(e.clientX));
	}

	function onScrubPointerMove(e: PointerEvent) {
		if (!isSeeking) return;
		seekTo(msFromScrubPointer(e.clientX));
	}

	function onScrubPointerUp(e: PointerEvent & { currentTarget: HTMLElement }) {
		if (!isSeeking) return;
		seekTo(msFromScrubPointer(e.clientX));
		isSeeking = false;
		try {
			e.currentTarget.releasePointerCapture(e.pointerId);
		} catch {
			/* already released */
		}
	}

	function setSpeed(v: string | undefined) {
		if (!v) return;
		playbackRate = v;
		applyPlaybackRate(videoEl);
	}

	function zoomBy(delta: number) {
		zoom = Math.min(3, Math.max(1, Number((zoom + delta).toFixed(2))));
	}

	async function toggleFullscreen() {
		if (!shellEl) return;
		try {
			if (!document.fullscreenElement) {
				await shellEl.requestFullscreen();
				isFullscreen = true;
			} else {
				await document.exitFullscreen();
				isFullscreen = false;
			}
		} catch {
			isFullscreen = Boolean(document.fullscreenElement);
		}
	}

	function onFullscreenChange() {
		isFullscreen = document.fullscreenElement === shellEl;
	}

	function openFilePicker() {
		void openVideoWithDialog();
	}

	async function openVideoWithDialog() {
		if (isTauriRuntime()) {
			try {
				const { open } = await import('@tauri-apps/plugin-dialog');
				const selected = await open({
					title: 'Open video',
					multiple: false,
					filters: [
						{
							name: 'Video',
							extensions: ['mp4', 'mov', 'mkv', 'webm', 'm4v', 'avi']
						}
					]
				});
				if (!selected || Array.isArray(selected)) return;
				const ok = await projectStore.setVideoFromPath(selected);
				if (ok) {
					tempoStore.syncFromProject();
					const name = selected.split(/[/\\]/).pop() || 'video';
					dndStore.flash(`Loaded ${name}`);
				} else {
					dndStore.flash('Could not open video');
				}
				return;
			} catch {
				/* fall through to HTML file input */
			}
		}
		fileInput?.click();
	}

	function loadVideoFile(file: File | undefined | null) {
		if (!file) return;
		if (classifyMediaFile(file) !== 'video') {
			dndStore.flash('Please choose a video file');
			return;
		}
		const ok = projectStore.setVideoFromFile(file);
		if (ok) {
			tempoStore.syncFromProject();
			dndStore.flash(`Loaded ${file.name}`);
		}
	}

	function onFileInputChange(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		loadVideoFile(input.files?.[0]);
		input.value = '';
	}

	function onDragEnter(e: DragEvent) {
		if (!isFileDrag(e)) return;
		e.preventDefault();
		e.stopPropagation();
		dropDepth += 1;
		dropActive = true;
	}

	function onDragLeave(e: DragEvent) {
		if (!isFileDrag(e)) return;
		e.preventDefault();
		e.stopPropagation();
		dropDepth = Math.max(0, dropDepth - 1);
		if (dropDepth === 0) dropActive = false;
	}

	function onDragOver(e: DragEvent) {
		if (!isFileDrag(e)) return;
		e.preventDefault();
		e.stopPropagation();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
		dropActive = true;
	}

	function onDrop(e: DragEvent) {
		if (!isFileDrag(e)) return;
		e.preventDefault();
		e.stopPropagation();
		dropDepth = 0;
		dropActive = false;

		const files = Array.from(e.dataTransfer?.files ?? []);
		const video = files.find((f) => classifyMediaFile(f) === 'video');
		if (!video) {
			dndStore.flash('Drop a video file here');
			return;
		}
		loadVideoFile(video);
	}
</script>

<svelte:document onfullscreenchange={onFullscreenChange} />

<input
	bind:this={fileInput}
	type="file"
	accept="video/*,.mp4,.mov,.mkv,.webm,.m4v,.avi"
	class="hidden"
	onchange={onFileInputChange}
/>

<section
	bind:this={shellEl}
	class="video-preview flex min-h-0 flex-col overflow-hidden {className}"
	data-slot="video-preview"
>
	<!-- Player stage -->
	<div
		class="video-preview-stage relative min-h-0 flex-1 overflow-hidden"
		class:video-drop-active={dropActive}
		ondragenter={onDragEnter}
		ondragleave={onDragLeave}
		ondragover={onDragOver}
		ondrop={onDrop}
		role="presentation"
	>
		<div class="absolute inset-0 flex items-center justify-center overflow-hidden p-2">
			<div
				bind:this={frameEl}
				class="video-preview-frame relative aspect-video h-full max-h-full w-full max-w-full overflow-hidden rounded-md transition-transform duration-200 ease-out"
				style="transform: scale({zoom}); transform-origin: center center;"
				onpointerdown={onFramePointerDown}
				role="presentation"
			>
				{#if src}
					<video
						bind:this={videoEl}
						class="size-full object-contain"
						{src}
						playsinline
						preload="metadata"
						onloadedmetadata={onLoadedMetadata}
						ontimeupdate={onTimeUpdate}
						onratechange={onRateChange}
						onended={onVideoEnded}
						onclick={togglePlay}
					>
						<track kind="captions" />
					</video>
				{:else}
					<div
						class="video-preview-placeholder flex size-full flex-col items-center justify-center gap-3 px-4 text-center"
					>
						<p class="preview-eyebrow text-[11px] tracking-[0.2em] uppercase">
							Program Monitor
						</p>
						<p class="preview-title text-sm font-medium">Drop source video to begin</p>
						<p class="max-w-[16rem] text-[11px] text-muted-foreground">
							Drag a video onto this panel, or open a file from disk.
						</p>
						<Button
							variant="secondary"
							size="sm"
							class="mt-1 gap-1.5"
							onclick={openFilePicker}
						>
							<FolderOpen class="size-3.5" />
							Open video
						</Button>
						<p class="font-mono text-[11px] text-primary">
							{formatTimecode(transportMs, projectStore.current.fps)}
						</p>
					</div>
					<div
						class="pointer-events-none absolute inset-y-0 w-px bg-primary shadow-[0_0_12px_color-mix(in_oklab,var(--primary)_55%,transparent)]"
						style="left: {durationMs > 0 ? Math.min(100, (transportMs / durationMs) * 100) : 0}%"
						aria-hidden="true"
					></div>
				{/if}

				{#if dropActive}
					<div class="video-drop-overlay" aria-live="polite">
						<div class="video-drop-card">
							<Upload class="size-5" />
							<span>Drop video to load</span>
						</div>
					</div>
				{/if}

				<!-- Align burn-in with object-contain picture (not letterbox bars). -->
				<div
					bind:this={pictureEl}
					class="video-picture-layer"
					style="left: {pictureBox.left * 100}%; top: {pictureBox.top * 100}%; width: {pictureBox.width *
						100}%; height: {pictureBox.height * 100}%;"
				>
					{#if overlayText}
						<div
							class="video-subtitle-overlay"
							class:video-subtitle-selected={subSelected}
							class:video-subtitle-dragging={subDrag?.kind === 'move'}
							class:video-subtitle-look-outline={subStyle.look !== 'box'}
							class:video-subtitle-look-box={subStyle.look === 'box'}
							class:video-subtitle-anchor-bottom={subStyle.y >= 0.55}
							class:video-subtitle-anchor-top={subStyle.y <= 0.45}
							class:video-subtitle-anchor-middle={subStyle.y > 0.45 && subStyle.y < 0.55}
							style="left: {subStyle.x * 100}%; top: {subStyle.y * 100}%; width: {(subStyle.maxWidthPct ??
								0.96) * 100}%;"
							aria-live="polite"
							role="group"
							aria-label="Subtitle overlay — click to select, drag to move, handles to resize"
							onpointerdown={onSubPointerDown}
						>
							<p
								class="video-subtitle-text"
								class:font-khmer={overlayUsesKhmer}
								lang={normalizeDubLanguage(projectStore.current.targetLanguage)}
								style="font-family: '{subStyle.fontFamily}', var(--font-khmer), sans-serif; font-size: {overlayFontPx}px; {subStyle.look !==
								'box'
									? `text-shadow: ${overlayShadow};`
									: ''}"
							>
								{overlayText}
							</p>
							{#if subSelected}
								<span
									class="video-subtitle-handle video-subtitle-handle-nw"
									aria-hidden="true"
									onpointerdown={(e) => onHandlePointerDown('resize-nw', e)}
								></span>
								<span
									class="video-subtitle-handle video-subtitle-handle-ne"
									aria-hidden="true"
									onpointerdown={(e) => onHandlePointerDown('resize-ne', e)}
								></span>
								<span
									class="video-subtitle-handle video-subtitle-handle-sw"
									aria-hidden="true"
									onpointerdown={(e) => onHandlePointerDown('resize-sw', e)}
								></span>
								<span
									class="video-subtitle-handle video-subtitle-handle-se"
									aria-hidden="true"
									onpointerdown={(e) => onHandlePointerDown('resize-se', e)}
								></span>
								<span
									class="video-subtitle-handle video-subtitle-handle-w"
									aria-hidden="true"
									onpointerdown={(e) => onHandlePointerDown('resize-w', e)}
								></span>
								<span
									class="video-subtitle-handle video-subtitle-handle-e"
									aria-hidden="true"
									onpointerdown={(e) => onHandlePointerDown('resize-e', e)}
								></span>
							{/if}
						</div>
					{/if}
				</div>
			</div>
		</div>

		{#if zoom > 1}
			<span
				class="absolute top-2 right-2 rounded-md border border-border/70 bg-[var(--surface-overlay)] px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground shadow-sm"
			>
				{zoom.toFixed(2)}×
			</span>
		{/if}

		{#if videoName && !overlayText}
			<span
				class="absolute bottom-2 left-2 max-w-[70%] truncate rounded-md border border-border/70 bg-[var(--surface-overlay)] px-1.5 py-0.5 text-[10px] text-muted-foreground shadow-sm"
				title={videoName}
			>
				{videoName}
			</span>
		{/if}

		{#if showSyncBanner}
			<div class="sync-banner" role="status">
				<p>
					{#if syncBannerIsShorten}
						Video runs ~{videoUnderhangSec}s past the Khmer dub — picture feels slow vs the script.
					{:else}
						Khmer TTS runs ~{dubOverhangSec}s past the video — preview stops at the picture end.
					{/if}
				</p>
				<Button
					size="sm"
					variant="secondary"
					class="shrink-0"
					disabled={tempoStore.isRemastering ||
						tempoStore.mediaDurationMs < 500 ||
						!projectStore.current.cues.length ||
						(!!tempoStore.fitToDubPlan?.alreadyFits &&
							tempoStore.dubOverhangMs <= 400 &&
							tempoStore.videoUnderhangMs <= 800 &&
							!tempoStore.hasOverhangPrompt)}
					onclick={() => {
						projectStore.setVideoTool('tempo');
						void tempoStore.fitToDub();
					}}
				>
					{#if tempoStore.isRemastering}
						Aligning…
					{:else if tempoStore.fitToDubPlan && !tempoStore.fitToDubPlan.alreadyFits}
						{#if tempoStore.fitToDubPlan.tempo < 0.995}
							Align (video {tempoStore.fitToDubPlan.tempo.toFixed(2)}×)
						{:else}
							Align script ↔ video
						{/if}
					{:else}
						Align script ↔ video
					{/if}
				</Button>
			</div>
		{/if}
	</div>

	<!-- Transport / controls -->
	<div class="shrink-0 space-y-2 border-t border-border/70 bg-sidebar/95 px-2.5 py-2 backdrop-blur">
		<div class="flex items-center gap-2">
			<span
				bind:this={currentTimeEl}
				class="w-12 shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground"
			>
				{formatClock(transportMs, showHours)}
			</span>
			<div
				bind:this={scrubTrackEl}
				class="preview-scrub relative h-2 flex-1 cursor-pointer touch-none rounded-full bg-muted"
				role="slider"
				tabindex="0"
				aria-label="Playback progress"
				aria-valuemin={0}
				aria-valuemax={Math.max(durationMs, 1)}
				aria-valuenow={transportMs}
				onpointerdown={onScrubPointerDown}
				onpointermove={onScrubPointerMove}
				onpointerup={onScrubPointerUp}
				onpointercancel={onScrubPointerUp}
				onkeydown={(e) => {
					const step = e.shiftKey ? 1000 : 100;
					if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
						e.preventDefault();
						seekTo(transportMs - step);
					} else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
						e.preventDefault();
						seekTo(transportMs + step);
					} else if (e.key === 'Home') {
						e.preventDefault();
						seekTo(0);
					} else if (e.key === 'End') {
						e.preventDefault();
						seekTo(durationMs);
					}
				}}
			>
				<div
					bind:this={progressFillEl}
					class="preview-scrub-fill absolute inset-y-0 left-0 rounded-full bg-primary"
					style="width: {durationMs > 0 ? Math.min(100, (transportMs / durationMs) * 100) : 0}%"
				></div>
			</div>
			<span
				bind:this={durationTimeEl}
				class="w-12 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted-foreground"
			>
				{formatClock(durationMs, showHours)}
			</span>
		</div>

		<Tooltip.Provider>
			<div class="flex items-center gap-1">
				<Tooltip.Root>
					<Tooltip.Trigger class="inline-flex">
						{#snippet child({ props })}
							<Button
								{...props}
								size="icon-sm"
								aria-label={playback.isPlaying ? 'Pause' : 'Play'}
								onclick={togglePlay}
							>
								{#if playback.isPlaying}
									<Pause class="size-4 fill-current" />
								{:else}
									<Play class="size-4 fill-current" />
								{/if}
							</Button>
						{/snippet}
					</Tooltip.Trigger>
					<Tooltip.Content sideOffset={6}
						>{playback.isPlaying ? 'Pause' : 'Play'}</Tooltip.Content
					>
				</Tooltip.Root>

				<Tooltip.Root>
					<Tooltip.Trigger class="inline-flex">
						{#snippet child({ props })}
							<Button
								{...props}
								variant="ghost"
								size="icon-sm"
								aria-label="Open video"
								onclick={openFilePicker}
							>
								<FolderOpen class="size-4" />
							</Button>
						{/snippet}
					</Tooltip.Trigger>
					<Tooltip.Content sideOffset={6}>Open video</Tooltip.Content>
				</Tooltip.Root>

				<Select.Root
					type="single"
					value={playbackRate}
					onValueChange={setSpeed}
				>
					<Select.Trigger
						size="sm"
						class="h-7 min-w-[4.25rem] px-2 text-xs"
						aria-label="Preview playback speed (changes pitch)"
						title="Preview only — changes pitch. Use Video Tools → Tempo for pitch-safe remaster."
					>
						{playbackRate}×
					</Select.Trigger>
					<Select.Content align="start">
						{#each speeds as speed}
							<Select.Item value={speed} label="{speed}×">{speed}×</Select.Item>
						{/each}
					</Select.Content>
				</Select.Root>

				<div class="ml-auto flex items-center gap-0.5">
					<Tooltip.Root>
						<Tooltip.Trigger class="inline-flex">
							{#snippet child({ props })}
								<Button
									{...props}
									variant="ghost"
									size="icon-sm"
									aria-label="Zoom out"
									disabled={zoom <= 1}
									onclick={() => zoomBy(-0.25)}
								>
									<ZoomOut class="size-4" />
								</Button>
							{/snippet}
						</Tooltip.Trigger>
						<Tooltip.Content sideOffset={6}>Zoom out</Tooltip.Content>
					</Tooltip.Root>

					<Tooltip.Root>
						<Tooltip.Trigger class="inline-flex">
							{#snippet child({ props })}
								<Button
									{...props}
									variant="ghost"
									size="icon-sm"
									aria-label="Zoom in"
									disabled={zoom >= 3}
									onclick={() => zoomBy(0.25)}
								>
									<ZoomIn class="size-4" />
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
									size="icon-sm"
									aria-label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
									onclick={toggleFullscreen}
								>
									{#if isFullscreen}
										<Minimize class="size-4" />
									{:else}
										<Maximize class="size-4" />
									{/if}
								</Button>
							{/snippet}
						</Tooltip.Trigger>
						<Tooltip.Content sideOffset={6}
							>{isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}</Tooltip.Content
						>
					</Tooltip.Root>
				</div>
			</div>
		</Tooltip.Provider>
	</div>
</section>

<style>
	.video-preview {
		background: color-mix(in oklab, var(--sidebar) 88%, var(--primary) 4%);
		box-shadow: var(--elevation-inset);
	}

	.video-preview-stage {
		background:
			radial-gradient(
				ellipse at center,
				color-mix(in oklab, var(--surface-monitor-mid) 85%, var(--primary) 15%),
				var(--surface-monitor-deep) 72%
			);
		border-bottom: 1px solid color-mix(in oklab, var(--border) 80%, transparent);
	}

	.video-preview-stage.video-drop-active {
		outline: 1px solid color-mix(in oklab, var(--primary) 55%, transparent);
		outline-offset: -1px;
	}

	.video-preview-frame {
		border: 1px solid color-mix(in oklab, var(--border) 70%, var(--primary) 12%);
		background: var(--surface-monitor);
		box-shadow:
			0 0 0 1px color-mix(in oklab, var(--primary) 10%, transparent),
			0 8px 24px oklch(0.3 0.04 265 / 18%);
	}

	.video-preview-placeholder {
		border: 1px dashed color-mix(in oklab, var(--border) 55%, var(--primary) 20%);
		background: color-mix(in oklab, var(--surface-monitor) 88%, var(--primary) 6%);
	}

	.video-drop-overlay {
		position: absolute;
		inset: 0;
		z-index: 5;
		display: grid;
		place-items: center;
		background: color-mix(in oklab, var(--surface-monitor) 55%, var(--primary) 12%);
		backdrop-filter: blur(2px);
	}

	.video-drop-card {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		border-radius: 0.5rem;
		border: 1px solid color-mix(in oklab, var(--primary) 40%, var(--border));
		background: color-mix(in oklab, var(--card) 88%, transparent);
		padding: 0.65rem 0.9rem;
		font-size: 12px;
		font-weight: 500;
		color: var(--foreground);
		box-shadow: var(--elevation-float);
	}

	.video-picture-layer {
		pointer-events: none;
		position: absolute;
		z-index: 20;
		overflow: hidden;
	}

	.video-subtitle-overlay {
		pointer-events: auto;
		position: absolute;
		z-index: 20;
		display: flex;
		justify-content: center;
		box-sizing: border-box;
		cursor: grab;
		touch-action: none;
		transform: translate(-50%, -50%) translateZ(0);
	}

	/* Lower third: top of box is the handle (grows down — stays under CN/EN hardsubs). */
	.video-subtitle-anchor-bottom {
		transform: translate(-50%, 0) translateZ(0);
	}
	.video-subtitle-anchor-top {
		transform: translate(-50%, 0) translateZ(0);
	}
	.video-subtitle-anchor-middle {
		transform: translate(-50%, -50%) translateZ(0);
	}

	.video-subtitle-selected {
		outline: 1px solid color-mix(in oklab, var(--primary) 80%, white);
		outline-offset: 2px;
		box-shadow: 0 0 0 1px color-mix(in oklab, var(--primary) 35%, transparent);
	}

	.video-subtitle-dragging {
		cursor: grabbing;
	}

	.video-subtitle-text {
		width: 100%;
		max-width: 100%;
		margin: 0;
		text-align: center;
		font-weight: 500;
		/* Tight stack for wrapped Khmer; ≥1.2 keeps coeng / vowel marks from colliding. */
		line-height: 1.22;
		color: white;
		user-select: none;
		/* Browser Khmer line-breaking (export copies these breaks via DOM measure). */
		white-space: normal;
		overflow-wrap: normal;
		word-break: normal;
		line-break: auto;
	}

	/* Beat global `.font-khmer { line-height: 1.65 }` used in script panels. */
	.video-subtitle-text:global(.font-khmer) {
		line-height: 1.22;
		color: white;
		white-space: normal;
		overflow-wrap: normal;
		word-break: normal;
		line-break: auto;
	}

	.video-subtitle-look-box .video-subtitle-text {
		border-radius: 0.4rem;
		background: oklch(0 0 0 / 62%);
		padding: 0.35rem 0.7rem;
		font-weight: 500;
		text-shadow: none;
		-webkit-text-stroke: 0;
		backdrop-filter: blur(2px);
	}

	.video-subtitle-look-outline .video-subtitle-text {
		background: transparent;
		padding: 0.1rem 0.15rem;
		font-weight: 500;
		/* text-shadow set inline from outlineWidth × designScale */
		-webkit-text-stroke: 0;
		paint-order: stroke fill;
	}

	.video-subtitle-handle {
		position: absolute;
		z-index: 2;
		width: 10px;
		height: 10px;
		box-sizing: border-box;
		border: 1px solid color-mix(in oklab, var(--primary) 70%, white);
		background: white;
		box-shadow: 0 0 0 1px color-mix(in oklab, var(--primary) 40%, transparent);
		pointer-events: auto;
		touch-action: none;
	}

	.video-subtitle-handle-nw {
		top: -6px;
		left: -6px;
		cursor: nwse-resize;
	}
	.video-subtitle-handle-ne {
		top: -6px;
		right: -6px;
		cursor: nesw-resize;
	}
	.video-subtitle-handle-sw {
		bottom: -6px;
		left: -6px;
		cursor: nesw-resize;
	}
	.video-subtitle-handle-se {
		bottom: -6px;
		right: -6px;
		cursor: nwse-resize;
	}
	.video-subtitle-handle-w {
		top: 50%;
		left: -6px;
		margin-top: -5px;
		cursor: ew-resize;
	}
	.video-subtitle-handle-e {
		top: 50%;
		right: -6px;
		margin-top: -5px;
		cursor: ew-resize;
	}

	.sync-banner {
		pointer-events: auto;
		position: absolute;
		inset-inline: 0.5rem;
		top: 0.5rem;
		z-index: 30;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		border-radius: 0.45rem;
		border: 1px solid color-mix(in oklab, var(--primary) 35%, var(--border));
		background: color-mix(in oklab, var(--card) 92%, var(--primary));
		padding: 0.45rem 0.55rem;
		box-shadow: var(--elevation-float);
		transform: translateZ(0);
	}

	.sync-banner p {
		margin: 0;
		flex: 1 1 10rem;
		font-size: 0.6875rem;
		line-height: 1.35;
		color: var(--foreground);
	}

	:global(:root:not(.dark)) .video-subtitle-look-box .video-subtitle-text {
		background: oklch(0.18 0.02 265 / 72%);
	}

	.preview-eyebrow {
		color: oklch(0.72 0.02 265);
	}

	.preview-title {
		color: oklch(0.94 0.015 265);
	}

	:global(.dark) .video-preview {
		background: black;
		box-shadow: none;
	}

	:global(.dark) .video-preview-stage {
		background: radial-gradient(
			ellipse at center,
			oklch(0.24 0.06 275) 0%,
			oklch(0.1 0.03 260) 70%
		);
		border-bottom-color: color-mix(in oklab, var(--border) 70%, transparent);
	}

	:global(.dark) .video-preview-frame {
		border-color: transparent;
		border-radius: 0;
		background: transparent;
		box-shadow: none;
	}

	:global(.dark) .video-preview-placeholder {
		border: 1px solid color-mix(in oklab, var(--border) 40%, transparent);
		background: oklch(0 0 0 / 55%);
	}

	:global(.dark) .preview-eyebrow {
		color: var(--muted-foreground);
	}

	:global(.dark) .preview-title {
		color: color-mix(in oklab, var(--foreground) 90%, transparent);
	}
</style>
