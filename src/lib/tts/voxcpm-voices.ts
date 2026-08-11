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
		id: 'voxcpm-km-narrator-f',
		name: 'KM Narrator (F)',
		language: 'km',
		style: 'Narrative',
		gender: 'female',
		type: 'Studio',
		prompt: 'natural female narrator, friendly articulate, moderate pace, clear diction'
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
		id: 'voxcpm-km-soft-f',
		name: 'KM Soft (F)',
		language: 'km',
		style: 'Soft',
		gender: 'female',
		type: 'Ready',
		prompt: 'soft gentle female voice, relaxed, slightly slow, warm'
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

export function voxcpmVoiceLabel(voiceId: string): string {
	return VOXCPM_VOICES.find((v) => v.id === voiceId)?.name ?? 'VoxCPM2';
}
