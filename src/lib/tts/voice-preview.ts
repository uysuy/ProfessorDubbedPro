/**
 * Preview a voice with a short sample via Web Audio
 * (avoids fighting the program <video>).
 * Edge TTS = online sample; VoxCPM2 = local GPU sample (model must be started).
 */

import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { isTauriRuntime } from '$lib/utils/platform';
import { pitchToEdgeHz, speedToEdgeRate, volumeToEdgePercent } from '$lib/tts/edge-tts';
import { migrateVoiceId } from '$lib/tts/edge-voices';
import { isVoxcpmVoiceId, resolveVoxcpmPrompt } from '$lib/tts/voxcpm-voices';

const PREVIEW_KM = 'សួស្តី ខ្ញុំជាសំឡេងសាកល្បង។';
const PREVIEW_EN = 'Hello, this is a voice preview.';

type RustResult = {
	filePath: string;
	voice: string;
	byteLength: number;
	engine: string;
};

let ctx: AudioContext | null = null;
let source: AudioBufferSourceNode | null = null;
let gain: GainNode | null = null;
let activeVoiceId: string | null = null;
let generation = 0;

function getCtx(): AudioContext {
	if (!ctx) {
		const Ctor =
			window.AudioContext ||
			(window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
		ctx = new Ctor();
	}
	return ctx;
}

export function stopVoicePreview() {
	generation += 1;
	if (source) {
		try {
			source.stop();
		} catch {
			/* already stopped */
		}
		try {
			source.disconnect();
		} catch {
			/* ignore */
		}
		source = null;
	}
	if (gain) {
		try {
			gain.disconnect();
		} catch {
			/* ignore */
		}
		gain = null;
	}
	activeVoiceId = null;
}

export function isPreviewingVoice(id: string): boolean {
	return activeVoiceId === id;
}

export function getPreviewingVoiceId(): string | null {
	return activeVoiceId;
}

async function playPreviewFile(
	filePath: string,
	byteLength: number,
	token: number,
	opts?: { onStart?: () => void; onEnd?: () => void }
): Promise<void> {
	if (!byteLength) {
		throw new Error('Preview returned empty audio.');
	}

	const url = convertFileSrc(filePath);
	const res = await fetch(url);
	if (!res.ok) throw new Error('Could not load preview audio.');
	const raw = await res.arrayBuffer();
	if (token !== generation) return;

	const audioCtx = getCtx();
	if (audioCtx.state === 'suspended') await audioCtx.resume();
	const buffer = await audioCtx.decodeAudioData(raw.slice(0));
	if (token !== generation) return;

	const g = audioCtx.createGain();
	g.gain.value = 0.9;
	g.connect(audioCtx.destination);

	const src = audioCtx.createBufferSource();
	src.buffer = buffer;
	src.connect(g);
	src.onended = () => {
		if (token !== generation) return;
		source = null;
		gain = null;
		activeVoiceId = null;
		opts?.onEnd?.();
	};

	source = src;
	gain = g;
	opts?.onStart?.();
	src.start(0);
}

/**
 * Synthesize a short sample for `voiceId` (Edge short name) and play it.
 * Returns when playback finishes or is stopped.
 */
export async function previewEdgeVoice(
	voiceId: string,
	opts?: { language?: string; onStart?: () => void; onEnd?: () => void }
): Promise<void> {
	const id = migrateVoiceId(voiceId);
	if (activeVoiceId === id) {
		stopVoicePreview();
		opts?.onEnd?.();
		return;
	}

	stopVoicePreview();
	const token = ++generation;
	activeVoiceId = id;

	try {
		if (!isTauriRuntime()) {
			throw new Error('Voice preview requires the desktop app (`pnpm tauri:dev`).');
		}

		const lang = (opts?.language ?? (id.toLowerCase().startsWith('en') ? 'en' : 'km')).toLowerCase();
		const text = lang.startsWith('en') ? PREVIEW_EN : PREVIEW_KM;

		const result = await invoke<RustResult>('synthesize_speech', {
			args: {
				text,
				voice: id,
				cueId: `preview-${id}`,
				pitchHz: pitchToEdgeHz(0),
				ratePercent: speedToEdgeRate(1),
				volumePercent: volumeToEdgePercent(100)
			}
		});

		if (token !== generation) return;
		await playPreviewFile(result.filePath, result.byteLength, token, opts);
	} catch (err) {
		if (token === generation) {
			activeVoiceId = null;
			opts?.onEnd?.();
		}
		throw err;
	}
}

/**
 * Short VoxCPM2 design-voice sample (no speaker clone ref).
 * Requires the VoxCPM server/model to be started first.
 */
export async function previewVoxcpmVoice(
	voiceId: string,
	opts?: { onStart?: () => void; onEnd?: () => void }
): Promise<void> {
	const id = voiceId.trim();
	if (!isVoxcpmVoiceId(id)) {
		throw new Error('Not a VoxCPM2 voice id.');
	}
	if (activeVoiceId === id) {
		stopVoicePreview();
		opts?.onEnd?.();
		return;
	}

	stopVoicePreview();
	const token = ++generation;
	activeVoiceId = id;

	try {
		if (!isTauriRuntime()) {
			throw new Error('Voice preview requires the desktop app (`pnpm tauri:dev`).');
		}

		const result = await invoke<RustResult>('synthesize_voxcpm_speech', {
			args: {
				text: PREVIEW_KM,
				cueId: `preview-${id}`,
				voicePrompt: resolveVoxcpmPrompt(id),
				referenceWavPath: '',
				cfg: 2.5,
				timesteps: 10
			}
		});

		if (token !== generation) return;
		await playPreviewFile(result.filePath, result.byteLength, token, opts);
	} catch (err) {
		if (token === generation) {
			activeVoiceId = null;
			opts?.onEnd?.();
		}
		throw err;
	}
}

/** Preview Edge or VoxCPM2 based on voice id. */
export async function previewVoice(
	voiceId: string,
	opts?: { language?: string; onStart?: () => void; onEnd?: () => void }
): Promise<void> {
	if (isVoxcpmVoiceId(voiceId)) {
		return previewVoxcpmVoice(voiceId, opts);
	}
	return previewEdgeVoice(voiceId, opts);
}
