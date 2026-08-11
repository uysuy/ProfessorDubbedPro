import { isTauriRuntime } from '$lib/utils/platform';
import { projectStore } from '$lib/stores/project.svelte';
import { dndStore } from '$lib/stores/dnd.svelte';

/** Open a file picker and import SubRip into the project (replace cues). */
export async function importSrtFromDialog(): Promise<boolean> {
	try {
		if (isTauriRuntime()) {
			const { open } = await import('@tauri-apps/plugin-dialog');
			const { readTextFile } = await import('@tauri-apps/plugin-fs');
			const selected = await open({
				multiple: false,
				filters: [{ name: 'SubRip subtitles', extensions: ['srt'] }]
			});
			const path = Array.isArray(selected) ? selected[0] : selected;
			if (!path || typeof path !== 'string') return false;
			const raw = await readTextFile(path);
			const name = path.split(/[/\\]/).pop() || 'import.srt';
			const { count, khmer } = projectStore.importSrtText(raw, {
				replace: true,
				fileName: name
			});
			if (!count) {
				dndStore.flash('No cues found in that SRT file.');
				return false;
			}
			dndStore.flash(
				khmer
					? `Imported ${count} Khmer cue${count === 1 ? '' : 's'} from ${name}`
					: `Imported ${count} cue${count === 1 ? '' : 's'} from ${name} — Paste Khmer or Translate next`
			);
			return true;
		}

		return await new Promise<boolean>((resolve) => {
			const input = document.createElement('input');
			input.type = 'file';
			input.accept = '.srt,application/x-subrip,text/plain';
			input.onchange = async () => {
				const file = input.files?.[0];
				if (!file) {
					resolve(false);
					return;
				}
				try {
					const { count, khmer } = await projectStore.importSrtFile(file, { replace: true });
					if (!count) {
						dndStore.flash('No cues found in that SRT file.');
						resolve(false);
						return;
					}
					dndStore.flash(
						khmer
							? `Imported ${count} Khmer cue${count === 1 ? '' : 's'} from ${file.name}`
							: `Imported ${count} cue${count === 1 ? '' : 's'} from ${file.name} — Paste Khmer or Translate next`
					);
					resolve(true);
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					dndStore.flash(message || 'Import failed');
					resolve(false);
				}
			};
			input.oncancel = () => resolve(false);
			input.click();
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		dndStore.flash(message || 'Import failed');
		return false;
	}
}
