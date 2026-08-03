import { edgeTtsEngine } from '$lib/tts/edge-tts';
import type { TtsEngine, TtsEngineId } from '$lib/tts/types';

const engines: Record<TtsEngineId, TtsEngine> = {
	'edge-tts': edgeTtsEngine
};

let activeId: TtsEngineId = 'edge-tts';

/** Active TTS engine — swap here (or via `setTtsEngine`) when adding providers. */
export function getTtsEngine(): TtsEngine {
	return engines[activeId];
}

export function setTtsEngine(id: TtsEngineId) {
	if (engines[id]) activeId = id;
}

export function listTtsEngines(): TtsEngine[] {
	return Object.values(engines);
}
