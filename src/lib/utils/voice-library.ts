/**
 * Saved / “loved” voices library — app-global favorites with WAV clone refs.
 * Survives New project and app restart. Independent of the current project bank.
 */

import type { SpeakerVoiceProfile } from '$lib/types/project';

const LIBRARY_KEY = 'pdp.savedVoices.v1';

export type SavedVoice = {
	id: string;
	/** Display name the user can recognize later. */
	name: string;
	gender: SpeakerVoiceProfile['gender'];
	voiceId: string;
	/** Absolute path to the locked clone WAV (app voice-library). */
	refWavPath: string;
	updatedAt: string;
};

function canUseStorage(): boolean {
	return typeof localStorage !== 'undefined';
}

function uid(prefix = 'voice'): string {
	return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function loadSavedVoices(): SavedVoice[] {
	if (!canUseStorage()) return [];
	try {
		const raw = localStorage.getItem(LIBRARY_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed
			.map((row): SavedVoice | null => {
				if (!row || typeof row !== 'object') return null;
				const o = row as Record<string, unknown>;
				const id = typeof o.id === 'string' ? o.id.trim() : '';
				const name = typeof o.name === 'string' ? o.name.trim() : '';
				const voiceId = typeof o.voiceId === 'string' ? o.voiceId.trim() : '';
				const refWavPath = typeof o.refWavPath === 'string' ? o.refWavPath.trim() : '';
				if (!id || !name || !voiceId || !refWavPath) return null;
				const gender =
					o.gender === 'male' || o.gender === 'female' || o.gender === 'neutral'
						? o.gender
						: 'neutral';
				const updatedAt =
					typeof o.updatedAt === 'string' && o.updatedAt
						? o.updatedAt
						: new Date().toISOString();
				return { id, name, gender, voiceId, refWavPath, updatedAt };
			})
			.filter((x): x is SavedVoice => x != null)
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	} catch {
		return [];
	}
}

export function saveSavedVoices(list: SavedVoice[]): void {
	if (!canUseStorage()) return;
	try {
		localStorage.setItem(LIBRARY_KEY, JSON.stringify(list));
	} catch {
		/* ignore */
	}
}

/**
 * Upsert a loved voice. Same name+voiceId replaces the previous entry
 * so re-locking updates the WAV path.
 */
export function upsertSavedVoice(input: {
	name: string;
	gender: SpeakerVoiceProfile['gender'];
	voiceId: string;
	refWavPath: string;
	/** Prefer updating this id when re-locking the same favorite. */
	id?: string;
}): SavedVoice {
	const name = input.name.trim() || 'Saved voice';
	const voiceId = input.voiceId.trim();
	const refWavPath = input.refWavPath.trim();
	const list = loadSavedVoices();
	const now = new Date().toISOString();

	let idx = -1;
	if (input.id) {
		idx = list.findIndex((v) => v.id === input.id);
	}
	if (idx < 0) {
		idx = list.findIndex(
			(v) =>
				v.name.toLowerCase() === name.toLowerCase() &&
				v.voiceId === voiceId &&
				v.gender === input.gender
		);
	}

	const entry: SavedVoice = {
		id: idx >= 0 ? list[idx]!.id : uid('saved'),
		name,
		gender: input.gender,
		voiceId,
		refWavPath,
		updatedAt: now
	};

	if (idx >= 0) list[idx] = entry;
	else list.unshift(entry);

	saveSavedVoices(list);
	return entry;
}

export function deleteSavedVoice(id: string): boolean {
	const before = loadSavedVoices();
	const next = before.filter((v) => v.id !== id.trim());
	if (next.length === before.length) return false;
	saveSavedVoices(next);
	return true;
}

export function getSavedVoice(id: string): SavedVoice | null {
	return loadSavedVoices().find((v) => v.id === id.trim()) ?? null;
}
