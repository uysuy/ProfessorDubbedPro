import { invoke } from '@tauri-apps/api/core';
import type { VoiceProfile } from '$lib/types/project';
import { isTauriRuntime } from '$lib/utils/platform';

export type EdgeVoiceDto = {
	shortName: string;
	name: string;
	friendlyName: string;
	gender: string;
	locale: string;
	status: string;
};

/** Offline / first-paint Khmer voices (known Microsoft Edge Read Aloud). */
export const FALLBACK_KHMER_VOICES: VoiceProfile[] = [
	{
		id: 'km-KH-SreymomNeural',
		name: 'Sreymom',
		language: 'km',
		style: 'Neural',
		gender: 'female',
		type: 'Neural',
		edgeVoiceKm: 'km-KH-SreymomNeural',
		edgeVoiceEn: 'km-KH-SreymomNeural'
	},
	{
		id: 'km-KH-PisethNeural',
		name: 'Piseth',
		language: 'km',
		style: 'Neural',
		gender: 'male',
		type: 'Neural',
		edgeVoiceKm: 'km-KH-PisethNeural',
		edgeVoiceEn: 'km-KH-PisethNeural'
	}
];

/** Map old studio profile ids → Edge short names. */
export const LEGACY_VOICE_ID_MAP: Record<string, string> = {
	'voice-aria': 'km-KH-SreymomNeural',
	'voice-sokha': 'km-KH-SreymomNeural',
	'voice-vireak': 'km-KH-PisethNeural',
	'voice-dara': 'km-KH-PisethNeural',
	'voice-maya': 'km-KH-SreymomNeural',
	'voice-nova': 'km-KH-PisethNeural'
};

export const DEFAULT_EDGE_VOICE_ID = 'km-KH-SreymomNeural';

export function migrateVoiceId(id: string | null | undefined): string {
	const raw = (id ?? '').trim();
	if (!raw) return DEFAULT_EDGE_VOICE_ID;
	return LEGACY_VOICE_ID_MAP[raw] ?? raw;
}

function parseGender(raw: string): VoiceProfile['gender'] {
	const g = raw.trim().toLowerCase();
	if (g.startsWith('f')) return 'female';
	if (g.startsWith('m')) return 'male';
	return 'neutral';
}

function localeToLang(locale: string): string {
	const l = locale.trim().toLowerCase();
	if (l.startsWith('en')) return 'en';
	if (l.startsWith('km')) return 'km';
	return l.slice(0, 2) || 'km';
}

export function edgeVoiceToProfile(v: EdgeVoiceDto): VoiceProfile {
	const short = v.shortName.trim();
	const lang = localeToLang(v.locale || short);
	return {
		id: short,
		name: v.name.trim() || short,
		language: lang,
		style: 'Edge TTS',
		gender: parseGender(v.gender),
		type: short.toLowerCase().includes('neural') ? 'Neural' : 'Ready',
		edgeVoiceKm: lang === 'km' ? short : undefined,
		edgeVoiceEn: lang === 'en' ? short : short
	};
}

export async function fetchEdgeVoices(localePrefix = 'km'): Promise<VoiceProfile[]> {
	if (!isTauriRuntime()) {
		return FALLBACK_KHMER_VOICES;
	}
	const list = await invoke<EdgeVoiceDto[]>('list_edge_voices', {
		args: { localePrefix }
	});
	const profiles = list.map(edgeVoiceToProfile).filter((v) => v.id);
	return profiles.length ? profiles : FALLBACK_KHMER_VOICES;
}
