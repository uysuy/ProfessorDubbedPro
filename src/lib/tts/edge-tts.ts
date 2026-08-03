import { invoke } from '@tauri-apps/api/core';
import { isTauriRuntime } from '$lib/utils/platform';
import { migrateVoiceId, DEFAULT_EDGE_VOICE_ID } from '$lib/tts/edge-voices';
import { TtsError, type TtsEngine, type TtsSynthesizeRequest, type TtsSynthesizeResult } from '$lib/tts/types';
import { textContainsKhmer } from '$lib/tts/edge-tts-script';

/** Legacy studio profile id → Edge short names (for old projects). */
const LEGACY_EDGE_VOICE: Record<string, { km: string; en: string }> = {
	'voice-aria': { km: 'km-KH-SreymomNeural', en: 'en-US-AriaNeural' },
	'voice-sokha': { km: 'km-KH-SreymomNeural', en: 'en-US-JennyNeural' },
	'voice-vireak': { km: 'km-KH-PisethNeural', en: 'en-US-GuyNeural' },
	'voice-dara': { km: 'km-KH-PisethNeural', en: 'en-US-DavisNeural' },
	'voice-maya': { km: 'km-KH-SreymomNeural', en: 'en-US-AvaNeural' },
	'voice-nova': { km: 'km-KH-PisethNeural', en: 'en-US-AndrewNeural' }
};

const FALLBACK = { km: 'km-KH-SreymomNeural', en: 'en-US-AriaNeural' };

export { textContainsKhmer } from '$lib/tts/edge-tts-script';

/**
 * Resolve to an Edge short voice name.
 * Prefer the selected id when it is already an Edge short name (`km-KH-…` / `en-…`).
 * Khmer Unicode in the text always forces a Khmer voice.
 */
export function resolveEdgeVoice(voiceId: string, language: string, text = ''): string {
	const migrated = migrateVoiceId(voiceId);
	const forceKm = textContainsKhmer(text);
	const wantEn = !forceKm && language.toLowerCase().startsWith('en');

	// Direct Edge short name (current Voice Selection ids).
	if (/^[a-z]{2}-[A-Z]{2}-/i.test(migrated) || /^[a-z]{2}-[a-z]{2}-/i.test(migrated)) {
		if (forceKm && !migrated.toLowerCase().startsWith('km')) {
			return FALLBACK.km;
		}
		if (wantEn && migrated.toLowerCase().startsWith('km')) {
			// Khmer voice can still speak English — keep selection.
			return migrated;
		}
		return migrated;
	}

	const legacy = LEGACY_EDGE_VOICE[voiceId] ?? LEGACY_EDGE_VOICE[migrated];
	if (legacy) return forceKm || !wantEn ? legacy.km : legacy.en;

	return wantEn ? FALLBACK.en : FALLBACK.km;
}

/** Convert studio pitch (semitones) to Edge SSML Hz offset. */
export function pitchToEdgeHz(semitones: number): number {
	return Math.round(Math.max(-6, Math.min(6, semitones)) * 12);
}

/** Convert speed multiplier to Edge rate % offset (−50% … +100%). */
export function speedToEdgeRate(speed: number): number {
	return Math.round((Math.max(0.5, Math.min(2, speed)) - 1) * 100);
}

/** Convert 0–100 volume to Edge volume % offset (100 → 0). */
export function volumeToEdgePercent(volume: number): number {
	return Math.round(Math.max(0, Math.min(100, volume)) - 100);
}

type RustResult = {
	filePath: string;
	voice: string;
	byteLength: number;
	engine: string;
};

function friendlyMessage(raw: string): TtsError {
	const msg = raw.trim() || 'TTS generation failed.';
	const lower = msg.toLowerCase();
	if (
		lower.includes('no internet') ||
		lower.includes('network') ||
		lower.includes('offline') ||
		lower.includes('dns')
	) {
		return new TtsError(msg, 'offline');
	}
	if (lower.includes('empty')) return new TtsError(msg, 'empty');
	return new TtsError(msg, 'failed');
}

/**
 * Microsoft Edge Read Aloud engine (Rust `msedge-tts` via Tauri).
 */
export const edgeTtsEngine: TtsEngine = {
	id: 'edge-tts',
	label: 'Edge TTS',
	async synthesize(req: TtsSynthesizeRequest): Promise<TtsSynthesizeResult> {
		if (!isTauriRuntime()) {
			throw new TtsError(
				'Edge-TTS runs in the desktop app only. Start with `pnpm tauri:dev`.',
				'unsupported'
			);
		}
		const text = req.text.trim();
		if (!text) {
			throw new TtsError('Subtitle text is empty — nothing to speak.', 'empty');
		}

		const voice = resolveEdgeVoice(req.voiceId, req.language, text);
		try {
			const result = await invoke<RustResult>('synthesize_speech', {
				args: {
					text,
					voice,
					cueId: req.cueId,
					pitchHz: pitchToEdgeHz(req.pitch),
					ratePercent: speedToEdgeRate(req.speed),
					volumePercent: volumeToEdgePercent(req.volume)
				}
			});
			if (!result.byteLength) {
				throw new TtsError(
					textContainsKhmer(text)
						? 'Edge-TTS returned empty audio for this Khmer text. Try again, or switch voice.'
						: 'Edge-TTS returned empty audio. Check that text and voice language match.',
					'empty'
				);
			}
			return {
				engine: 'edge-tts',
				filePath: result.filePath,
				providerVoice: result.voice || voice || DEFAULT_EDGE_VOICE_ID,
				byteLength: result.byteLength
			};
		} catch (err) {
			if (err instanceof TtsError) throw err;
			const message = err instanceof Error ? err.message : String(err);
			throw friendlyMessage(message);
		}
	}
};
