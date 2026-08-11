import { edgeTtsEngine } from '$lib/tts/edge-tts';
import { voxcpmTtsEngine } from '$lib/tts/voxcpm-tts';
import type { TtsEngine, TtsEngineId } from '$lib/tts/types';

export type { TtsEngine, TtsEngineId } from '$lib/tts/types';
export { TtsError } from '$lib/tts/types';

const engines: Record<TtsEngineId, TtsEngine> = {
	'edge-tts': edgeTtsEngine,
	voxcpm: voxcpmTtsEngine
};

let activeId: TtsEngineId = 'edge-tts';

/** Active TTS engine — swap here (or via `setTtsEngine`) when adding providers. */
export function getTtsEngine(): TtsEngine {
	return engines[activeId] ?? edgeTtsEngine;
}

export function getTtsEngineId(): TtsEngineId {
	return activeId;
}

export function setTtsEngine(id: TtsEngineId) {
	if (engines[id]) activeId = id;
}

export function listTtsEngines(): TtsEngine[] {
	return Object.values(engines);
}

export function isTtsEngineId(v: unknown): v is TtsEngineId {
	return v === 'edge-tts' || v === 'voxcpm';
}
