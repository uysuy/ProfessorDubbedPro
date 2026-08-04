import { invoke } from '@tauri-apps/api/core';
import { isTauriRuntime } from '$lib/utils/platform';

export type SystemFontInfo = {
	family: string;
	path: string;
};

const KHMER_HINT =
	/khmer|noto\s*sans\s*khmer|leelawadee|daunpenh|battambang|moul|content|siemreap|hanuman/i;

/** Prefer Khmer-capable families at the top of the picker. */
export function sortFontsForPicker(fonts: SystemFontInfo[]): SystemFontInfo[] {
	return [...fonts].sort((a, b) => {
		const ak = KHMER_HINT.test(a.family) ? 0 : 1;
		const bk = KHMER_HINT.test(b.family) ? 0 : 1;
		if (ak !== bk) return ak - bk;
		return a.family.localeCompare(b.family, undefined, { sensitivity: 'base' });
	});
}

export async function listSystemFonts(): Promise<SystemFontInfo[]> {
	if (!isTauriRuntime()) return [];
	try {
		const list = await invoke<SystemFontInfo[]>('list_system_fonts');
		return Array.isArray(list) ? sortFontsForPicker(list) : [];
	} catch {
		return [];
	}
}
