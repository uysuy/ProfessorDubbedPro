<script lang="ts">
	import * as Table from '$lib/components/ui/table/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Checkbox } from '$lib/components/ui/checkbox/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import { ScrollArea } from '$lib/components/ui/scroll-area/index.js';
	import * as Tooltip from '$lib/components/ui/tooltip/index.js';
	import { playback, projectStore } from '$lib/stores/project.svelte';
	import { tempoStore } from '$lib/stores/tempo.svelte';
	import { voicesStore } from '$lib/stores/voices.svelte';
	import { VOXCPM_VOICES } from '$lib/tts/voxcpm-voices';
	import { voicesForEngine } from '$lib/tts/voice-engine';
	import { setVisualPlayheadMs } from '$lib/stores/playback-clock';
	import {
		dndStore,
		MIME_CUE_REORDER,
		MIME_TTS_AUDIO,
		isFileDrag,
		type DropEdge
	} from '$lib/stores/dnd.svelte';
	import { formatTimecode, parseTimecode } from '$lib/utils/time';
	import type { SubtitleCue } from '$lib/types/project';
	import {
		preferencesStore,
		languageLabel,
		usesKhmerScript,
		normalizeDubLanguage
	} from '$lib/stores/preferences.svelte';
	import { translationStore } from '$lib/stores/translation.svelte';
	import {
		AudioLines,
		ArrowDownToLine,
		ArrowLeftToLine,
		ArrowRightToLine,
		ArrowUpToLine,
		Captions,
		GripVertical,
		Languages,
		LocateFixed,
		Merge,
		Pause,
		Play,
		Plus,
		Scissors,
		Sparkles,
		Trash2
	} from '@lucide/svelte';
	import { onDestroy, onMount } from 'svelte';

	const cellInput =
		'dense-input h-7 border-transparent bg-transparent px-1.5 font-mono text-xs shadow-none';

	const headClass =
		'h-8 px-2 text-[10px] font-semibold tracking-[0.08em] text-foreground/90 uppercase';

	const targetLang = $derived(normalizeDubLanguage(projectStore.current.targetLanguage));
	const targetLangLabel = $derived(languageLabel(targetLang));
	const translationUsesKhmer = $derived(usesKhmerScript(targetLang));

	let flashIds = $state<Set<string>>(new Set());
	let flashTimer: ReturnType<typeof setTimeout> | null = null;

	type CtxMenu = {
		x: number;
		y: number;
		cueId: string | null;
	};
	let ctxMenu = $state<CtxMenu | null>(null);

	const allSelected = $derived(
		projectStore.current.cues.length > 0 &&
			projectStore.selectedCueIds.length === projectStore.current.cues.length
	);
	const someSelected = $derived(
		projectStore.selectedCueIds.length > 0 &&
			projectStore.selectedCueIds.length < projectStore.current.cues.length
	);
	const selectedCount = $derived(projectStore.selectedCueIds.length);
	const primarySelectedId = $derived(projectStore.selectedCueIds[0] ?? null);
	const canSplitAtPlayhead = $derived.by(() => canSplitCue(primarySelectedId));
	const canMergeSelection = $derived(selectedCount >= 2);

	/** Bank ids + any free-text speakers still present on cues. */
	const speakerOptions = $derived.by(() => {
		const ids = new Set<string>();
		for (const s of projectStore.speakerBank) ids.add(s.id);
		for (const c of projectStore.current.cues) {
			const sp = (c.speaker || '').trim();
			if (sp) ids.add(sp);
		}
		if (ids.size === 0) ids.add('Speaker 1');
		return [...ids];
	});

	function canSplitCue(id: string | null | undefined) {
		if (!id) return false;
		const cue = projectStore.current.cues.find((c) => c.id === id);
		if (!cue) return false;
		const ph = playback.playheadMs;
		return ph >= cue.startMs + 200 && ph <= cue.endMs - 200;
	}

	const draggingCueId = $derived(
		dndStore.drag?.kind === 'cue-reorder' ? dndStore.drag.id : null
	);
	const audioDragActive = $derived(dndStore.drag?.kind === 'tts-audio');
	const dropTarget = $derived(dndStore.dropTarget);

	function voiceName(id: string) {
		if (preferencesStore.ttsEngine === 'voxcpm') {
			return VOXCPM_VOICES.find((v) => v.id === id)?.name ?? id;
		}
		return voicesStore.displayName(id);
	}

	const cueVoiceOptions = $derived(
		voicesForEngine(preferencesStore.ttsEngine, voicesStore.voices)
	);

	function flashRows(ids: string[]) {
		if (flashTimer) clearTimeout(flashTimer);
		flashIds = new Set(ids);
		flashTimer = setTimeout(() => {
			flashIds = new Set();
			flashTimer = null;
		}, 700);
	}

	function commitTimecode(cue: SubtitleCue, field: 'startMs' | 'endMs', raw: string) {
		const parsed = parseTimecode(raw, projectStore.current.fps);
		if (parsed === null) return;
		projectStore.updateCue(cue.id, { [field]: Math.round(parsed) });
	}

	function commitNumber(
		cueId: string,
		field: 'pitch' | 'speed' | 'volume',
		raw: string,
		fallback: number
	) {
		const value = Number(raw);
		if (Number.isNaN(value)) {
			projectStore.updateCue(cueId, { [field]: fallback });
			return;
		}
		if (field === 'pitch') {
			projectStore.updateCue(cueId, { pitch: Math.max(-12, Math.min(12, value)) });
			return;
		}
		if (field === 'speed') {
			projectStore.updateCue(cueId, { speed: Math.max(0.5, Math.min(2, value)) });
			return;
		}
		projectStore.updateCue(cueId, { volume: Math.max(0, Math.min(100, value)) });
	}

	function revealCueOnTimeline(cueId: string) {
		const clip = document.querySelector(
			`[data-slot="timeline-editor"] [data-clip][data-cue-id="${CSS.escape(cueId)}"]`
		);
		clip?.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'smooth' });
	}

	function onRowClick(e: MouseEvent, cueId: string) {
		const target = e.target as HTMLElement;
		if (
			target.closest(
				'input,button,select,[data-slot="checkbox"],[data-slot="select-trigger"],[data-drag-handle],[data-row-actions]'
			)
		) {
			return;
		}
		if (e.shiftKey) {
			projectStore.selectCueAt(cueId, { range: true });
		} else if (e.metaKey || e.ctrlKey) {
			projectStore.selectCueAt(cueId, { toggle: true });
		} else {
			projectStore.selectCueAt(cueId);
			// Table row select jumps playhead to cue start (timeline clip select does not).
			const cue = projectStore.current.cues.find((c) => c.id === cueId);
			if (cue) {
				setVisualPlayheadMs(cue.startMs, { seekMedia: true });
				projectStore.setPlayhead(cue.startMs);
			}
		}
		revealCueOnTimeline(cueId);
	}

	function togglePlayCue(cue: SubtitleCue) {
		projectStore.toggleCuePlayback(cue.id);
	}

	async function generateCue(cue: SubtitleCue) {
		projectStore.selectCueAt(cue.id);
		const n = await projectStore.generateCues([cue.id]);
		if (n > 0) {
			flashRows([cue.id]);
			if (!tempoStore.promptOverhangAfterTts()) {
				dndStore.flash(`Edge-TTS · cue #${cue.index}`);
			}
		} else if (projectStore.generateError) {
			dndStore.flash(projectStore.generateError);
		}
	}

	function deleteCue(cue: SubtitleCue) {
		if (projectStore.cueHasTtsAudio(cue)) {
			projectStore.clearTtsAudio([cue.id]);
			dndStore.flash(`Removed TTS · cue #${cue.index}`);
			return;
		}
		projectStore.deleteCues([cue.id]);
		dndStore.flash(`Deleted cue #${cue.index}`);
	}

	async function generateSelection() {
		const ids = [...projectStore.selectedCueIds];
		if (!ids.length) {
			dndStore.flash('Select a subtitle first');
			return;
		}
		const n = await projectStore.generateCues(ids);
		if (n > 0) {
			flashRows(ids);
			if (!tempoStore.promptOverhangAfterTts()) {
				dndStore.flash(
					n === 1 ? 'Edge-TTS generated' : `Edge-TTS ×${n} generated`
				);
			}
		} else if (projectStore.generateError) {
			dndStore.flash(projectStore.generateError);
		}
	}

	function deleteSelection() {
		const ids = [...projectStore.selectedCueIds];
		if (!ids.length) return;
		const withTts = ids.filter((id) => {
			const cue = projectStore.current.cues.find((c) => c.id === id);
			return cue != null && projectStore.cueHasTtsAudio(cue);
		});
		if (withTts.length) {
			const n = projectStore.clearTtsAudio(withTts);
			dndStore.flash(n === 1 ? 'Removed TTS audio' : `Removed TTS audio ×${n}`);
			return;
		}
		projectStore.deleteCues(ids);
		dndStore.flash(`Deleted ${ids.length} cue${ids.length === 1 ? '' : 's'}`);
	}

	function focusCueRow(id: string) {
		queueMicrotask(() => {
			const row = document.querySelector(
				`[data-slot="subtitle-table"] [data-cue-id="${CSS.escape(id)}"]`
			);
			row?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
			const textInput = row?.querySelector<HTMLInputElement>('input[data-field="translation"]');
			textInput?.focus();
			textInput?.select();
		});
		revealCueOnTimeline(id);
		flashRows([id]);
	}

	function addRow() {
		closeContextMenu();
		const id = projectStore.addCue();
		const cue = projectStore.current.cues.find((c) => c.id === id);
		dndStore.flash(cue ? `Added cue #${cue.index}` : 'Added cue');
		focusCueRow(id);
	}

	function addRowAbove(anchorId: string) {
		closeContextMenu();
		const id = projectStore.insertCueRelative(anchorId, 'above');
		if (!id) return;
		const cue = projectStore.current.cues.find((c) => c.id === id);
		dndStore.flash(cue ? `Added cue #${cue.index} above` : 'Added cue');
		focusCueRow(id);
	}

	function addRowBelow(anchorId: string) {
		closeContextMenu();
		const id = projectStore.insertCueRelative(anchorId, 'below');
		if (!id) return;
		const cue = projectStore.current.cues.find((c) => c.id === id);
		dndStore.flash(cue ? `Added cue #${cue.index} below` : 'Added cue');
		focusCueRow(id);
	}

	function deleteRowFromMenu(cueId: string) {
		closeContextMenu();
		const cue = projectStore.current.cues.find((c) => c.id === cueId);
		projectStore.deleteCues([cueId]);
		dndStore.flash(cue ? `Deleted cue #${cue.index}` : 'Deleted cue');
	}

	function setStartFromPlayhead(cueId?: string | null) {
		closeContextMenu();
		const id = cueId ?? primarySelectedId;
		if (!id) {
			dndStore.flash('Select a subtitle first');
			return;
		}
		if (!projectStore.setCueStartAtPlayhead(id)) {
			dndStore.flash('Couldn’t set start');
			return;
		}
		flashRows([id]);
		dndStore.flash('Start → playhead');
	}

	function setEndFromPlayhead(cueId?: string | null) {
		closeContextMenu();
		const id = cueId ?? primarySelectedId;
		if (!id) {
			dndStore.flash('Select a subtitle first');
			return;
		}
		if (!projectStore.setCueEndAtPlayhead(id)) {
			dndStore.flash('Couldn’t set end');
			return;
		}
		flashRows([id]);
		dndStore.flash('End → playhead');
	}

	function splitAtPlayhead(cueId?: string | null) {
		closeContextMenu();
		const id = cueId ?? primarySelectedId;
		if (!id) {
			dndStore.flash('Select a subtitle first');
			return;
		}
		const newId = projectStore.splitCueAtPlayhead(id);
		if (!newId) {
			dndStore.flash('Playhead must be inside the cue (min 200ms each side)');
			return;
		}
		flashRows([id, newId]);
		dndStore.flash('Split at playhead');
		focusCueRow(newId);
	}

	function mergeSelection() {
		closeContextMenu();
		if (selectedCount < 2) {
			dndStore.flash('Select 2+ subtitles to merge');
			return;
		}
		const ids = [...projectStore.selectedCueIds];
		const kept = projectStore.mergeSelectedCues();
		if (!kept) {
			dndStore.flash('Couldn’t merge selection');
			return;
		}
		flashRows([kept]);
		dndStore.flash(`Merged ${ids.length} cues`);
		focusCueRow(kept);
	}

	function snapToPlayhead(cueId?: string | null) {
		closeContextMenu();
		const id = cueId ?? primarySelectedId;
		if (!id) {
			dndStore.flash('Select a subtitle first');
			return;
		}
		if (!projectStore.snapCueToPlayhead(id)) {
			dndStore.flash('Couldn’t snap to playhead');
			return;
		}
		flashRows([id]);
		dndStore.flash('Snapped start → playhead');
	}

	function openContextMenu(e: MouseEvent, cueId: string | null) {
		e.preventDefault();
		e.stopPropagation();
		const pad = 8;
		const menuW = 250;
		const menuH = cueId ? 320 : 56;
		const x = Math.min(e.clientX, window.innerWidth - menuW - pad);
		const y = Math.min(e.clientY, window.innerHeight - menuH - pad);
		ctxMenu = { x: Math.max(pad, x), y: Math.max(pad, y), cueId };
		// Preserve multi-select when right-clicking an already-selected row.
		if (cueId && !projectStore.selectedCueIds.includes(cueId)) {
			projectStore.selectCueAt(cueId);
		}
	}

	/** Whole subtitle panel — capture so inputs/selects don't steal the browser menu. */
	function onWorkspaceContextMenu(e: MouseEvent) {
		const t = e.target as HTMLElement | null;
		if (!t) return;
		if (t.closest('[data-subtitle-ctx]')) return;
		const row = t.closest('[data-cue-id]');
		const fromRow = row?.getAttribute('data-cue-id') ?? null;
		// Empty workspace / gap: fall back to current selection so timing tools stay available.
		const cueId = fromRow ?? projectStore.selectedCueIds[0] ?? null;
		openContextMenu(e, cueId);
	}

	function closeContextMenu() {
		ctxMenu = null;
	}

	function onGlobalPointerDown(e: PointerEvent) {
		if (!ctxMenu) return;
		const t = e.target as HTMLElement | null;
		if (t?.closest('[data-subtitle-ctx]')) return;
		closeContextMenu();
	}

	function onLocalKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') closeContextMenu();
	}

	/** Keep the active (playhead) row visible while playing — only when the cue changes. */
	let lastActiveScrollId: string | null = null;
	$effect(() => {
		if (!playback.isPlaying) {
			lastActiveScrollId = null;
			return;
		}
		const ms = playback.playheadMs;
		const cue = projectStore.current.cues.find((c) => ms >= c.startMs && ms < c.endMs);
		const id = cue?.id ?? null;
		if (!id || id === lastActiveScrollId) return;
		lastActiveScrollId = id;
		const row = document.querySelector(
			`[data-slot="subtitle-table"] [data-cue-id="${CSS.escape(id)}"]`
		);
		// Instant scroll — smooth scroll every tick was janking video to ~0.5×.
		row?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
	});

	let rootEl: HTMLElement | undefined = $state();

	onMount(() => {
		const root = rootEl;
		root?.addEventListener('contextmenu', onWorkspaceContextMenu, true);
		window.addEventListener('keydown', onLocalKeydown);
		return () => {
			root?.removeEventListener('contextmenu', onWorkspaceContextMenu, true);
			window.removeEventListener('keydown', onLocalKeydown);
		};
	});

	onDestroy(() => {
		if (flashTimer) clearTimeout(flashTimer);
	});

	function playSelection() {
		const id = projectStore.selectedCueIds[0];
		if (!id) return;
		const cue = projectStore.current.cues.find((c) => c.id === id);
		if (cue) togglePlayCue(cue);
	}

	function edgeFromEvent(e: DragEvent, el: HTMLElement): DropEdge {
		if (dndStore.drag?.kind === 'tts-audio') return 'onto';
		const rect = el.getBoundingClientRect();
		return e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
	}

	function onCueDragStart(e: DragEvent, cue: SubtitleCue) {
		if (!e.dataTransfer) return;
		e.dataTransfer.effectAllowed = 'move';
		e.dataTransfer.setData(MIME_CUE_REORDER, cue.id);
		e.dataTransfer.setData('text/plain', cue.id);
		const blank = document.createElement('canvas');
		blank.width = 1;
		blank.height = 1;
		e.dataTransfer.setDragImage(blank, 0, 0);
		dndStore.start(
			{
				kind: 'cue-reorder',
				id: cue.id,
				label: `#${cue.index}`,
				subtitle: cue.translation
			},
			e.clientX,
			e.clientY
		);
	}

	function onRowDragOver(e: DragEvent, cue: SubtitleCue) {
		if (isFileDrag(e)) return;
		const types = e.dataTransfer?.types ? Array.from(e.dataTransfer.types) : [];
		const isReorder = types.includes(MIME_CUE_REORDER) || dndStore.drag?.kind === 'cue-reorder';
		const isAudio = types.includes(MIME_TTS_AUDIO) || dndStore.drag?.kind === 'tts-audio';
		if (!isReorder && !isAudio) return;

		e.preventDefault();
		e.stopPropagation();
		if (e.dataTransfer) e.dataTransfer.dropEffect = isAudio ? 'copy' : 'move';
		dndStore.move(e.clientX, e.clientY);
		const edge = edgeFromEvent(e, e.currentTarget as HTMLElement);
		if (isReorder && dndStore.drag?.id === cue.id) {
			dndStore.setDropTarget(null);
			return;
		}
		dndStore.setDropTarget({ cueId: cue.id, edge });
	}

	function onRowDragLeave(e: DragEvent, cueId: string) {
		const related = e.relatedTarget as Node | null;
		if (related && (e.currentTarget as HTMLElement).contains(related)) return;
		if (dndStore.dropTarget?.cueId === cueId) dndStore.setDropTarget(null);
	}

	function onRowDrop(e: DragEvent, cue: SubtitleCue) {
		if (isFileDrag(e)) return;
		e.preventDefault();
		e.stopPropagation();

		const reorderId = e.dataTransfer?.getData(MIME_CUE_REORDER);
		const audioId = e.dataTransfer?.getData(MIME_TTS_AUDIO);
		const edge = dndStore.dropTarget?.cueId === cue.id ? dndStore.dropTarget.edge : 'onto';

		if (audioId) {
			projectStore.assignAudioToCue(cue.id, audioId);
			flashRows([cue.id]);
			dndStore.flash(`Assigned TTS audio to cue #${cue.index}`);
		} else if (reorderId && reorderId !== cue.id) {
			const place = edge === 'after' ? 'after' : 'before';
			projectStore.reorderCues(reorderId, cue.id, place);
			flashRows([reorderId, cue.id]);
			dndStore.flash('Reordered cue');
		}

		dndStore.end();
	}

	function onDragEnd() {
		dndStore.end();
	}
</script>

<section
	bind:this={rootEl}
	class="flex h-full min-h-0 flex-col bg-transparent"
	data-slot="subtitle-table"
>
	<div class="panel-header gap-2">
		<span>Subtitle / Translation</span>
		<div class="flex min-w-0 flex-1 items-center justify-end gap-2 normal-case tracking-normal">
			{#if selectedCount > 0}
				<div class="subtitle-selection-bar" data-row-actions>
					<span class="hidden text-[10px] font-medium text-muted-foreground sm:inline">
						{selectedCount} selected
					</span>
					<Tooltip.Provider>
						<div class="flex items-center gap-0.5">
							<Tooltip.Root>
								<Tooltip.Trigger class="inline-flex">
									{#snippet child({ props })}
										<Button
											{...props}
											variant="secondary"
											size="icon-xs"
											aria-label="Set start from playhead"
											onclick={() => setStartFromPlayhead()}
										>
											<ArrowLeftToLine class="size-3.5" />
										</Button>
									{/snippet}
								</Tooltip.Trigger>
								<Tooltip.Content sideOffset={6}>Set Start from Playhead (A / [)</Tooltip.Content>
							</Tooltip.Root>
							<Tooltip.Root>
								<Tooltip.Trigger class="inline-flex">
									{#snippet child({ props })}
										<Button
											{...props}
											variant="secondary"
											size="icon-xs"
											aria-label="Set end from playhead"
											onclick={() => setEndFromPlayhead()}
										>
											<ArrowRightToLine class="size-3.5" />
										</Button>
									{/snippet}
								</Tooltip.Trigger>
								<Tooltip.Content sideOffset={6}>Set End from Playhead (S / ])</Tooltip.Content>
							</Tooltip.Root>
							<Tooltip.Root>
								<Tooltip.Trigger class="inline-flex">
									{#snippet child({ props })}
										<Button
											{...props}
											variant="secondary"
											size="icon-xs"
											aria-label="Split at playhead"
											disabled={!canSplitAtPlayhead}
											onclick={() => splitAtPlayhead()}
										>
											<Scissors class="size-3.5" />
										</Button>
									{/snippet}
								</Tooltip.Trigger>
								<Tooltip.Content sideOffset={6}>Split at Playhead (Ctrl+Enter)</Tooltip.Content>
							</Tooltip.Root>
							<Tooltip.Root>
								<Tooltip.Trigger class="inline-flex">
									{#snippet child({ props })}
										<Button
											{...props}
											variant="secondary"
											size="icon-xs"
											aria-label="Merge selected"
											disabled={!canMergeSelection}
											onclick={mergeSelection}
										>
											<Merge class="size-3.5" />
										</Button>
									{/snippet}
								</Tooltip.Trigger>
								<Tooltip.Content sideOffset={6}>Merge Selected (Ctrl+M)</Tooltip.Content>
							</Tooltip.Root>
							<Tooltip.Root>
								<Tooltip.Trigger class="inline-flex">
									{#snippet child({ props })}
										<Button
											{...props}
											variant="secondary"
											size="icon-xs"
											aria-label="Snap start to playhead"
											onclick={() => snapToPlayhead()}
										>
											<LocateFixed class="size-3.5" />
										</Button>
									{/snippet}
								</Tooltip.Trigger>
								<Tooltip.Content sideOffset={6}>Snap to Playhead (Ctrl+Shift+G)</Tooltip.Content>
							</Tooltip.Root>
							<Tooltip.Root>
								<Tooltip.Trigger class="inline-flex">
									{#snippet child({ props })}
										<Button
											{...props}
											variant="secondary"
											size="icon-xs"
											aria-label="Play first selected"
											onclick={playSelection}
										>
											<Play class="size-3.5" />
										</Button>
									{/snippet}
								</Tooltip.Trigger>
								<Tooltip.Content sideOffset={6}>Play</Tooltip.Content>
							</Tooltip.Root>
							<Tooltip.Root>
								<Tooltip.Trigger class="inline-flex">
									{#snippet child({ props })}
										<Button
											{...props}
											variant="secondary"
											size="icon-xs"
											class="text-primary"
											aria-label="Translate selected to Khmer"
											disabled={translationStore.isTranslating}
											onclick={() => translationStore.translateSelected()}
										>
											{#if translationStore.isTranslating}
												<Languages class="size-3.5 animate-pulse" />
											{:else}
												<Languages class="size-3.5" />
											{/if}
										</Button>
									{/snippet}
								</Tooltip.Trigger>
								<Tooltip.Content sideOffset={6}>Translate ZH → KM</Tooltip.Content>
							</Tooltip.Root>
							<Tooltip.Root>
								<Tooltip.Trigger class="inline-flex">
									{#snippet child({ props })}
										<Button
											{...props}
											variant="secondary"
											size="icon-xs"
											class="text-primary"
											aria-label="Generate selected"
											disabled={projectStore.isGenerating}
											onclick={generateSelection}
										>
											<Sparkles class="size-3.5" />
										</Button>
									{/snippet}
								</Tooltip.Trigger>
								<Tooltip.Content sideOffset={6}>Generate</Tooltip.Content>
							</Tooltip.Root>
							<Tooltip.Root>
								<Tooltip.Trigger class="inline-flex">
									{#snippet child({ props })}
										<Button
											{...props}
											variant="secondary"
											size="icon-xs"
											class="text-destructive hover:text-destructive"
											aria-label="Delete selected"
											onclick={deleteSelection}
										>
											<Trash2 class="size-3.5" />
										</Button>
									{/snippet}
								</Tooltip.Trigger>
								<Tooltip.Content sideOffset={6}>Delete</Tooltip.Content>
							</Tooltip.Root>
						</div>
					</Tooltip.Provider>
				</div>
			{:else}
				<span class="hidden text-[10px] text-muted-foreground sm:inline">
					A/[ in · S/] out · Ctrl+Enter split · Ctrl+M merge · Del delete · Ctrl+D dupe
				</span>
			{/if}

			<Tooltip.Provider>
				<Tooltip.Root>
					<Tooltip.Trigger class="inline-flex">
						{#snippet child({ props })}
							<Button
								{...props}
								variant="ghost"
								size="icon-xs"
								class="text-muted-foreground"
								aria-label="Add subtitle row"
								onclick={addRow}
							>
								<Plus class="size-3.5" />
							</Button>
						{/snippet}
					</Tooltip.Trigger>
					<Tooltip.Content sideOffset={6}>Add row (or right-click)</Tooltip.Content>
				</Tooltip.Root>
			</Tooltip.Provider>
		</div>
	</div>

	<ScrollArea class="subtitle-table-scroll min-h-0 flex-1">
		{#if projectStore.current.cues.length === 0}
			<div class="subtitle-empty" role="status">
				<div class="subtitle-empty-icon">
					<Captions class="size-5" />
				</div>
				<p class="subtitle-empty-title">No subtitle segments yet</p>
				<p class="subtitle-empty-sub">
					Right-click here or use Add first row to start timing {targetLangLabel} dialogue.
				</p>
				<Button variant="secondary" size="sm" class="mt-1 gap-1.5" onclick={addRow}>
					<Plus class="size-3.5" />
					Add first row
				</Button>
			</div>
		{:else}
			<Tooltip.Provider>
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div class="subtitle-table-workspace min-h-full min-w-[1360px]" role="presentation">
					<Table.Root>
						<Table.Header
							class="subtitle-table-header sticky top-0 z-10 border-b border-border/80 bg-card/98 shadow-[inset_0_-1px_0_color-mix(in_oklab,var(--border)_90%,transparent)] backdrop-blur-md"
						>
							<Table.Row class="hover:bg-transparent border-b-0">
								<Table.Head class="{headClass} w-8 px-1"></Table.Head>
								<Table.Head class="{headClass} w-9 px-2">
									<Checkbox
										checked={allSelected}
										indeterminate={someSelected}
										onCheckedChange={(checked) => projectStore.selectAllCues(checked === true)}
										aria-label="Select all cues"
									/>
								</Table.Head>
								<Table.Head class="{headClass} w-[7.5rem]">Start</Table.Head>
								<Table.Head class="{headClass} w-[7.5rem]">End</Table.Head>
								<Table.Head class="{headClass} w-28">Speaker</Table.Head>
								<Table.Head class="{headClass} min-w-[12rem] tracking-[0.06em]">Source</Table.Head>
								<Table.Head class="{headClass} min-w-[14rem] tracking-[0.06em]"
									>{targetLangLabel} Text</Table.Head
								>
								<Table.Head class="{headClass} w-20">Pitch</Table.Head>
								<Table.Head class="{headClass} w-20">Speed</Table.Head>
								<Table.Head class="{headClass} w-20">Volume</Table.Head>
								<Table.Head class="{headClass} w-36">Voice</Table.Head>
								<Table.Head class="{headClass} w-[7.5rem] px-1 text-center">Actions</Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each projectStore.current.cues as cue (cue.id)}
							{@const selected = projectStore.selectedCueIds.includes(cue.id)}
							{@const active =
								playback.playheadMs >= cue.startMs && playback.playheadMs < cue.endMs}
							{@const playing = projectStore.isCuePlaying(cue.id)}
							{@const hasTts = projectStore.cueHasTtsAudio(cue)}
							{@const isDragging = draggingCueId === cue.id}
							{@const isDropTarget = dropTarget?.cueId === cue.id}
							{@const dropEdge = isDropTarget ? dropTarget?.edge : null}
							{@const isFlash = flashIds.has(cue.id)}
							<Table.Row
								data-state={selected ? 'selected' : undefined}
								data-playing={playing ? 'true' : undefined}
								data-active={active ? 'true' : undefined}
								data-cue-id={cue.id}
								class={[
									'cue-row group relative border-l-4',
									selected ? 'cue-row-selected' : '',
									playing ? 'cue-row-playing' : active ? 'cue-row-active' : '',
									!selected && !active && !playing ? 'border-l-transparent' : '',
									isDragging ? 'cue-row-dragging' : '',
									isDropTarget && dropEdge === 'onto' ? 'cue-row-drop-onto' : '',
									audioDragActive && !isDragging ? 'cue-row-audio-ready' : '',
									isFlash ? 'cue-row-flash' : ''
								]
									.filter(Boolean)
									.join(' ')}
								onclick={(e) => onRowClick(e, cue.id)}
								ondragover={(e) => onRowDragOver(e, cue)}
								ondragleave={(e) => onRowDragLeave(e, cue.id)}
								ondrop={(e) => onRowDrop(e, cue)}
							>
								{#if isDropTarget && dropEdge === 'before'}
									<span class="cue-drop-line cue-drop-line-before"></span>
								{/if}
								{#if isDropTarget && dropEdge === 'after'}
									<span class="cue-drop-line cue-drop-line-after"></span>
								{/if}

								<Table.Cell class="cue-cell w-8 px-0.5">
									<button
										type="button"
										data-drag-handle
										class="cue-drag-handle"
										draggable="true"
										aria-label="Drag to reorder cue {cue.index}"
										title="Drag to reorder"
										ondragstart={(e) => onCueDragStart(e, cue)}
										ondrag={(e) => {
											if (e.clientX || e.clientY) dndStore.move(e.clientX, e.clientY);
										}}
										ondragend={onDragEnd}
										onclick={(e) => e.stopPropagation()}
									>
										<GripVertical class="size-3.5" />
									</button>
								</Table.Cell>

								<Table.Cell class="cue-cell px-2">
									<Checkbox
										checked={selected}
										onCheckedChange={(checked) =>
											projectStore.setCueSelected(cue.id, checked === true)}
										aria-label="Select cue {cue.index}"
									/>
								</Table.Cell>

								<Table.Cell class="cue-cell">
									<Input
										value={formatTimecode(cue.startMs, projectStore.current.fps)}
										class="{cellInput} text-primary/90"
										aria-label="Start timecode for cue {cue.index}"
										onblur={(e) =>
											commitTimecode(cue, 'startMs', (e.currentTarget as HTMLInputElement).value)}
										onkeydown={(e) => {
											if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
										}}
									/>
								</Table.Cell>

								<Table.Cell class="cue-cell">
									<Input
										value={formatTimecode(cue.endMs, projectStore.current.fps)}
										class="{cellInput} text-primary/90"
										aria-label="End timecode for cue {cue.index}"
										onblur={(e) =>
											commitTimecode(cue, 'endMs', (e.currentTarget as HTMLInputElement).value)}
										onkeydown={(e) => {
											if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
										}}
									/>
								</Table.Cell>

								<Table.Cell class="cue-cell">
									<Select.Root
										type="single"
										value={(cue.speaker || '').trim() || 'Speaker 1'}
										onValueChange={(v) => {
											if (v) projectStore.updateCue(cue.id, { speaker: v });
										}}
									>
										<Select.Trigger
											class="dense-input h-7 w-full min-w-[5.5rem] border-transparent bg-transparent px-1.5 text-xs shadow-none"
											aria-label="Speaker for cue {cue.index}"
										>
											{(cue.speaker || '').trim() || 'Speaker 1'}
										</Select.Trigger>
										<Select.Content>
											{#each speakerOptions as sp (sp)}
												<Select.Item value={sp} label={sp}>{sp}</Select.Item>
											{/each}
										</Select.Content>
									</Select.Root>
								</Table.Cell>

								<Table.Cell class="cue-cell">
									<Input
										value={cue.source}
										data-field="source"
										class="dense-input text-sm"
										lang={projectStore.current.sourceLanguage || 'zh'}
										spellcheck={false}
										autocomplete="off"
										aria-label="Source text for cue {cue.index}"
										title={cue.source}
										oninput={(e) =>
											projectStore.updateCue(cue.id, {
												source: (e.currentTarget as HTMLInputElement).value
											})}
									/>
								</Table.Cell>

								<Table.Cell class="cue-cell">
									<div class="flex min-w-0 flex-col gap-1">
										<Input
											value={cue.translation}
											data-field="translation"
											class={translationUsesKhmer ? 'khmer-edit font-khmer' : 'dense-input text-sm'}
											lang={targetLang}
											spellcheck={targetLang === 'en'}
											autocomplete="off"
											aria-label="{targetLangLabel} translation for cue {cue.index}"
											oninput={(e) =>
												projectStore.updateCue(cue.id, {
													translation: (e.currentTarget as HTMLInputElement).value
												})}
										/>
										{#if cue.assignedAudio || cue.status === 'generated'}
											<span class="audio-chip" class:audio-chip-generated={cue.status === 'generated'}>
												<AudioLines class="size-2.5 shrink-0" />
												{#if cue.status === 'generated'}
													Generated
													{#if cue.assignedAudio?.label}
														· {cue.assignedAudio.label}
													{/if}
												{:else}
													{cue.assignedAudio?.label}
												{/if}
											</span>
										{/if}
									</div>
								</Table.Cell>

								<Table.Cell class="cue-cell">
									<Input
										type="number"
										step="1"
										min="-12"
										max="12"
										value={cue.pitch}
										class={cellInput}
										aria-label="Pitch for cue {cue.index}"
										onblur={(e) =>
											commitNumber(
												cue.id,
												'pitch',
												(e.currentTarget as HTMLInputElement).value,
												cue.pitch
											)}
										onkeydown={(e) => {
											if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
										}}
									/>
								</Table.Cell>

								<Table.Cell class="cue-cell">
									<Input
										type="number"
										step="0.05"
										min="0.5"
										max="2"
										value={cue.speed}
										class={cellInput}
										aria-label="Speed for cue {cue.index}"
										onblur={(e) =>
											commitNumber(
												cue.id,
												'speed',
												(e.currentTarget as HTMLInputElement).value,
												cue.speed
											)}
										onkeydown={(e) => {
											if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
										}}
									/>
								</Table.Cell>

								<Table.Cell class="cue-cell">
									<Input
										type="number"
										step="1"
										min="0"
										max="100"
										value={cue.volume}
										class={cellInput}
										aria-label="Volume for cue {cue.index}"
										onblur={(e) =>
											commitNumber(
												cue.id,
												'volume',
												(e.currentTarget as HTMLInputElement).value,
												cue.volume
											)}
										onkeydown={(e) => {
											if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
										}}
									/>
								</Table.Cell>

								<Table.Cell class="cue-cell">
									<Select.Root
										type="single"
										value={cue.voiceId}
										onValueChange={(value) => {
											if (value) projectStore.updateCue(cue.id, { voiceId: value });
										}}
									>
										<Select.Trigger
											size="sm"
											class="h-7 w-full border-transparent bg-transparent px-1.5 text-xs hover:bg-background/40"
											aria-label="Voice for cue {cue.index}"
										>
											<span class="truncate">{voiceName(cue.voiceId)}</span>
										</Select.Trigger>
										<Select.Content>
											{#each cueVoiceOptions as voice}
												<Select.Item
													value={voice.id}
													label="{voice.name} · {voice.gender === 'female'
														? 'Female'
														: voice.gender === 'male'
															? 'Male'
															: 'Neutral'}"
												>
													{voice.name} · {voice.gender === 'female'
														? 'Female'
														: voice.gender === 'male'
															? 'Male'
															: 'Neutral'}
												</Select.Item>
											{/each}
										</Select.Content>
									</Select.Root>
								</Table.Cell>

								<Table.Cell class="cue-cell w-[6.5rem] px-1">
									<div
										class="cue-actions"
										class:cue-actions-open={selected}
										data-row-actions
									>
										<Tooltip.Root>
											<Tooltip.Trigger class="inline-flex">
												{#snippet child({ props })}
													<Button
														{...props}
														variant={playing ? 'default' : 'ghost'}
														size="icon-xs"
														class={[
															playing
																? 'bg-emerald-500 text-white hover:bg-emerald-400 shadow-[0_0_0_1px_rgba(16,185,129,0.45)]'
																: hasTts
																	? 'text-emerald-600 hover:text-emerald-500 dark:text-emerald-400'
																	: ''
														].join(' ')}
														aria-label={playing
															? `Stop cue ${cue.index}`
															: hasTts
																? `Play TTS for cue ${cue.index}`
																: `Play cue ${cue.index}`}
														onclick={(e) => {
															e.stopPropagation();
															togglePlayCue(cue);
														}}
													>
														{#if playing}
															<Pause class="size-3.5 fill-current" />
														{:else}
															<Play class="size-3.5 fill-current" />
														{/if}
													</Button>
												{/snippet}
											</Tooltip.Trigger>
											<Tooltip.Content sideOffset={6}>
												{playing ? 'Stop' : hasTts ? 'Play TTS' : 'Play'}
											</Tooltip.Content>
										</Tooltip.Root>

										<Tooltip.Root>
											<Tooltip.Trigger class="inline-flex">
												{#snippet child({ props })}
													<Button
														{...props}
														variant="ghost"
														size="icon-xs"
														class="text-sky-600 hover:text-sky-500 dark:text-sky-400"
														aria-label="Translate cue {cue.index} to Khmer"
														disabled={translationStore.isTranslating}
														onclick={(e) => {
															e.stopPropagation();
															translationStore.translateCue(cue.id);
														}}
													>
														<Languages class="size-3.5" />
													</Button>
												{/snippet}
											</Tooltip.Trigger>
											<Tooltip.Content sideOffset={6}>Translate line</Tooltip.Content>
										</Tooltip.Root>

										{#if selected}
											<Tooltip.Root>
												<Tooltip.Trigger class="inline-flex">
													{#snippet child({ props })}
														<Button
															{...props}
															variant="ghost"
															size="icon-xs"
															class="text-primary"
															aria-label="Generate cue {cue.index}"
															disabled={projectStore.isGenerating}
															onclick={(e) => {
																e.stopPropagation();
																generateCue(cue);
															}}
														>
															<Sparkles class="size-3.5" />
														</Button>
													{/snippet}
												</Tooltip.Trigger>
												<Tooltip.Content sideOffset={6}>Generate</Tooltip.Content>
											</Tooltip.Root>
											<Tooltip.Root>
												<Tooltip.Trigger class="inline-flex">
													{#snippet child({ props })}
														<Button
															{...props}
															variant="ghost"
															size="icon-xs"
															class="text-destructive hover:text-destructive"
															aria-label="Delete cue {cue.index}"
															onclick={(e) => {
																e.stopPropagation();
																deleteCue(cue);
															}}
														>
															<Trash2 class="size-3.5" />
														</Button>
													{/snippet}
												</Tooltip.Trigger>
												<Tooltip.Content sideOffset={6}>Delete</Tooltip.Content>
											</Tooltip.Root>
										{/if}
									</div>
								</Table.Cell>
							</Table.Row>
						{/each}
						</Table.Body>
					</Table.Root>
				</div>
			</Tooltip.Provider>
		{/if}
	</ScrollArea>

	{#if ctxMenu}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<div
			class="subtitle-ctx-backdrop"
			role="presentation"
			onclick={closeContextMenu}
			oncontextmenu={(e) => {
				e.preventDefault();
				closeContextMenu();
			}}
		></div>
		<div
			class="subtitle-ctx-menu"
			data-subtitle-ctx
			style="left: {ctxMenu.x}px; top: {ctxMenu.y}px;"
			role="menu"
			aria-label="Subtitle row actions"
		>
			{#if ctxMenu.cueId}
				<button
					type="button"
					class="subtitle-ctx-item"
					role="menuitem"
					onclick={() => setStartFromPlayhead(ctxMenu?.cueId)}
				>
					<ArrowLeftToLine class="size-3.5 opacity-80" />
					<span class="subtitle-ctx-label">Set Start from Playhead</span>
					<span class="subtitle-ctx-kbd">A / [</span>
				</button>
				<button
					type="button"
					class="subtitle-ctx-item"
					role="menuitem"
					onclick={() => setEndFromPlayhead(ctxMenu?.cueId)}
				>
					<ArrowRightToLine class="size-3.5 opacity-80" />
					<span class="subtitle-ctx-label">Set End from Playhead</span>
					<span class="subtitle-ctx-kbd">S / ]</span>
				</button>
				<button
					type="button"
					class="subtitle-ctx-item"
					role="menuitem"
					disabled={!canSplitCue(ctxMenu.cueId)}
					onclick={() => splitAtPlayhead(ctxMenu?.cueId)}
				>
					<Scissors class="size-3.5 opacity-80" />
					<span class="subtitle-ctx-label">Split at Playhead</span>
					<span class="subtitle-ctx-kbd">Ctrl+Enter</span>
				</button>
				<button
					type="button"
					class="subtitle-ctx-item"
					role="menuitem"
					disabled={!canMergeSelection}
					onclick={mergeSelection}
				>
					<Merge class="size-3.5 opacity-80" />
					<span class="subtitle-ctx-label">Merge Selected</span>
					<span class="subtitle-ctx-kbd">Ctrl+M</span>
				</button>
				<button
					type="button"
					class="subtitle-ctx-item"
					role="menuitem"
					onclick={() => snapToPlayhead(ctxMenu?.cueId)}
				>
					<LocateFixed class="size-3.5 opacity-80" />
					<span class="subtitle-ctx-label">Snap to Playhead</span>
					<span class="subtitle-ctx-kbd">Ctrl+⇧G</span>
				</button>
				<div class="subtitle-ctx-sep" role="separator"></div>
				<button
					type="button"
					class="subtitle-ctx-item"
					role="menuitem"
					onclick={() => ctxMenu?.cueId && addRowAbove(ctxMenu.cueId)}
				>
					<ArrowUpToLine class="size-3.5 opacity-80" />
					<span class="subtitle-ctx-label">Add Row Above</span>
				</button>
				<button
					type="button"
					class="subtitle-ctx-item"
					role="menuitem"
					onclick={() => ctxMenu?.cueId && addRowBelow(ctxMenu.cueId)}
				>
					<ArrowDownToLine class="size-3.5 opacity-80" />
					<span class="subtitle-ctx-label">Add Row Below</span>
				</button>
				<div class="subtitle-ctx-sep" role="separator"></div>
				<button
					type="button"
					class="subtitle-ctx-item subtitle-ctx-danger"
					role="menuitem"
					onclick={() => ctxMenu?.cueId && deleteRowFromMenu(ctxMenu.cueId)}
				>
					<Trash2 class="size-3.5 opacity-80" />
					<span class="subtitle-ctx-label">Delete Row</span>
				</button>
			{:else}
				<button
					type="button"
					class="subtitle-ctx-item"
					role="menuitem"
					onclick={addRow}
				>
					<Plus class="size-3.5 opacity-80" />
					<span class="subtitle-ctx-label">Add Row</span>
				</button>
			{/if}
		</div>
	{/if}
</section>

<svelte:window onpointerdown={onGlobalPointerDown} />

<style>
	:global([data-slot='subtitle-table'] .subtitle-table-scroll [data-slot='scroll-area-viewport']) {
		display: flex;
		flex-direction: column;
	}

	:global(
		[data-slot='subtitle-table'] .subtitle-table-scroll [data-slot='scroll-area-viewport'] > div
	) {
		min-height: 100%;
		flex: 1;
	}

	.subtitle-table-workspace {
		min-height: 100%;
	}

	.subtitle-ctx-backdrop {
		position: fixed;
		inset: 0;
		z-index: 80;
	}

	.subtitle-ctx-menu {
		position: fixed;
		z-index: 90;
		min-width: 15.5rem;
		padding: 0.3rem;
		border-radius: 0.55rem;
		border: 1px solid color-mix(in oklab, var(--border) 88%, var(--primary) 10%);
		background: color-mix(in oklab, var(--popover, var(--card)) 96%, transparent);
		box-shadow: var(--elevation-float, 0 12px 40px oklch(0 0 0 / 28%));
		backdrop-filter: blur(10px);
		animation: subtitle-ctx-in 120ms var(--motion-ease-out, ease-out);
	}

	@keyframes subtitle-ctx-in {
		from {
			opacity: 0;
			transform: scale(0.98) translateY(-2px);
		}
		to {
			opacity: 1;
			transform: none;
		}
	}

	.subtitle-ctx-item {
		display: flex;
		width: 100%;
		align-items: center;
		gap: 0.55rem;
		border: none;
		border-radius: 0.35rem;
		background: transparent;
		padding: 0.45rem 0.55rem;
		font-size: 0.75rem;
		font-weight: 500;
		color: var(--foreground);
		text-align: left;
		cursor: pointer;
	}

	.subtitle-ctx-label {
		flex: 1;
		min-width: 0;
	}

	.subtitle-ctx-kbd {
		flex-shrink: 0;
		font-family: var(--font-mono);
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.02em;
		color: var(--muted-foreground);
		opacity: 0.85;
	}

	.subtitle-ctx-item:hover,
	.subtitle-ctx-item:focus-visible {
		background: var(--interact-hover, color-mix(in oklab, var(--muted) 80%, transparent));
		outline: none;
	}

	.subtitle-ctx-item:disabled {
		cursor: not-allowed;
		opacity: 0.42;
	}

	.subtitle-ctx-item:disabled:hover {
		background: transparent;
	}

	.subtitle-ctx-danger {
		color: var(--destructive);
	}

	.subtitle-ctx-danger:hover,
	.subtitle-ctx-danger:focus-visible {
		background: color-mix(in oklab, var(--destructive) 12%, transparent);
	}

	.subtitle-ctx-sep {
		height: 1px;
		margin: 0.25rem 0.35rem;
		background: color-mix(in oklab, var(--border) 90%, transparent);
	}

	.subtitle-empty {
		display: flex;
		min-height: 14rem;
		height: 100%;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		padding: 2rem 1.25rem;
		text-align: center;
	}

	.subtitle-empty-icon {
		display: grid;
		place-items: center;
		width: 2.5rem;
		height: 2.5rem;
		border-radius: 0.65rem;
		border: 1px solid color-mix(in oklab, var(--border) 80%, var(--primary) 15%);
		background: color-mix(in oklab, var(--card) 70%, var(--primary) 6%);
		color: color-mix(in oklab, var(--primary) 75%, var(--foreground));
		margin-bottom: 0.25rem;
	}

	.subtitle-empty-title {
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--foreground);
	}

	.subtitle-empty-sub {
		max-width: 18rem;
		font-size: 0.75rem;
		line-height: 1.45;
		color: var(--muted-foreground);
	}

	:global(.subtitle-table-header) {
		background: linear-gradient(
			180deg,
			color-mix(in oklab, var(--surface-table-header) 92%, var(--primary) 4%),
			var(--surface-recessed)
		);
		border-bottom: 1px solid color-mix(in oklab, var(--border) 92%, var(--primary) 10%);
		box-shadow:
			inset 0 1px 0 color-mix(in oklab, var(--card) 55%, transparent),
			0 1px 0 color-mix(in oklab, var(--foreground) 4%, transparent);
	}

	:global(.dark .subtitle-table-header) {
		background: linear-gradient(
			180deg,
			oklch(0.2 0.04 265 / 96%),
			oklch(0.17 0.036 263 / 96%)
		);
		border-bottom-color: color-mix(in oklab, var(--border) 90%, transparent);
		box-shadow:
			inset 0 1px 0 oklch(1 0 0 / 4%),
			inset 0 -1px 0 oklch(0.78 0.04 280 / 18%);
	}

	:global(.subtitle-table-header th) {
		color: color-mix(in oklab, var(--foreground) 88%, var(--primary) 6%);
	}

	:global(.dark .subtitle-table-header th) {
		color: color-mix(in oklab, var(--foreground) 82%, var(--primary) 8%);
	}

	.subtitle-selection-bar {
		display: inline-flex;
		align-items: center;
		gap: 0.45rem;
		border-radius: 0.5rem;
		border: 1px solid color-mix(in oklab, var(--primary) 22%, var(--border));
		background: color-mix(in oklab, var(--card) 88%, var(--primary) 5%);
		padding: 0.15rem 0.35rem 0.15rem 0.55rem;
		box-shadow:
			inset 0 1px 0 color-mix(in oklab, white 20%, transparent),
			0 0 0 1px color-mix(in oklab, var(--primary) 6%, transparent);
		animation: selection-bar-in var(--motion-fast) var(--motion-ease-out);
	}

	:global(.dark) .subtitle-selection-bar {
		background: color-mix(in oklab, var(--card) 70%, var(--primary) 10%);
		border-color: color-mix(in oklab, var(--primary) 28%, var(--border));
		box-shadow:
			inset 0 1px 0 oklch(1 0 0 / 4%),
			0 0 16px color-mix(in oklab, var(--primary) 10%, transparent);
	}

	:global(.cue-row .cue-cell) {
		padding-block: 0.38rem;
		vertical-align: middle;
	}

	.cue-drag-handle {
		display: grid;
		width: 1.25rem;
		height: 1.55rem;
		place-items: center;
		border: none;
		border-radius: 0.35rem;
		background: transparent;
		color: color-mix(in oklab, var(--muted-foreground) 70%, transparent);
		cursor: grab;
		opacity: 0.28;
		transition:
			opacity var(--motion-fast) var(--motion-ease),
			background-color var(--motion-fast) var(--motion-ease),
			color var(--motion-fast) var(--motion-ease),
			transform var(--motion-fast) var(--motion-spring),
			box-shadow var(--motion-fast) var(--motion-ease);
	}

	.cue-drag-handle:hover,
	:global(.cue-row:hover) .cue-drag-handle,
	:global(.cue-row-selected) .cue-drag-handle {
		opacity: 0.95;
		color: var(--muted-foreground);
	}

	.cue-drag-handle:hover {
		background: var(--interact-hover);
		color: var(--foreground);
		box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--border) 60%, transparent);
	}

	.cue-drag-handle:active {
		cursor: grabbing;
		transform: scale(0.9);
		background: var(--interact-active);
	}

	:global(.khmer-edit) {
		height: auto !important;
		min-height: 2rem;
		border-radius: 0.45rem !important;
		border: 1px solid transparent !important;
		background: color-mix(in oklab, var(--background) 35%, transparent) !important;
		padding: 0.4rem 0.65rem !important;
		font-size: 0.875rem !important;
		line-height: 1.45 !important;
		box-shadow: none !important;
		transition:
			border-color var(--motion-fast) var(--motion-ease),
			background-color var(--motion-fast) var(--motion-ease),
			box-shadow var(--motion-base) var(--motion-ease) !important;
	}

	:global(.khmer-edit:hover) {
		background: var(--interact-hover) !important;
		border-color: color-mix(in oklab, var(--border) 55%, transparent) !important;
	}

	:global(.khmer-edit:focus-visible) {
		border-color: color-mix(in oklab, var(--primary) 50%, var(--ring)) !important;
		background: color-mix(in oklab, var(--card) 88%, var(--primary) 4%) !important;
		box-shadow:
			0 0 0 3px color-mix(in oklab, var(--primary) 18%, transparent),
			inset 0 1px 0 color-mix(in oklab, white 25%, transparent) !important;
	}

	:global(.dark .khmer-edit:focus-visible) {
		background: color-mix(in oklab, var(--card) 70%, var(--primary) 8%) !important;
		box-shadow:
			0 0 0 3px color-mix(in oklab, var(--primary) 22%, transparent),
			inset 0 1px 0 oklch(1 0 0 / 5%) !important;
	}

	.audio-chip {
		display: inline-flex;
		max-width: 100%;
		align-items: center;
		gap: 0.25rem;
		overflow: hidden;
		border-radius: 0.3rem;
		background: color-mix(in oklab, var(--primary) 12%, transparent);
		padding: 0.1rem 0.35rem;
		font-size: 9px;
		font-weight: 650;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--primary);
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.audio-chip-generated {
		background: color-mix(in oklab, var(--primary) 18%, transparent);
		box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--primary) 28%, transparent);
	}

	.cue-actions {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.1rem;
		min-height: 1.75rem;
		margin-inline: auto;
		border-radius: 0.45rem;
		padding: 0.1rem;
		transition:
			background-color var(--motion-base) var(--motion-ease),
			box-shadow var(--motion-base) var(--motion-ease),
			opacity var(--motion-fast) var(--motion-ease);
	}

	.cue-actions-open {
		background: color-mix(in oklab, var(--card) 80%, var(--primary) 6%);
		box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--border) 75%, transparent);
	}

	:global(.dark) .cue-actions-open {
		background: color-mix(in oklab, var(--card) 55%, var(--primary) 10%);
		box-shadow:
			inset 0 0 0 1px color-mix(in oklab, var(--primary) 22%, transparent),
			0 0 12px color-mix(in oklab, var(--primary) 10%, transparent);
	}

	:global(.cue-row-dragging) {
		opacity: 0.38 !important;
		transform: scale(0.982);
		filter: saturate(0.85);
	}

	:global(.cue-row-audio-ready) {
		box-shadow:
			inset 0 0 0 1px color-mix(in oklab, var(--primary) 14%, transparent),
			inset 0 0 0 9999px color-mix(in oklab, var(--primary) 3%, transparent);
		transition:
			box-shadow var(--motion-fast) var(--motion-ease),
			background-color var(--motion-fast) var(--motion-ease);
	}

	:global(.cue-row-drop-onto) {
		background: color-mix(in oklab, var(--primary) 14%, var(--card)) !important;
		box-shadow:
			inset 0 0 0 1.5px color-mix(in oklab, var(--primary) 48%, transparent),
			0 0 0 1px color-mix(in oklab, var(--primary) 20%, transparent),
			0 0 18px color-mix(in oklab, var(--primary) 14%, transparent);
		transform: scale(1.006);
	}

	:global(.dark .cue-row-drop-onto) {
		background: color-mix(in oklab, var(--primary) 18%, transparent) !important;
	}

	:global(.cue-row-flash) {
		animation: cue-drop-flash 680ms var(--motion-ease-out);
	}

	.cue-drop-line {
		position: absolute;
		left: 0.35rem;
		right: 0.35rem;
		z-index: 5;
		height: 2px;
		border-radius: 999px;
		background: var(--primary);
		box-shadow: 0 0 12px color-mix(in oklab, var(--primary) 50%, transparent);
		pointer-events: none;
		animation: drop-line-in var(--motion-fast) var(--motion-ease-out);
	}

	.cue-drop-line-before {
		top: -1px;
	}

	.cue-drop-line-after {
		bottom: -1px;
	}

	@keyframes drop-line-in {
		from {
			opacity: 0;
			transform: scaleX(0.85);
		}
		to {
			opacity: 1;
			transform: scaleX(1);
		}
	}

	@keyframes cue-drop-flash {
		0% {
			box-shadow:
				inset 0 0 0 9999px color-mix(in oklab, var(--primary) 0%, transparent),
				0 0 0 0 color-mix(in oklab, var(--primary) 0%, transparent);
		}
		35% {
			box-shadow:
				inset 0 0 0 9999px color-mix(in oklab, var(--primary) 16%, transparent),
				0 0 0 1px color-mix(in oklab, var(--primary) 35%, transparent);
		}
		100% {
			box-shadow:
				inset 0 0 0 9999px color-mix(in oklab, var(--primary) 0%, transparent),
				0 0 0 0 color-mix(in oklab, var(--primary) 0%, transparent);
		}
	}

	@keyframes selection-bar-in {
		from {
			opacity: 0;
			transform: translateY(-4px) scale(0.98);
		}
		to {
			opacity: 1;
			transform: translateY(0) scale(1);
		}
	}
</style>
