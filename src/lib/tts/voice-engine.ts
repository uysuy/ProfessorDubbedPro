import type { TtsEngineId } from '$lib/tts/types';
import {
	DEFAULT_EDGE_VOICE_ID,
	FALLBACK_KHMER_VOICES,
	migrateVoiceId
} from '$lib/tts/edge-voices';
import {
	DEFAULT_VOXCPM_VOICE_ID,
	VOXCPM_VOICES,
	isVoxcpmVoiceId
} from '$lib/tts/voxcpm-voices';
import type { VoiceProfile } from '$lib/types/project';

export type VoiceGender = VoiceProfile['gender'];

/** Edge voice for a speaker gender (Sreymom / Piseth). */
export function edgeVoiceIdForGender(gender: VoiceGender | string): string {
	const g = String(gender ?? '').trim().toLowerCase();
	if (g === 'male') return 'km-KH-PisethNeural';
	return DEFAULT_EDGE_VOICE_ID; // Sreymom for female / neutral
}

/** VoxCPM preset for a speaker gender. */
export function voxcpmVoiceIdForGender(gender: VoiceGender | string): string {
	const g = String(gender ?? '').trim().toLowerCase();
	if (g === 'male') return 'voxcpm-km-coach-m';
	if (g === 'female') return 'voxcpm-km-teacher-f';
	return DEFAULT_VOXCPM_VOICE_ID;
}

export function voiceIdForEngineGender(
	engine: TtsEngineId,
	gender: VoiceGender | string
): string {
	return engine === 'voxcpm' ? voxcpmVoiceIdForGender(gender) : edgeVoiceIdForGender(gender);
}

/** Infer gender from a stored voice id (Edge or VoxCPM). */
export function genderFromVoiceId(voiceId: string | null | undefined): VoiceGender {
	const id = migrateVoiceId(voiceId);
	if (isVoxcpmVoiceId(id)) {
		return VOXCPM_VOICES.find((v) => v.id === id)?.gender ?? 'neutral';
	}
	const edge = FALLBACK_KHMER_VOICES.find((v) => v.id === id);
	if (edge) return edge.gender;
	const lower = id.toLowerCase();
	if (lower.includes('piseth') || lower.includes('-m-') || lower.includes('male')) {
		return 'male';
	}
	if (lower.includes('sreymom') || lower.includes('female') || lower.includes('-f-')) {
		return 'female';
	}
	return 'neutral';
}

/** True when `voiceId` belongs to the active TTS engine family. */
export function voiceMatchesEngine(voiceId: string | null | undefined, engine: TtsEngineId): boolean {
	const id = (voiceId ?? '').trim();
	if (!id) return false;
	if (engine === 'voxcpm') return isVoxcpmVoiceId(id);
	return !isVoxcpmVoiceId(id);
}

/**
 * Map a cue/session voice onto the selected engine, preserving gender
 * (e.g. Piseth → KM Coach, Sreymom → KM Teacher, and back).
 */
export function mapVoiceIdToEngine(
	voiceId: string | null | undefined,
	engine: TtsEngineId,
	genderHint?: VoiceGender | string | null
): string {
	const gender =
		(genderHint && String(genderHint).trim()) || genderFromVoiceId(voiceId);
	if (voiceMatchesEngine(voiceId, engine)) {
		// Already on this engine — still normalize empty/legacy ids.
		if (engine === 'edge-tts') return migrateVoiceId(voiceId);
		if (isVoxcpmVoiceId(voiceId ?? '')) return (voiceId ?? '').trim();
	}
	return voiceIdForEngineGender(engine, gender);
}

/** Voices shown in cue / sidebar pickers for the active engine. */
export function voicesForEngine(engine: TtsEngineId, edgeVoices: VoiceProfile[]): VoiceProfile[] {
	if (engine === 'voxcpm') return VOXCPM_VOICES;
	return edgeVoices.length ? edgeVoices : FALLBACK_KHMER_VOICES;
}
