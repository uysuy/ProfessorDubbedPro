/**
 * TTS clip mixer using Web Audio (not HTMLAudioElement) so it does not
 * compete with <video> playback in WebView2 / Chromium.
 */

import { cueEffectivePlaybackRate } from '$lib/utils/tts-fit';

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

/** Inclusive play window end — lip-synced clips stay on the video cue; else full audio. */
function playEndMs(cue: TtsPlayableCue): number {
	const fit = cue.assignedAudio?.fitPlaybackRate;
	if (typeof fit === 'number' && fit > 0) {
		return cue.endMs;
	}
	const audioDur = cue.assignedAudio?.durationMs;
	if (typeof audioDur === 'number' && audioDur > 0) {
		return Math.max(cue.endMs, cue.startMs + Math.round(audioDur));
	}
	return cue.endMs;
}

function cueFitRate(cue: TtsPlayableCue): number {
	const fit = cue.assignedAudio?.fitPlaybackRate;
	return typeof fit === 'number' && fit > 0 ? fit : 1;
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
	/** Context time when the current source started. */
	private startedAt = 0;
	/** Offset (sec) into the buffer when the source started. */
	private startOffset = 0;
	/** Effective rate used for the active source (transport × fit). */
	private activeRate = 1;
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
	}

	dispose() {
		this.stopSource();
		this.buffers.clear();
		this.loading.clear();
		if (this.ctx) {
			void this.ctx.close().catch(() => undefined);
			this.ctx = null;
		}
	}

	private startCue(cue: TtsPlayableCue, buffer: AudioBuffer, offsetSec: number, rate: number) {
		this.stopSource();
		const ctx = this.getCtx();
		if (ctx.state === 'suspended') void ctx.resume();

		const gain = ctx.createGain();
		const vol = Math.max(0, Math.min(1, (cue.volume ?? 80) / 100));
		gain.gain.value = vol;
		gain.connect(ctx.destination);

		const source = ctx.createBufferSource();
		source.buffer = buffer;
		const safeRate = Math.max(0.5, Math.min(2.5, rate));
		source.playbackRate.value = safeRate;
		source.connect(gain);

		const safeOffset = Math.max(0, Math.min(Math.max(0, buffer.duration - 0.01), offsetSec));
		try {
			source.start(0, safeOffset);
		} catch {
			gain.disconnect();
			return;
		}

		this.source = source;
		this.gain = gain;
		this.activeId = cue.id;
		this.startedAt = ctx.currentTime;
		this.startOffset = safeOffset;
		this.activeRate = safeRate;

		source.onended = () => {
			if (this.source === source) {
				this.source = null;
				this.gain = null;
				this.activeId = null;
				this.activeRate = 1;
			}
		};
	}

	/**
	 * Keep the active TTS clip aligned with the playhead.
	 * Safe to call every animation frame (no HTMLAudioElement).
	 */
	sync(opts: {
		playheadMs: number;
		isPlaying: boolean;
		cues: TtsPlayableCue[];
		playbackRate?: number;
		/** Prefer this cue when playhead sits on overlapping clips. */
		preferredCueId?: string | null;
	}) {
		const { playheadMs, isPlaying, cues, playbackRate = 1, preferredCueId = null } = opts;

		if (!isPlaying) {
			this.pauseAll();
			return;
		}

		const playable = cues.filter(
			(c) =>
				c.assignedAudio &&
				(c.assignedAudio.url || c.assignedAudio.filePath) &&
				playheadMs >= c.startMs &&
				playheadMs < playEndMs(c)
		);

		const active =
			(preferredCueId ? playable.find((c) => c.id === preferredCueId) : undefined) ??
			playable[0];

		if (!active) {
			this.pauseAll();
			return;
		}

		const url = this.resolveCueUrl(active);
		if (!url) {
			this.pauseAll();
			return;
		}

		const fit = cueFitRate(active);
		// Video time → buffer time: when squeezed, 1s of video advances `fit` seconds of audio.
		const videoOffsetSec = Math.max(0, (playheadMs - active.startMs) / 1000);
		const offsetSec = videoOffsetSec * fit;
		const effectiveRate = cueEffectivePlaybackRate(active, playbackRate);
		const cached = this.buffers.get(active.id);

		if (!cached || cached.url !== url) {
			void this.loadBuffer(active.id, url);
			if (!cached) return;
		}

		const buffer = this.buffers.get(active.id)?.buffer;
		if (!buffer) return;

		const ctx = this.getCtx();
		if (ctx.state === 'suspended') void ctx.resume();

		const needRestart =
			this.activeId !== active.id ||
			!this.source ||
			Math.abs(this.activeRate - effectiveRate) > 0.04 ||
			Math.abs(
				this.startOffset + (ctx.currentTime - this.startedAt) * this.activeRate - offsetSec
			) > 0.22;

		if (needRestart) {
			this.startCue(active, buffer, offsetSec, effectiveRate);
		} else if (this.gain) {
			const vol = Math.max(0, Math.min(1, (active.volume ?? 80) / 100));
			this.gain.gain.value = vol;
		}
	}
}
