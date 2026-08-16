<script lang="ts">
	import { onMount } from 'svelte';
	import { fly } from 'svelte/transition';
	import * as Resizable from '$lib/components/ui/resizable/index.js';
	import { isPaneResizing, setPaneResizing } from '$lib/components/ui/resizable/pane-resize.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import DragGhost from '$lib/components/studio/DragGhost.svelte';
	import TopToolbar from '$lib/components/layout/TopToolbar.svelte';
	import LeftSidebar from '$lib/components/layout/LeftSidebar.svelte';
	import RightSidebar from '$lib/components/layout/RightSidebar.svelte';
	import CenterWorkspace from '$lib/components/studio/CenterWorkspace.svelte';
	import { projectStore } from '$lib/stores/project.svelte';
	import { dndStore } from '$lib/stores/dnd.svelte';
	import { PanelLeftOpen, PanelRightOpen } from '@lucide/svelte';
	import ExportDialog from '$lib/components/studio/ExportDialog.svelte';
	import ProjectSettingsDialog from '$lib/components/studio/ProjectSettingsDialog.svelte';
	import SubtitleDialog from '$lib/components/studio/SubtitleDialog.svelte';
	import TempoDialog from '$lib/components/studio/TempoDialog.svelte';
	import VoiceEngineDialog from '$lib/components/studio/VoiceEngineDialog.svelte';
	import ProsodyDialog from '$lib/components/studio/ProsodyDialog.svelte';
	import TitleLiverPanel from '$lib/components/studio/TitleLiverPanel.svelte';
	import { isTypingTarget, matchStudioShortcut, type StudioShortcutId } from '$lib/utils/shortcuts';
	import { isTauriRuntime } from '$lib/utils/platform';

	type PaneApi = {
		collapse: () => void;
		expand: () => void;
		isCollapsed: () => boolean;
	};

	let leftPane = $state<PaneApi | null>(null);
	let rightPane = $state<PaneApi | null>(null);
	let exportOpen = $state(false);
	let settingsOpen = $state(false);

	async function onImportMedia() {
		try {
			if (isTauriRuntime()) {
				const { open } = await import('@tauri-apps/plugin-dialog');
				const selected = await open({
					multiple: true,
					filters: [
						{
							name: 'Media',
							extensions: ['mp4', 'mkv', 'mov', 'webm', 'avi', 'mp3', 'wav', 'm4a', 'srt']
						}
					]
				});
				const paths = Array.isArray(selected)
					? selected
					: selected
						? [selected]
						: [];
				if (!paths.length) return;
				const { readFile } = await import('@tauri-apps/plugin-fs');
				const files: File[] = [];
				for (const path of paths) {
					if (typeof path !== 'string') continue;
					const bytes = await readFile(path);
					const name = path.split(/[/\\]/).pop() || 'media';
					files.push(new File([bytes], name));
				}
				if (!files.length) return;
				const n = await projectStore.importMediaFiles(files);
				dndStore.flash(n > 0 ? `Imported ${n} file${n === 1 ? '' : 's'}` : 'Nothing imported');
				return;
			}
			const input = document.createElement('input');
			input.type = 'file';
			input.multiple = true;
			input.accept = 'video/*,audio/*,.srt';
			input.onchange = async () => {
				const list = input.files ? [...input.files] : [];
				if (!list.length) return;
				const n = await projectStore.importMediaFiles(list);
				dndStore.flash(n > 0 ? `Imported ${n} file${n === 1 ? '' : 's'}` : 'Nothing imported');
			};
			input.click();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (/cancel/i.test(message)) return;
			dndStore.flash(message || 'Import failed');
		}
	}

	onMount(() => {
		projectStore.hydrate();
		// Capture phase so Ctrl shortcuts win over focused inputs.
		window.addEventListener('keydown', onStudioKeydown, true);
		return () => window.removeEventListener('keydown', onStudioKeydown, true);
	});

	function onNewProject() {
		if (projectStore.isDirty) {
			const ok =
				typeof window === 'undefined' ||
				window.confirm('Discard unsaved changes and start a new project?');
			if (!ok) return;
		} else {
			const ok =
				typeof window === 'undefined' ||
				window.confirm('Start a new project? The current session will be cleared.');
			if (!ok) return;
		}
		projectStore.createProject();
		const kept = projectStore.speakerBank.length;
		dndStore.flash(
			kept > 0
				? `New project — kept ${kept} saved speaker${kept === 1 ? '' : 's'}`
				: 'New project created'
		);
	}

	async function onSaveProject() {
		try {
			const path = await projectStore.saveProjectToFile();
			const name = path.split(/[/\\]/).pop() || 'project';
			dndStore.flash(`Saved ${name}`);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (message === 'Save cancelled.') return;
			dndStore.flash(message || 'Could not save project');
		}
	}

	async function onOpenProject() {
		if (projectStore.isDirty) {
			const ok =
				typeof window === 'undefined' ||
				window.confirm('You have unsaved changes. Open another project anyway?');
			if (!ok) return;
		}
		try {
			const { videoMissing } = await projectStore.openProjectFromFile();
			dndStore.flash(
				videoMissing
					? 'Project loaded — re-open the video file (path missing)'
					: 'Project opened'
			);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (message === 'Open cancelled.') return;
			dndStore.flash(message || 'Could not open project');
		}
	}

	function onExportProject() {
		exportOpen = true;
	}

	function requireSelection(): string | null {
		const id = projectStore.selectedCueIds[0] ?? null;
		if (!id) dndStore.flash('Select a subtitle first');
		return id;
	}

	function runStudioShortcut(action: StudioShortcutId) {
		switch (action) {
			case 'togglePlayback':
				projectStore.togglePlayback();
				return;
			case 'setStart': {
				const id = requireSelection();
				if (!id) return;
				if (!projectStore.setCueStartAtPlayhead(id)) {
					dndStore.flash('Couldn’t set start');
					return;
				}
				dndStore.flash('Start → playhead');
				return;
			}
			case 'setEnd': {
				const id = requireSelection();
				if (!id) return;
				if (!projectStore.setCueEndAtPlayhead(id)) {
					dndStore.flash('Couldn’t set end');
					return;
				}
				dndStore.flash('End → playhead');
				return;
			}
			case 'split': {
				const id = requireSelection();
				if (!id) return;
				const newId = projectStore.splitCueAtPlayhead(id);
				dndStore.flash(newId ? 'Split at playhead' : 'Playhead must be inside the cue');
				return;
			}
			case 'merge': {
				if (projectStore.selectedCueIds.length < 2) {
					dndStore.flash('Select 2+ subtitles to merge');
					return;
				}
				const kept = projectStore.mergeSelectedCues();
				dndStore.flash(kept ? 'Merged selection' : 'Couldn’t merge');
				return;
			}
			case 'snap': {
				const id = requireSelection();
				if (!id) return;
				dndStore.flash(
					projectStore.snapCueToPlayhead(id) ? 'Snapped to playhead' : 'Couldn’t snap'
				);
				return;
			}
			case 'delete': {
				const tlId = projectStore.selectedTitleLiverId;
				if (tlId && !projectStore.selectedCueIds.length) {
					projectStore.removeTitleLiverClip(tlId);
					dndStore.flash('Deleted live title');
					return;
				}
				const ids = projectStore.selectedCueIds;
				if (!ids.length) {
					dndStore.flash('Select a subtitle or live title first');
					return;
				}
				const withTts = ids.filter((id) => {
					const cue = projectStore.current.cues.find((c) => c.id === id);
					return cue != null && projectStore.cueHasTtsAudio(cue);
				});
				// Prefer clearing TTS audio when present so mock clips can be removed independently.
				if (withTts.length) {
					const n = projectStore.clearTtsAudio(withTts);
					dndStore.flash(n === 1 ? 'Removed TTS audio' : `Removed TTS audio ×${n}`);
					return;
				}
				const n = ids.length;
				projectStore.deleteCues(ids);
				dndStore.flash(n === 1 ? 'Deleted subtitle' : `Deleted ${n} subtitles`);
				return;
			}
			case 'duplicate': {
				if (projectStore.selectedTitleLiverId && !projectStore.selectedCueIds.length) {
					const c = projectStore.duplicateTitleLiverClip();
					dndStore.flash(c ? 'Duplicated live title' : 'Nothing to duplicate');
					return;
				}
				const newId = projectStore.duplicateSelectedCue();
				dndStore.flash(newId ? 'Duplicated subtitle' : 'Select a subtitle first');
				return;
			}
			case 'undo':
				dndStore.flash(projectStore.undo() ? 'Undo' : 'Nothing to undo');
				return;
			case 'redo':
				dndStore.flash(projectStore.redo() ? 'Redo' : 'Nothing to redo');
				return;
			case 'save':
				void onSaveProject();
				return;
			case 'open':
				void onOpenProject();
				return;
			case 'new':
				onNewProject();
				return;
		}
	}

	function onStudioKeydown(e: KeyboardEvent) {
		// Ignore when a modal dialog owns focus (export, etc.).
		if (document.querySelector('[data-slot="dialog-content"]')) return;

		// Esc closes Title Liver template browser (keeps timeline selection).
		if (
			!e.altKey &&
			!e.ctrlKey &&
			!e.metaKey &&
			(e.key === 'Escape' || e.code === 'Escape') &&
			studioUi.titleLiverOpen
		) {
			e.preventDefault();
			studioUi.closeTitleLiver();
			return;
		}

		// Arrow nudge for selected live title (when not typing).
		if (
			projectStore.selectedTitleLiverId &&
			!projectStore.selectedCueIds.length &&
			!isTypingTarget(e.target) &&
			!e.altKey &&
			!e.ctrlKey &&
			!e.metaKey
		) {
			const step = e.shiftKey ? 0.02 : 0.008;
			if (e.key === 'ArrowLeft' || e.code === 'ArrowLeft') {
				e.preventDefault();
				projectStore.nudgeTitleLiver(null, -step, 0);
				return;
			}
			if (e.key === 'ArrowRight' || e.code === 'ArrowRight') {
				e.preventDefault();
				projectStore.nudgeTitleLiver(null, step, 0);
				return;
			}
			if (e.key === 'ArrowUp' || e.code === 'ArrowUp') {
				e.preventDefault();
				projectStore.nudgeTitleLiver(null, 0, -step);
				return;
			}
			if (e.key === 'ArrowDown' || e.code === 'ArrowDown') {
				e.preventDefault();
				projectStore.nudgeTitleLiver(null, 0, step);
				return;
			}
		}

		const action = matchStudioShortcut(e);
		if (!action) return;
		e.preventDefault();
		e.stopPropagation();
		runStudioShortcut(action);
	}

	function onPaneDragging(dragging: boolean) {
		// Class toggle lives in the PaneResizer wrapper (no Svelte re-render).
		if (!dragging) {
			// Sync snap-collapse that may have occurred during the gesture.
			queueMicrotask(() => {
				try {
					projectStore.setLeftCollapsed(leftPane?.isCollapsed() ?? false);
					projectStore.setRightCollapsed(rightPane?.isCollapsed() ?? false);
				} catch {
					/* ignore */
				}
			});
		}
	}

	$effect(() => {
		const end = () => setPaneResizing(false);
		window.addEventListener('blur', end);
		return () => window.removeEventListener('blur', end);
	});

	$effect(() => {
		const pane = leftPane;
		const collapsed = projectStore.leftCollapsed;
		if (!pane) return;
		if (isPaneResizing()) return;
		try {
			if (collapsed && !pane.isCollapsed()) pane.collapse();
			if (!collapsed && pane.isCollapsed()) pane.expand();
		} catch {
			/* pane not ready */
		}
	});

	$effect(() => {
		const pane = rightPane;
		const collapsed = projectStore.rightCollapsed;
		if (!pane) return;
		if (isPaneResizing()) return;
		try {
			if (collapsed && !pane.isCollapsed()) pane.collapse();
			if (!collapsed && pane.isCollapsed()) pane.expand();
		} catch {
			/* pane not ready */
		}
	});

	const leftCollapsed = $derived(projectStore.leftCollapsed);
	const rightCollapsed = $derived(projectStore.rightCollapsed);
</script>

<div class="app-shell">
	<a
		href="#studio-main"
		class="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-card focus:px-3 focus:py-1.5 focus:text-sm focus:shadow-[var(--elevation-float)]"
	>
		Skip to studio
	</a>
	<TopToolbar
		canUndo={projectStore.canUndo}
		canRedo={projectStore.canRedo}
		onUndo={() => {
			dndStore.flash(projectStore.undo() ? 'Undo' : 'Nothing to undo');
		}}
		onRedo={() => {
			dndStore.flash(projectStore.redo() ? 'Redo' : 'Nothing to redo');
		}}
		onNew={onNewProject}
		onOpen={onOpenProject}
		onSave={onSaveProject}
		onExport={onExportProject}
		onImportMedia={onImportMedia}
		onSettings={() => {
			settingsOpen = true;
		}}
	/>

	<div id="studio-main" class="relative min-h-0 flex-1" tabindex="-1">
		{#if leftCollapsed}
			<div
				class="absolute top-2 left-2 z-30"
				transition:fly={{ x: -6, duration: 200, opacity: 0 }}
			>
				<Button
					variant="secondary"
					size="icon-sm"
					class="border border-border/80 bg-card/95 shadow-[var(--elevation-float)]"
					aria-label="Expand left panel"
					onclick={() => projectStore.toggleLeft()}
				>
					<PanelLeftOpen />
				</Button>
			</div>
		{/if}
		{#if rightCollapsed}
			<div
				class="absolute top-2 right-2 z-30"
				transition:fly={{ x: 6, duration: 200, opacity: 0 }}
			>
				<Button
					variant="secondary"
					size="icon-sm"
					class="border border-border/80 bg-card/95 shadow-[var(--elevation-float)]"
					aria-label="Expand right panel"
					onclick={() => projectStore.toggleRight()}
				>
					<PanelRightOpen />
				</Button>
			</div>
		{/if}

		<Resizable.PaneGroup direction="horizontal" class="studio-pane-group h-full" id="studio-main-panes">
			<Resizable.Pane
				bind:this={leftPane}
				order={1}
				collapsible
				collapsedSize={0}
				defaultSize={28}
				minSize={18}
				maxSize={40}
				class="studio-side-pane min-w-0 overflow-hidden"
				onCollapse={() => {
					if (!isPaneResizing()) projectStore.setLeftCollapsed(true);
				}}
				onExpand={() => {
					if (!isPaneResizing()) projectStore.setLeftCollapsed(false);
				}}
			>
				<div class="studio-panel h-full border-r border-border/70">
					<LeftSidebar />
				</div>
			</Resizable.Pane>

			<!-- Never use disabled= — paneforge tears down drag listeners if it flips mid-gesture. -->
			<Resizable.Handle
				withHandle
				class="split-handle {leftCollapsed ? 'split-handle-hidden' : ''}"
				onDraggingChange={onPaneDragging}
			/>

			<!-- maxSize 100 so center can fill the window when sidebars collapse -->
			<Resizable.Pane
				order={2}
				defaultSize={50}
				minSize={24}
				maxSize={100}
				class="studio-center-pane min-w-0"
			>
				<div class="studio-panel-center h-full">
					<CenterWorkspace />
				</div>
			</Resizable.Pane>

			<Resizable.Handle
				withHandle
				class="split-handle {rightCollapsed ? 'split-handle-hidden' : ''}"
				onDraggingChange={onPaneDragging}
			/>

			<Resizable.Pane
				bind:this={rightPane}
				order={3}
				collapsible
				collapsedSize={0}
				defaultSize={22}
				minSize={14}
				maxSize={32}
				class="studio-side-pane min-w-0 overflow-hidden"
				onCollapse={() => {
					if (!isPaneResizing()) projectStore.setRightCollapsed(true);
				}}
				onExpand={() => {
					if (!isPaneResizing()) projectStore.setRightCollapsed(false);
				}}
			>
				<div class="studio-panel h-full border-l border-border/70">
					<RightSidebar />
				</div>
			</Resizable.Pane>
		</Resizable.PaneGroup>
	</div>
</div>

<ExportDialog bind:open={exportOpen} />
<ProjectSettingsDialog bind:open={settingsOpen} />
<SubtitleDialog />
<TempoDialog />
<VoiceEngineDialog />
<ProsodyDialog />
<TitleLiverPanel />
<DragGhost />
