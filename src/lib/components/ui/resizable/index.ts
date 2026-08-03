import { Pane } from 'paneforge';
import Handle from './resizable-handle.svelte';
import PaneGroup from './resizable-pane-group.svelte';

/**
 * Thin styled wrappers around paneforge:
 * - PaneGroup  → paneforge PaneGroup
 * - Pane       → paneforge Pane
 * - Handle     → paneforge PaneResizer
 */
export {
	PaneGroup,
	Pane,
	Handle,
	Handle as PaneResizer,
	PaneGroup as ResizablePaneGroup,
	Pane as ResizablePane,
	Handle as ResizableHandle
};
