import type { VoiceProfile } from '$lib/types/project';

/** VoxCPM2 voice-design presets (natural-language prompts). */
export type VoxcpmVoicePreset = VoiceProfile & {
	/** Text inside VoxCPM2 parentheses for voice design. */
	prompt: string;
};

/**
 * Keep control instructions short (VoxCPM cookbook style).
 * Long “Khmer-speaking …” prose is ignored more often than crisp traits.
 */
export const VOXCPM_VOICES: VoxcpmVoicePreset[] = [
	{
		id: 'voxcpm-km-teacher-f',
		name: 'KM Teacher (F)',
		language: 'km',
		style: 'Training',
		gender: 'female',
		type: 'Studio',
		prompt: 'clear warm female teacher, 30s, calm classroom tone, natural pace'
	},
	{
		id: 'voxcpm-km-coach-m',
		name: 'KM Coach (M)',
		language: 'km',
		style: 'Training',
		gender: 'male',
		type: 'Studio',
		prompt: 'confident male trainer, 40s, clear instructional tone, steady pace'
	},
	{
		id: 'voxcpm-km-narrator-f',
		name: 'KM Narrator (F)',
		language: 'km',
		style: 'Narrative',
		gender: 'female',
		type: 'Studio',
		prompt: 'natural female narrator, friendly articulate, moderate pace, clear diction'
	},
	{
		id: 'voxcpm-km-narrator-m',
		name: 'KM Narrator (M)',
		language: 'km',
		style: 'Narrative',
		gender: 'male',
		type: 'Studio',
		prompt: 'natural male narrator, warm articulate, moderate pace, clear diction'
	},
	{
		id: 'voxcpm-km-soft-f',
		name: 'KM Soft (F)',
		language: 'km',
		style: 'Soft',
		gender: 'female',
		type: 'Ready',
		prompt: 'soft gentle female voice, relaxed, slightly slow, warm'
	},
	{
		id: 'voxcpm-km-soft-m',
		name: 'KM Soft (M)',
		language: 'km',
		style: 'Soft',
		gender: 'male',
		type: 'Ready',
		prompt: 'soft gentle male voice, relaxed, slightly slow, warm'
	},
	{
		id: 'voxcpm-km-host-m',
		name: 'KM Host (M)',
		language: 'km',
		style: 'Broadcast',
		gender: 'male',
		type: 'Studio',
		prompt: 'clear male host, mid 30s, bright presentational tone, steady pace'
	},
	{
		id: 'voxcpm-km-host-f',
		name: 'KM Host (F)',
		language: 'km',
		style: 'Broadcast',
		gender: 'female',
		type: 'Studio',
		prompt: 'clear female host, mid 30s, bright presentational tone, steady pace'
	}
];

export const DEFAULT_VOXCPM_VOICE_ID = VOXCPM_VOICES[0]!.id;

export function isVoxcpmVoiceId(id: string): boolean {
	return id.startsWith('voxcpm-') || VOXCPM_VOICES.some((v) => v.id === id);
}

export function resolveVoxcpmPrompt(voiceId: string): string {
	const hit = VOXCPM_VOICES.find((v) => v.id === voiceId);
	return hit?.prompt ?? VOXCPM_VOICES[0]!.prompt;
}

export function resolveVoxcpmVoiceId(preferred: string | null | undefined, fallback?: string): string {
	const a = (preferred ?? '').trim();
	if (isVoxcpmVoiceId(a)) return a;
	const b = (fallback ?? '').trim();
	if (isVoxcpmVoiceId(b)) return b;
	return DEFAULT_VOXCPM_VOICE_ID;
}

/**
 * Keep the same style family when gender changes (Soft F → Soft M).
 * Falls back to the default preset for that gender.
 */
export function matchVoxcpmVoiceToGender(
	voiceId: string | null | undefined,
	gender: 'female' | 'male' | 'neutral'
): string {
	const id = resolveVoxcpmVoiceId(voiceId);
	const current = VOXCPM_VOICES.find((v) => v.id === id);
	if (gender !== 'male' && gender !== 'female') {
		return id;
	}
	if (current?.gender === gender) return current.id;
	if (current) {
		const peer = VOXCPM_VOICES.find((v) => v.style === current.style && v.gender === gender);
		if (peer) return peer.id;
	}
	const fallback =
		gender === 'male'
			? VOXCPM_VOICES.find((v) => v.gender === 'male')
			: VOXCPM_VOICES.find((v) => v.gender === 'female');
	return fallback?.id ?? DEFAULT_VOXCPM_VOICE_ID;
}

/** Presets shown for a speaker gender (neutral → all). */
export function voxcpmVoicesForGender(gender: 'female' | 'male' | 'neutral'): VoxcpmVoicePreset[] {
	if (gender === 'male' || gender === 'female') {
		return VOXCPM_VOICES.filter((v) => v.gender === gender);
	}
	return VOXCPM_VOICES;
}

export function voxcpmVoiceLabel(voiceId: string): string {
	return VOXCPM_VOICES.find((v) => v.id === voiceId)?.name ?? 'VoxCPM2';
}
