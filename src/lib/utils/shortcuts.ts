/**
 * Studio keyboard shortcuts — single source of truth for matching + docs.
 */

export type StudioShortcutId =
	| 'togglePlayback'
	| 'setStart'
	| 'setEnd'
	| 'split'
	| 'merge'
	| 'delete'
	| 'duplicate'
	| 'snap'
	| 'undo'
	| 'redo'
	| 'save'
	| 'open'
	| 'new';

export type ShortcutChord = {
	/** Display label, e.g. "Ctrl+S" */
	keys: string;
	/** Human description */
	description: string;
};

export type ShortcutGroup = {
	title: string;
	items: Array<{ id: StudioShortcutId; chords: ShortcutChord[] }>;
};

/** Docs / Settings list — keep in sync with `matchStudioShortcut`. */
export const SHORTCUT_GROUPS: ShortcutGroup[] = [
	{
		title: 'Playback',
		items: [
			{
				id: 'togglePlayback',
				chords: [{ keys: 'Space', description: 'Play / pause video' }]
			}
		]
	},
	{
		title: 'Subtitle timing',
		items: [
			{
				id: 'setStart',
				chords: [
					{ keys: 'A or [', description: 'Set start of selection to playhead' },
					{ keys: 'Ctrl+[', description: 'Set start (works while editing text)' }
				]
			},
			{
				id: 'setEnd',
				chords: [
					{ keys: 'S or ]', description: 'Set end of selection to playhead' },
					{ keys: 'Ctrl+]', description: 'Set end (works while editing text)' }
				]
			},
			{
				id: 'split',
				chords: [
					{ keys: 'Ctrl+Enter', description: 'Split selected subtitle at playhead' },
					{ keys: 'Ctrl+B', description: 'Split at playhead (alias)' }
				]
			},
			{
				id: 'merge',
				chords: [{ keys: 'Ctrl+M', description: 'Merge selected subtitles' }]
			},
			{
				id: 'snap',
				chords: [{ keys: 'Ctrl+Shift+G', description: 'Snap cue start to playhead' }]
			}
		]
	},
	{
		title: 'Editing',
		items: [
					{
						id: 'delete',
						chords: [
							{
								keys: 'Delete / Backspace',
								description: 'Delete selected subtitle(s) or live title'
							}
						]
					},
					{
						id: 'duplicate',
						chords: [
							{ keys: 'Ctrl+D', description: 'Duplicate selected subtitle or live title' }
						]
					},
			{
				id: 'undo',
				chords: [{ keys: 'Ctrl+Z', description: 'Undo last change' }]
			},
			{
				id: 'redo',
				chords: [
					{ keys: 'Ctrl+Y', description: 'Redo' },
					{ keys: 'Ctrl+Shift+Z', description: 'Redo (alternate)' }
				]
			}
		]
	},
	{
		title: 'Project',
		items: [
			{ id: 'save', chords: [{ keys: 'Ctrl+S', description: 'Save project' }] },
			{ id: 'open', chords: [{ keys: 'Ctrl+O', description: 'Open project' }] },
			{ id: 'new', chords: [{ keys: 'Ctrl+N', description: 'New project' }] }
		]
	}
];

/** True when focus is in a text field (skip bare letter shortcuts). */
export function isTypingTarget(el: EventTarget | null): boolean {
	if (!(el instanceof HTMLElement)) return false;
	if (el.isContentEditable) return true;
	const tag = el.tagName;
	if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
	return Boolean(el.closest('input, textarea, select, [contenteditable="true"]'));
}

function codeOrKey(e: KeyboardEvent, code: string, keys: string[]): boolean {
	if (e.code === code) return true;
	return keys.includes(e.key);
}

/**
 * Map a keydown to a studio action.
 * Returns null when the event should pass through.
 *
 * Modifier shortcuts (Ctrl/Cmd) may run while typing in inputs.
 * Bare letter / Space / Delete require not typing.
 */
export function matchStudioShortcut(e: KeyboardEvent): StudioShortcutId | null {
	if (e.altKey || e.repeat) return null;

	const mod = e.ctrlKey || e.metaKey;
	const shift = e.shiftKey;
	const typing = isTypingTarget(e.target);

	// —— Project (always; prevent browser save/open) ——
	if (mod && !shift && codeOrKey(e, 'KeyS', ['s', 'S'])) return 'save';
	if (mod && !shift && codeOrKey(e, 'KeyO', ['o', 'O'])) return 'open';
	if (mod && !shift && codeOrKey(e, 'KeyN', ['n', 'N'])) return 'new';

	// —— Undo / redo (project-level; works after delete/edit) ——
	if (mod && !shift && codeOrKey(e, 'KeyZ', ['z', 'Z'])) return 'undo';
	if (mod && shift && codeOrKey(e, 'KeyZ', ['z', 'Z'])) return 'redo';
	if (mod && !shift && codeOrKey(e, 'KeyY', ['y', 'Y'])) return 'redo';

	// —— Timing / edit with modifiers (ok while typing in cells) ——
	if (mod && !shift && (e.code === 'Enter' || e.key === 'Enter')) return 'split';
	if (mod && !shift && codeOrKey(e, 'KeyB', ['b', 'B'])) return 'split';
	if (mod && !shift && codeOrKey(e, 'KeyM', ['m', 'M'])) return 'merge';
	if (mod && !shift && codeOrKey(e, 'KeyD', ['d', 'D'])) return 'duplicate';
	if (mod && shift && codeOrKey(e, 'KeyG', ['g', 'G'])) return 'snap';
	if (mod && !shift && (e.code === 'BracketLeft' || e.key === '[')) return 'setStart';
	if (mod && !shift && (e.code === 'BracketRight' || e.key === ']')) return 'setEnd';

	// —— Bare keys only when not typing ——
	if (typing || mod) return null;

	if (e.code === 'Space' || e.key === ' ') return 'togglePlayback';
	if (e.code === 'Delete' || e.key === 'Delete' || e.code === 'Backspace' || e.key === 'Backspace') {
		return 'delete';
	}
	if (e.code === 'BracketLeft' || e.key === '[') return 'setStart';
	if (e.code === 'BracketRight' || e.key === ']') return 'setEnd';
	if (codeOrKey(e, 'KeyA', ['a', 'A'])) return 'setStart';
	if (codeOrKey(e, 'KeyS', ['s', 'S'])) return 'setEnd';

	return null;
}
