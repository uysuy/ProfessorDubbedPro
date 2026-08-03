/** Shared resize chrome — class-only, no Svelte state (avoids re-render hitch). */

export function setPaneResizing(dragging: boolean) {
	document.documentElement.classList.toggle('is-pane-resizing', dragging);
}

export function isPaneResizing() {
	return document.documentElement.classList.contains('is-pane-resizing');
}
