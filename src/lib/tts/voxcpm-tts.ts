import { invoke } from '@tauri-apps/api/core';
import { isTauriRuntime } from '$lib/utils/platform';
import { resolveVoxcpmPrompt, voxcpmVoiceLabel } from '$lib/tts/voxcpm-voices';
import { TtsError, type TtsEngine, type TtsSynthesizeRequest, type TtsSynthesizeResult } from '$lib/tts/types';

type RustResult = {
	filePath: string;
	voice: string;
	byteLength: number;
	engine: string;
	durationMs?: number;
};

function friendlyMessage(raw: string): TtsError {
	const msg = raw.trim() || 'VoxCPM generation failed.';
	const lower = msg.toLowerCase();
	if (lower.includes('out of memory') || lower.includes('cuda') && lower.includes('memory')) {
		return new TtsError(msg, 'failed');
	}
	if (lower.includes('not found') || lower.includes('setup')) {
		return new TtsError(msg, 'unsupported');
	}
	return new TtsError(msg, 'failed');
}

/**
 * Local VoxCPM2 engine (optional). Requires `pnpm voxcpm:setup` + NVIDIA GPU.
 */
export const voxcpmTtsEngine: TtsEngine = {
	id: 'voxcpm',
	label: 'VoxCPM2 (local)',
	async synthesize(req: TtsSynthesizeRequest): Promise<TtsSynthesizeResult> {
		if (!isTauriRuntime()) {
			throw new TtsError(
				'VoxCPM runs in the desktop app only. Start with `pnpm tauri:dev`.',
				'unsupported'
			);
		}
		const text = req.text.trim();
		if (!text) {
			throw new TtsError('Subtitle text is empty — nothing to speak.', 'empty');
		}

		const referenceWavPath = (req.referenceWavPath ?? '').trim();
		const voicePrompt = referenceWavPath ? '' : resolveVoxcpmPrompt(req.voiceId);
		try {
			const result = await invoke<RustResult>('synthesize_voxcpm_speech', {
				args: {
					text,
					cueId: req.cueId,
					voicePrompt,
					referenceWavPath,
					// Clone: balanced CFG so Khmer intonation follows the script.
					// Design-only: slightly stronger to hold the preset timbre.
					cfg: referenceWavPath ? 2.0 : 2.5,
					timesteps: 10
				}
			});
			if (!result.byteLength) {
				throw new TtsError('VoxCPM returned empty audio.', 'empty');
			}
			return {
				engine: 'voxcpm',
				filePath: result.filePath,
				providerVoice: result.voice || voxcpmVoiceLabel(req.voiceId),
				byteLength: result.byteLength,
				durationMs:
					typeof result.durationMs === 'number' && result.durationMs > 0
						? Math.round(result.durationMs)
						: undefined
			};
		} catch (err) {
			if (err instanceof TtsError) throw err;
			const message = err instanceof Error ? err.message : String(err);
			throw friendlyMessage(message);
		}
	}
};
