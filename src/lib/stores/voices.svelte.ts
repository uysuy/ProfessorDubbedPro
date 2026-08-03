import type { VoiceProfile } from '$lib/types/project';
import {
	DEFAULT_EDGE_VOICE_ID,
	FALLBACK_KHMER_VOICES,
	fetchEdgeVoices,
	migrateVoiceId
} from '$lib/tts/edge-voices';

export type VoicesLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

let items = $state<VoiceProfile[]>([...FALLBACK_KHMER_VOICES]);
let status = $state<VoicesLoadStatus>('idle');
let error = $state<string | null>(null);
let loadPromise: Promise<void> | null = null;

/**
 * Studio voice library — Edge-TTS Khmer voices when online,
 * Sreymom / Piseth fallback otherwise.
 */
export const voicesStore = {
	get voices(): VoiceProfile[] {
		return items;
	},
	get status(): VoicesLoadStatus {
		return status;
	},
	get error(): string | null {
		return error;
	},
	get defaultVoiceId(): string {
		return items[0]?.id ?? DEFAULT_EDGE_VOICE_ID;
	},
	find(id: string): VoiceProfile | undefined {
		const migrated = migrateVoiceId(id);
		return items.find((v) => v.id === migrated || v.id === id);
	},
	displayName(id: string): string {
		return this.find(id)?.name ?? migrateVoiceId(id);
	},
	/** Load (or reload) Khmer Edge-TTS voices. Safe to call repeatedly. */
	ensureLoaded(force = false): Promise<void> {
		if (!force && status === 'loading' && loadPromise) return loadPromise;
		if (!force && status === 'ready' && loadPromise) return loadPromise;

		status = 'loading';
		error = null;
		loadPromise = (async () => {
			try {
				const list = await fetchEdgeVoices('km');
				items = list.length ? list : [...FALLBACK_KHMER_VOICES];
				status = 'ready';
			} catch (err) {
				error = err instanceof Error ? err.message : String(err);
				if (!items.length) items = [...FALLBACK_KHMER_VOICES];
				status = 'error';
			}
		})();
		return loadPromise;
	},
	/** Ensure `id` exists in the list (e.g. remembered preference). */
	ensureVoicePresent(id: string) {
		const migrated = migrateVoiceId(id);
		if (items.some((v) => v.id === migrated)) return migrated;
		const fallback = FALLBACK_KHMER_VOICES.find((v) => v.id === migrated);
		if (fallback) {
			items = [...items, fallback];
		}
		return migrated;
	}
};
