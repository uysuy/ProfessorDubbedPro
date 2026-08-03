export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'pdp.theme';

function readStoredPreference(): ThemePreference {
	if (typeof localStorage === 'undefined') return 'system';
	const value = localStorage.getItem(STORAGE_KEY);
	if (value === 'light' || value === 'dark' || value === 'system') return value;
	return 'system';
}

function systemPrefersDark(): boolean {
	if (typeof window === 'undefined' || !window.matchMedia) return true;
	return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function resolve(preference: ThemePreference): ResolvedTheme {
	if (preference === 'system') {
		return systemPrefersDark() ? 'dark' : 'light';
	}
	return preference;
}

function applyDom(theme: ResolvedTheme) {
	if (typeof document === 'undefined') return;
	const root = document.documentElement;
	root.classList.toggle('dark', theme === 'dark');
	root.style.colorScheme = theme;
	root.dataset.theme = theme;
	document.body?.classList.toggle('dark', theme === 'dark');
}

let preference = $state<ThemePreference>(readStoredPreference());
let resolved = $state<ResolvedTheme>(resolve(preference));
let booted = false;
let mediaQuery: MediaQueryList | null = null;
let unlistenTheme: (() => void) | null = null;

function syncResolved() {
	resolved = resolve(preference);
	applyDom(resolved);
}

export const themeStore = {
	get preference() {
		return preference;
	},
	get resolved() {
		return resolved;
	},
	setPreference(next: ThemePreference) {
		preference = next;
		if (typeof localStorage !== 'undefined') {
			localStorage.setItem(STORAGE_KEY, next);
		}
		syncResolved();
		void syncTauriTheme(next);
	},
	/** Quick toggle between explicit light and dark (keeps System out of the cycle). */
	toggleLightDark() {
		const next: ThemePreference = resolved === 'dark' ? 'light' : 'dark';
		this.setPreference(next);
	},
	cyclePreference() {
		const order: ThemePreference[] = ['system', 'light', 'dark'];
		const idx = order.indexOf(preference);
		this.setPreference(order[(idx + 1) % order.length]!);
	},
	async init() {
		if (booted) return;
		booted = true;
		preference = readStoredPreference();
		syncResolved();

		if (typeof window !== 'undefined' && window.matchMedia) {
			mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
			const onChange = () => {
				if (preference === 'system') syncResolved();
			};
			mediaQuery.addEventListener?.('change', onChange);
		}

		await syncTauriTheme(preference);
		await listenTauriTheme();
	},
	destroy() {
		unlistenTheme?.();
		unlistenTheme = null;
	}
};

async function syncTauriTheme(pref: ThemePreference) {
	try {
		const { getCurrentWindow } = await import('@tauri-apps/api/window');
		const win = getCurrentWindow();
		if (pref === 'system') {
			await win.setTheme(null);
		} else {
			await win.setTheme(pref);
		}
	} catch {
		/* browser / permissions unavailable */
	}
}

async function listenTauriTheme() {
	try {
		const { getCurrentWindow } = await import('@tauri-apps/api/window');
		const win = getCurrentWindow();
		unlistenTheme = await win.onThemeChanged(({ payload }) => {
			if (preference !== 'system') return;
			resolved = payload === 'light' ? 'light' : 'dark';
			applyDom(resolved);
		});
	} catch {
		/* browser / permissions unavailable */
	}
}
