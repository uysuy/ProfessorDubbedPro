/**
 * TTS clip mixer using Web Audio (not HTMLAudioElement) so it does not
 * compete with <video> playback in WebView2 / Chromium.
 *
 * After Align, cues store fitPlaybackRate so speech fits the subtitle window.
 * Playback applies that rate once per cue (no mid-clip restarts) so the burned
 * title and audio start/finish together — without syllable chopping from drift
 * re-seeks. When speech ends before the subtitle window, the cue is marked
 * exhausted so sync() does not replay from the start before the next line.
 */

import { cuePreviewEndMs, cueEffectivePlaybackRate, TTS_ALIGN_MAX_PLAYBACK } from '$lib/utils/tts-fit';

export type TtsPlayableCue = {
	id: string;
	startMs: number;
	endMs: number;
	volume?: number;
	assignedAudio?: {
		url?: string | null;
		filePath?: string | null;
		durationMs?: number | null;
		fitPlaybackRate?: number | null;
	} | null;
};

function hasAudio(cue: TtsPlayableCue): boolean {
	return !!(cue.assignedAudio && (cue.assignedAudio.url || cue.assignedAudio.filePath));
}

function cueFitRate(cue: TtsPlayableCue): number {
	const fit = cue.assignedAudio?.fitPlaybackRate;
	return typeof fit === 'number' && fit > 0 ? fit : 1;
}

/** Subtitle period on the timeline — TTS never plays past this. */
function cueWindowEndMs(cue: TtsPlayableCue): number {
	return cuePreviewEndMs(cue);
}

type ClipBuffer = {
	url: string;
	buffer: AudioBuffer;
};

export class TtsPlaybackMixer {
	private ctx: AudioContext | null = null;
	private buffers = new Map<string, ClipBuffer>();
	private loading = new Map<string, Promise<AudioBuffer | null>>();
	private source: AudioBufferSourceNode | null = null;
	private gain: GainNode | null = null;
	private activeId: string | null = null;
	private activeRate = 1;
	private lastPlayheadMs = -1;
	/**
	 * Cue whose buffer finished naturally while the playhead was still in its
	 * subtitle window. Without this, sync() would restart that clip from 0
	 * (audible “replay then jump”) until the next cue starts.
	 */
	private exhaustedId: string | null = null;
	private resolveUrl: ((filePath: string) => string | null) | null = null;

	get playingCueId(): string | null {
		return this.activeId;
	}

	setUrlResolver(fn: ((filePath: string) => string | null) | null) {
		this.resolveUrl = fn;
	}

	private getCtx(): AudioContext {
		if (!this.ctx) {
			const Ctor =
				window.AudioContext ||
				(window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
			this.ctx = new Ctor();
		}
		return this.ctx;
	}

	private resolveCueUrl(cue: TtsPlayableCue): string | null {
		const a = cue.assignedAudio;
		if (!a) return null;
		if (a.url) return a.url;
		if (a.filePath && this.resolveUrl) return this.resolveUrl(a.filePath);
		return null;
	}

	private async loadBuffer(cueId: string, url: string): Promise<AudioBuffer | null> {
		const existing = this.buffers.get(cueId);
		if (existing && existing.url === url) return existing.buffer;

		const inflight = this.loading.get(cueId);
		if (inflight) return inflight;

		const task = (async () => {
			try {
				const res = await fetch(url);
				if (!res.ok) return null;
				const raw = await res.arrayBuffer();
				const ctx = this.getCtx();
				const buffer = await ctx.decodeAudioData(raw.slice(0));
				this.buffers.set(cueId, { url, buffer });
				return buffer;
			} catch {
				return null;
			} finally {
				this.loading.delete(cueId);
			}
		})();

		this.loading.set(cueId, task);
		return task;
	}

	/** Drop a cached buffer after regenerating TTS for a cue. */
	invalidate(cueId: string) {
		this.buffers.delete(cueId);
		if (this.exhaustedId === cueId) this.exhaustedId = null;
		if (this.activeId === cueId) this.stopSource();
	}

	/** Prefetch decoded buffers so the first hit is instant. */
	warmup(cues: TtsPlayableCue[]) {
		for (const cue of cues) {
			const url = this.resolveCueUrl(cue);
			if (!url) continue;
			void this.loadBuffer(cue.id, url);
		}
	}

	private stopSource() {
		if (this.source) {
			try {
				this.source.onended = null;
				this.source.stop();
			} catch {
				/* already stopped */
			}
			try {
				this.source.disconnect();
			} catch {
				/* ignore */
			}
			this.source = null;
		}
		if (this.gain) {
			try {
				this.gain.disconnect();
			} catch {
				/* ignore */
			}
			this.gain = null;
		}
		this.activeId = null;
		this.activeRate = 1;
	}

	pauseAll() {
		this.stopSource();
		this.lastPlayheadMs = -1;
		this.exhaustedId = null;
	}

	dispose() {
		this.stopSource();
		this.buffers.clear();
		this.loading.clear();
		this.lastPlayheadMs = -1;
		this.exhaustedId = null;
		if (this.ctx) {
			void this.ctx.close().catch(() => undefined);
			this.ctx = null;
		}
	}

	private startCue(
		cue: TtsPlayableCue,
		buffer: AudioBuffer,
		offsetSec: number,
		rate: number,
		/** Real-time seconds left in the subtitle window (clip so audio cannot bleed). */
		remainWindowSec?: number
	) {
		this.stopSource();
		const ctx = this.getCtx();
		if (ctx.state === 'suspended') void ctx.resume();

		const gain = ctx.createGain();
		const vol = Math.max(0, Math.min(1, (cue.volume ?? 80) / 100));
		gain.gain.value = vol;
		gain.connect(ctx.destination);

		const source = ctx.createBufferSource();
		source.buffer = buffer;
		// Align fit × transport — keep audio length matched to subtitle window.
		const safeRate = Math.max(0.85, Math.min(TTS_ALIGN_MAX_PLAYBACK, rate));
		source.playbackRate.value = safeRate;
		source.connect(gain);

		const safeOffset = Math.max(0, Math.min(Math.max(0, buffer.duration - 0.02), offsetSec));
		const bufferLeft = Math.max(0.02, buffer.duration - safeOffset);
		// Prefer the full decoded clip so long Khmer lines are not cut mid-word.
		// Soft-cap only when the remaining subtitle window is clearly shorter.
		let playDur = bufferLeft;
		if (typeof remainWindowSec === 'number' && remainWindowSec > 0) {
			const windowBuf = Math.max(0.02, remainWindowSec * safeRate);
			// Allow ~120ms slop so rounding / waveform probe never chops the tail.
			if (windowBuf + 0.12 < bufferLeft) {
				playDur = windowBuf;
			}
		}
		try {
			source.start(0, safeOffset, playDur);
		} catch {
			gain.disconnect();
			return;
		}

		this.source = source;
		this.gain = gain;
		this.activeId = cue.id;
		this.activeRate = safeRate;
		if (this.exhaustedId === cue.id) this.exhaustedId = null;

		source.onended = () => {
			if (this.source !== source) return;
			// Natural end — remember so we do not re-attack from sample 0.
			this.exhaustedId = cue.id;
			this.source = null;
			this.gain = null;
			this.activeId = null;
			this.activeRate = 1;
		};
	}

	private pickCue(
		cues: TtsPlayableCue[],
		playheadMs: number,
		preferredCueId: string | null
	): TtsPlayableCue | null {
		const candidates = cues.filter(
			(c) => hasAudio(c) && playheadMs >= c.startMs && playheadMs < cueWindowEndMs(c)
		);
		if (!candidates.length) {
			const upcoming = cues
				.filter((c) => hasAudio(c) && c.startMs >= playheadMs && c.startMs <= playheadMs + 80)
				.sort((a, b) => a.startMs - b.startMs)[0];
			return upcoming ?? null;
		}
		if (preferredCueId) {
			const hit = candidates.find((c) => c.id === preferredCueId);
			if (hit) return hit;
		}
		return [...candidates].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)[0] ?? null;
	}

	/**
	 * Drive TTS from the video playhead. Safe every animation frame.
	 * Starts once per cue at Align rate — no drift re-seeks (no syllable chop).
	 */
	sync(opts: {
		playheadMs: number;
		isPlaying: boolean;
		cues: TtsPlayableCue[];
		playbackRate?: number;
		preferredCueId?: string | null;
	}) {
		const { playheadMs, isPlaying, cues, playbackRate = 1, preferredCueId = null } = opts;

		if (!isPlaying) {
			this.pauseAll();
			return;
		}

		const prev = this.lastPlayheadMs;
		const seekJump = prev >= 0 && (playheadMs - prev > 450 || playheadMs - prev < -120);
		this.lastPlayheadMs = playheadMs;

		if (seekJump) {
			this.exhaustedId = null;
		} else if (this.exhaustedId) {
			const done = cues.find((c) => c.id === this.exhaustedId);
			const stillInExhausted =
				done &&
				playheadMs >= done.startMs - 40 &&
				playheadMs < cueWindowEndMs(done) + 80;
			if (!stillInExhausted) this.exhaustedId = null;
		}

		// Play-through lock: keep one line going, but stop when playhead left the window
		// (seek / next cue) and keep transport × fit rate live so picture ↔ TTS stay matched.
		if (this.source && this.activeId && !seekJump) {
			const live = cues.find((c) => c.id === this.activeId);
			const stillInWindow =
				live &&
				playheadMs >= live.startMs - 40 &&
				playheadMs < cueWindowEndMs(live) + 80;
			if (stillInWindow && live) {
				if (this.gain) {
					this.gain.gain.value = Math.max(0, Math.min(1, (live.volume ?? 80) / 100));
				}
				const wantRate = cueEffectivePlaybackRate(live, playbackRate);
				const safeRate = Math.max(0.85, Math.min(TTS_ALIGN_MAX_PLAYBACK, wantRate));
				if (Math.abs(safeRate - this.activeRate) > 0.02) {
					try {
						this.source.playbackRate.value = safeRate;
						this.activeRate = safeRate;
					} catch {
						/* ignore */
					}
				}
				return;
			}
			this.stopSource();
		}

		const cue = this.pickCue(cues, playheadMs, preferredCueId);
		if (!cue) {
			// Do not pauseAll() here — that resets lastPlayheadMs and can make the
			// next line look like a cold start after a short gap.
			if (!(this.source && this.activeId && !seekJump)) this.stopSource();
			return;
		}

		// Speech already finished for this cue — stay silent until the next line / seek.
		if (this.exhaustedId === cue.id && !seekJump) {
			return;
		}

		if (this.activeId === cue.id && this.source && !seekJump) {
			if (this.gain) {
				this.gain.gain.value = Math.max(0, Math.min(1, (cue.volume ?? 80) / 100));
			}
			const wantRate = cueEffectivePlaybackRate(cue, playbackRate);
			const safeRate = Math.max(0.85, Math.min(TTS_ALIGN_MAX_PLAYBACK, wantRate));
			if (this.source && Math.abs(safeRate - this.activeRate) > 0.02) {
				try {
					this.source.playbackRate.value = safeRate;
					this.activeRate = safeRate;
				} catch {
					/* ignore */
				}
			}
			return;
		}

		// Wait for current line to finish before starting the next (unless seek).
		if (this.source && this.activeId && this.activeId !== cue.id && !seekJump) {
			return;
		}

		const url = this.resolveCueUrl(cue);
		if (!url) {
			this.stopSource();
			return;
		}

		const cached = this.buffers.get(cue.id);
		if (!cached || cached.url !== url) {
			void this.loadBuffer(cue.id, url);
			if (!cached) return;
		}
		const buffer = this.buffers.get(cue.id)?.buffer;
		if (!buffer) return;

		const fit = cueFitRate(cue);
		const rate = cueEffectivePlaybackRate(cue, playbackRate);

		// Seek: map video time → buffer time with fit. Fresh cue enter: start at 0.
		const nearStart = playheadMs <= cue.startMs + 280;
		const offsetSec =
			seekJump && !nearStart
				? Math.max(0, ((playheadMs - cue.startMs) / 1000) * fit)
				: 0;

		// Mid-window seek into an already-finished buffer → stay silent.
		if (seekJump && !nearStart && offsetSec >= buffer.duration - 0.03) {
			this.exhaustedId = cue.id;
			this.stopSource();
			return;
		}

		const remainWindowSec = Math.max(0.05, (cueWindowEndMs(cue) - playheadMs) / 1000);
		this.startCue(cue, buffer, offsetSec, rate, remainWindowSec);
	}
}
