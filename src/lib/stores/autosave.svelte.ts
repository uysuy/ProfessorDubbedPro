import { projectStore } from '$lib/stores/project.svelte';
import { preferencesStore } from '$lib/stores/preferences.svelte';
import { isTauriRuntime } from '$lib/utils/platform';

const PREF_KEY = 'pdp.autoSave';
/** How long the toolbar “Auto-saved” hint stays visible. */
const INDICATOR_MS = 2800;

function readEnabled(): boolean {
	if (typeof localStorage === 'undefined') return true;
	const raw = localStorage.getItem(PREF_KEY);
	if (raw === '0' || raw === 'false') return false;
	if (raw === '1' || raw === 'true') return true;
	return true;
}

function nextIntervalMs(): number {
	const sec = preferencesStore.autoSaveIntervalSec;
	// Light jitter (±4s) so ticks don't stack if multiple windows share a clock.
	const jitter = Math.floor(Math.random() * 8001) - 4000;
	return Math.max(30_000, sec * 1000 + jitter);
}

let enabled = $state(readEnabled());
let lastAutoSavedAt = $state<string | null>(null);
let indicatorVisible = $state(false);
let indicatorKind = $state<'file' | 'recovery'>('recovery');
let booted = false;
let timerId: ReturnType<typeof setTimeout> | null = null;
let indicatorTimer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let unlistenClose: (() => void) | null = null;
let closing = false;

function clearTimer() {
	if (timerId != null) {
		clearTimeout(timerId);
		timerId = null;
	}
}

function showIndicator(kind: 'file' | 'recovery') {
	indicatorKind = kind;
	indicatorVisible = true;
	lastAutoSavedAt = new Date().toISOString();
	if (indicatorTimer != null) clearTimeout(indicatorTimer);
	indicatorTimer = setTimeout(() => {
		indicatorVisible = false;
		indicatorTimer = null;
	}, INDICATOR_MS);
}

async function runTick() {
	if (!enabled || running || closing) {
		schedule();
		return;
	}
	if (!projectStore.isDirty) {
		schedule();
		return;
	}
	running = true;
	try {
		const result = await projectStore.autoSaveQuiet();
		if (result === 'file' || result === 'recovery') {
			showIndicator(result);
		}
	} catch {
		/* quiet — never interrupt editing */
	} finally {
		running = false;
		schedule();
	}
}

function schedule() {
	clearTimer();
	if (!enabled || !booted) return;
	timerId = setTimeout(() => {
		void runTick();
	}, nextIntervalMs());
}

function onVisibilityChange() {
	if (typeof document === 'undefined') return;
	if (document.visibilityState !== 'hidden') return;
	if (!enabled) return;
	void projectStore.flushAutosave({ reason: 'hidden' });
}

function onBeforeUnload() {
	if (!enabled) return;
	// Sync recovery only — async file I/O is unreliable here.
	projectStore.writeRecoverySync();
}

async function attachCloseHandler() {
	if (!isTauriRuntime()) return;
	try {
		const { getCurrentWindow } = await import('@tauri-apps/api/window');
		const win = getCurrentWindow();
		// Keep flush short — a hung await here blocks the X button forever.
		unlistenClose = await win.onCloseRequested(async () => {
			if (closing) return;
			closing = true;
			const flush = (async () => {
				if (!enabled) return;
				await projectStore.flushAutosave({ reason: 'close' });
			})();
			await Promise.race([
				flush.catch(() => undefined),
				new Promise<void>((resolve) => setTimeout(resolve, 1500))
			]);
			// Do not call preventDefault — allow the window to close after flush.
		});
	} catch {
		/* browser / unavailable */
	}
}

export const autosaveStore = {
	get enabled() {
		return enabled;
	},
	get lastAutoSavedAt() {
		return lastAutoSavedAt;
	},
	get indicatorVisible() {
		return indicatorVisible;
	},
	get indicatorKind() {
		return indicatorKind;
	},
	get indicatorLabel() {
		if (!indicatorVisible) return '';
		return indicatorKind === 'file' ? 'Auto-saved' : 'Recovery saved';
	},
	setEnabled(next: boolean) {
		enabled = next;
		if (typeof localStorage !== 'undefined') {
			localStorage.setItem(PREF_KEY, next ? '1' : '0');
		}
		if (next) schedule();
		else clearTimer();
	},
	/** Reschedule using the latest interval preference. */
	reschedule() {
		if (enabled && booted) schedule();
	},
	async init() {
		if (booted) return;
		booted = true;
		enabled = readEnabled();
		if (typeof document !== 'undefined') {
			document.addEventListener('visibilitychange', onVisibilityChange);
		}
		if (typeof window !== 'undefined') {
			window.addEventListener('beforeunload', onBeforeUnload);
		}
		await attachCloseHandler();
		schedule();
		// Offer restore once after hydrate (caller may have already hydrated).
		void this.offerRecoveryIfNeeded();
	},
	destroy() {
		booted = false;
		clearTimer();
		if (indicatorTimer != null) {
			clearTimeout(indicatorTimer);
			indicatorTimer = null;
		}
		unlistenClose?.();
		unlistenClose = null;
		if (typeof document !== 'undefined') {
			document.removeEventListener('visibilitychange', onVisibilityChange);
		}
		if (typeof window !== 'undefined') {
			window.removeEventListener('beforeunload', onBeforeUnload);
		}
	},
	/** Prompt once if a dirty recovery snapshot exists. */
	async offerRecoveryIfNeeded() {
		try {
			const doc = await projectStore.peekRecovery();
			if (!doc) return;
			if (!doc.dirty) {
				await projectStore.clearAllRecovery();
				return;
			}

			const current = projectStore.current;
			const sameRevision = current.updatedAt === doc.project.updatedAt;
			if (sameRevision) {
				// Already hydrated the latest cues — restore dirty + paths quietly.
				await projectStore.applyRecoveryMeta(doc);
				return;
			}

			const name = doc.project.name?.trim() || 'Untitled';
			const when = doc.savedAt ? new Date(doc.savedAt).toLocaleString() : 'last session';
			const ok =
				typeof window === 'undefined' ||
				window.confirm(
					`Recover unsaved work from “${name}” (${when})?\n\nCancel keeps your current session.`
				);
			if (!ok) {
				await projectStore.clearAllRecovery();
				return;
			}
			await projectStore.restoreFromRecovery(doc);
			showIndicator('recovery');
		} catch {
			/* ignore */
		}
	}
};
