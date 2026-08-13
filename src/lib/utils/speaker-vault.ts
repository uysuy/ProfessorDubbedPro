/**
 * App-wide speaker voice vault — survives New project and app restart.
 * Cleared only when the user Clears a lock (or removes a speaker entry).
 */

import type { SpeakerVoiceProfile } from '$lib/types/project';

const VAULT_KEY = 'pdp.speakerVoiceVault.v1';

export type SpeakerVaultEntry = {
	id: string;
	gender: SpeakerVoiceProfile['gender'];
	voiceId: string;
	locked: boolean;
	refWavPath: string;
};

function canUseStorage(): boolean {
	return typeof localStorage !== 'undefined';
}

export function loadSpeakerVault(): SpeakerVaultEntry[] {
	if (!canUseStorage()) return [];
	try {
		const raw = localStorage.getItem(VAULT_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed
			.map((row): SpeakerVaultEntry | null => {
				if (!row || typeof row !== 'object') return null;
				const o = row as Record<string, unknown>;
				const id = typeof o.id === 'string' ? o.id.trim() : '';
				if (!id) return null;
				const gender =
					o.gender === 'male' || o.gender === 'female' || o.gender === 'neutral'
						? o.gender
						: 'neutral';
				const voiceId = typeof o.voiceId === 'string' ? o.voiceId.trim() : '';
				const refWavPath = typeof o.refWavPath === 'string' ? o.refWavPath.trim() : '';
				const locked = Boolean(o.locked) && Boolean(refWavPath);
				return {
					id,
					gender,
					voiceId: voiceId || 'voxcpm:soft-f',
					locked,
					refWavPath: locked ? refWavPath : ''
				};
			})
			.filter((x): x is SpeakerVaultEntry => x != null);
	} catch {
		return [];
	}
}

export function saveSpeakerVault(entries: SpeakerVaultEntry[]): void {
	if (!canUseStorage()) return;
	try {
		const cleaned = entries
			.map((e) => ({
				id: e.id.trim(),
				gender: e.gender,
				voiceId: e.voiceId,
				locked: Boolean(e.locked && e.refWavPath),
				refWavPath: e.locked && e.refWavPath ? e.refWavPath : ''
			}))
			.filter((e) => e.id);
		localStorage.setItem(VAULT_KEY, JSON.stringify(cleaned));
	} catch {
		/* ignore quota / private mode */
	}
}

/** Upsert bank entries into the vault (never drops other vault speakers). */
export function persistSpeakerBankToVault(bank: SpeakerVoiceProfile[]): void {
	const map = new Map(loadSpeakerVault().map((e) => [e.id, e] as const));
	for (const s of bank) {
		const id = s.id.trim();
		if (!id) continue;
		map.set(id, {
			id,
			gender: s.gender,
			voiceId: s.voiceId,
			locked: Boolean(s.locked && s.refWavPath),
			refWavPath: s.locked && s.refWavPath ? s.refWavPath : ''
		});
	}
	saveSpeakerVault([...map.values()]);
}

/** Mark one speaker unlocked in the vault (keeps gender/preset). */
export function clearSpeakerLockInVault(speakerId: string): void {
	const id = speakerId.trim();
	if (!id) return;
	const map = new Map(loadSpeakerVault().map((e) => [e.id, e] as const));
	const prev = map.get(id);
	if (!prev) return;
	map.set(id, { ...prev, locked: false, refWavPath: '' });
	saveSpeakerVault([...map.values()]);
}

/** Rename a vault entry when the user renames a speaker. */
export function renameSpeakerInVault(fromId: string, toId: string): void {
	const from = fromId.trim();
	const to = toId.trim();
	if (!from || !to || from === to) return;
	const map = new Map(loadSpeakerVault().map((e) => [e.id, e] as const));
	const prev = map.get(from);
	if (!prev) return;
	map.delete(from);
	map.set(to, { ...prev, id: to });
	saveSpeakerVault([...map.values()]);
}

/** Build a project speaker bank from the vault (cue counts start at 0). */
export function speakerBankFromVault(): SpeakerVoiceProfile[] {
	return loadSpeakerVault().map((e) => ({
		id: e.id,
		gender: e.gender,
		voiceId: e.voiceId,
		locked: e.locked,
		refWavPath: e.refWavPath,
		cueCount: 0
	}));
}

/** Merge vault locks/presets into a working bank (vault wins for locked refs). */
export function mergeBankWithVault(bank: SpeakerVoiceProfile[]): SpeakerVoiceProfile[] {
	const vault = new Map(loadSpeakerVault().map((e) => [e.id, e] as const));
	if (!vault.size) return bank;
	return bank.map((s) => {
		const v = vault.get(s.id);
		if (!v) return s;
		return {
			...s,
			gender: v.gender,
			voiceId: v.voiceId || s.voiceId,
			locked: v.locked,
			refWavPath: v.locked ? v.refWavPath : ''
		};
	});
}
