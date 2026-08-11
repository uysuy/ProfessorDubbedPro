/** Shared TTS contracts — swap engines without touching studio UI. */

export type TtsEngineId = 'edge-tts' | 'voxcpm';

export type TtsSynthesizeRequest = {
	cueId: string;
	text: string;
	/** App voice profile id (mapped by the engine). */
	voiceId: string;
	/** Cue / panel pitch in semitones (-6..6). */
	pitch: number;
	/** Playback speed multiplier (0.5..2). */
	speed: number;
	/** Volume percent (0..100). */
	volume: number;
	/** Target language code (`km` | `en`). */
	language: string;
	/**
	 * Optional absolute path to a reference WAV for VoxCPM2 voice cloning.
	 * When set, style prompts are suppressed so Khmer script prosody wins.
	 */
	referenceWavPath?: string;
};

export type TtsSynthesizeResult = {
	engine: TtsEngineId;
	/** Absolute filesystem path (Tauri). */
	filePath: string;
	/** Edge / provider voice name used. */
	providerVoice: string;
	byteLength: number;
	/** Audio duration in ms when known (from Rust probe / estimate). */
	durationMs?: number;
};

export interface TtsEngine {
	readonly id: TtsEngineId;
	readonly label: string;
	synthesize(req: TtsSynthesizeRequest): Promise<TtsSynthesizeResult>;
}

export class TtsError extends Error {
	constructor(
		message: string,
		readonly code: 'offline' | 'empty' | 'unsupported' | 'failed' = 'failed'
	) {
		super(message);
		this.name = 'TtsError';
	}
}
