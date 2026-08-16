<script lang="ts">
	import { onMount } from 'svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Separator } from '$lib/components/ui/separator/index.js';
	import * as Tooltip from '$lib/components/ui/tooltip/index.js';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import WindowControls from '$lib/components/layout/WindowControls.svelte';
	import ThemeToggle from '$lib/components/layout/ThemeToggle.svelte';
	import { projectStore, playback } from '$lib/stores/project.svelte';
	import { autosaveStore } from '$lib/stores/autosave.svelte';
	import { studioUi } from '$lib/stores/studio-ui.svelte';
	import { languageLabel, normalizeDubLanguage } from '$lib/stores/preferences.svelte';
	import { dndStore } from '$lib/stores/dnd.svelte';
	import { transcriptionStore } from '$lib/stores/transcription.svelte';
	import { tempoStore } from '$lib/stores/tempo.svelte';
	import { importSrtFromDialog } from '$lib/utils/import-srt';
	import { detectPlatform, isTauriRuntime, type DesktopPlatform } from '$lib/utils/platform';
	import {
		Undo2,
		Redo2,
		Save,
		Download,
		Settings,
		FilePlus2,
		FolderOpen,
		ChevronDown
	} from '@lucide/svelte';

	interface Props {
		canUndo?: boolean;
		canRedo?: boolean;
		onUndo?: () => void;
		onRedo?: () => void;
		onNew?: () => void;
		onOpen?: () => void;
		onSave?: () => void;
		onExport?: () => void;
		onSettings?: () => void;
		onImportMedia?: () => void;
	}

	let {
		canUndo = true,
		canRedo = true,
		onUndo,
		onRedo,
		onNew,
		onOpen,
		onSave,
		onExport,
		onSettings,
		onImportMedia
	}: Props = $props();

	let editingName = $state(false);
	let draftName = $state('');
	let nameInput: HTMLInputElement | undefined = $state();
	let platform = $state<DesktopPlatform>('unknown');
	const showNativeChrome = $derived(isTauriRuntime());
	const macLayout = $derived(platform === 'macos');
	const isDirty = $derived(projectStore.isDirty);
	const autoSaveHint = $derived(autosaveStore.indicatorLabel);
	const sourceCode = $derived(
		(projectStore.current.sourceLanguage || 'en').toUpperCase().slice(0, 2)
	);
	const targetCode = $derived(
		normalizeDubLanguage(projectStore.current.targetLanguage).toUpperCase()
	);

	onMount(() => {
		platform = detectPlatform();
	});

	function startRename() {
		draftName = projectStore.current.name;
		editingName = true;
		queueMicrotask(() => nameInput?.focus());
	}

	function commitRename() {
		const next = draftName.trim();
		if (next) projectStore.renameProject(next);
		editingName = false;
	}

	function onNameKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			commitRename();
		}
		if (e.key === 'Escape') {
			editingName = false;
			queueMicrotask(() => (document.activeElement as HTMLElement | null)?.blur?.());
		}
	}

	async function onTitlebarDblClick(e: MouseEvent) {
		const target = e.target as HTMLElement | null;
		if (!target || target.closest('button, a, input, [role="button"], [data-no-drag]')) return;
		if (!isTauriRuntime()) return;
		try {
			const { getCurrentWindow } = await import('@tauri-apps/api/window');
			await getCurrentWindow().toggleMaximize();
		} catch {
			/* ignore */
		}
	}

	async function extractSubs() {
		projectStore.setVideoTool('subs');
		if (transcriptionStore.isTranscribing) return;
		await transcriptionStore.extractSubs();
	}

	function alignScript() {
		projectStore.setVideoTool('tempo');
		void tempoStore.fitToDub();
	}

	async function generateSelected() {
		if (!projectStore.selectedCueIds.length) {
			dndStore.flash('Select a subtitle first');
			return;
		}
		const n = await projectStore.generateSelected();
		if (n > 0) {
			const prompted = tempoStore.promptOverhangAfterTts();
			if (!prompted) dndStore.flash(n === 1 ? 'Audio generated' : `Audio generated ×${n}`);
		} else if (projectStore.generateError) {
			dndStore.flash(projectStore.generateError);
		}
	}
</script>

<header
	class="titlebar"
	class:titlebar-mac={macLayout && showNativeChrome}
	data-tauri-drag-region
	ondblclick={onTitlebarDblClick}
>
	{#if showNativeChrome && macLayout}
		<WindowControls />
	{/if}

	<a
		href="/"
		class="group flex shrink-0 items-center gap-2 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
		data-tauri-drag-region="false"
		data-no-drag
	>
		<img
			src="/app-icon.png"
			alt=""
			width="28"
			height="28"
			class="size-7 rounded-md shadow-[0_0_14px_oklch(0.62_0.12_200/25%)] ring-1 ring-border/60"
			draggable="false"
		/>
		<span class="hidden flex-col leading-none sm:flex">
			<span
				class="text-[13px] font-semibold tracking-wide text-foreground transition-colors group-hover:text-primary"
			>
				ProfessorDubbedPro
			</span>
			<span class="mt-0.5 text-[9px] tracking-[0.16em] text-muted-foreground uppercase"
				>Dubbing Studio</span
			>
		</span>
	</a>

	<Separator orientation="vertical" class="mx-0.5 hidden h-5 opacity-70 sm:block" />

	<div
		class="hidden shrink-0 items-center gap-0.5 md:flex"
		data-tauri-drag-region="false"
		data-no-drag
	>
		<DropdownMenu.Root>
			<DropdownMenu.Trigger
				class="inline-flex h-7 items-center gap-0.5 rounded-md px-2 text-[12px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
			>
				File <ChevronDown class="size-3 opacity-60" />
			</DropdownMenu.Trigger>
			<DropdownMenu.Content align="start" class="min-w-44">
				<DropdownMenu.Item onclick={() => onNew?.()}>New project</DropdownMenu.Item>
				<DropdownMenu.Item onclick={() => onOpen?.()}>Open…</DropdownMenu.Item>
				<DropdownMenu.Item onclick={() => onSave?.()}>Save</DropdownMenu.Item>
				<DropdownMenu.Separator />
				<DropdownMenu.Item onclick={() => onImportMedia?.()}>Import media…</DropdownMenu.Item>
				<DropdownMenu.Item onclick={() => onExport?.()}>Export…</DropdownMenu.Item>
				<DropdownMenu.Separator />
				<DropdownMenu.Item onclick={() => onSettings?.()}>Settings…</DropdownMenu.Item>
			</DropdownMenu.Content>
		</DropdownMenu.Root>

		<DropdownMenu.Root>
			<DropdownMenu.Trigger
				class="inline-flex h-7 items-center gap-0.5 rounded-md px-2 text-[12px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
			>
				Title Liver <ChevronDown class="size-3 opacity-60" />
			</DropdownMenu.Trigger>
			<DropdownMenu.Content align="start" class="min-w-48">
				<DropdownMenu.Item
					onclick={() => {
						studioUi.openTitleLiver();
						projectStore.addTitleLiverClip({ startMs: playback.playheadMs });
						dndStore.flash('Title Liver added at playhead');
					}}
					>Add at playhead…</DropdownMenu.Item
				>
				<DropdownMenu.Item onclick={() => studioUi.openTitleLiver()}
					>Open Title Liver…</DropdownMenu.Item
				>
			</DropdownMenu.Content>
		</DropdownMenu.Root>

		<DropdownMenu.Root>
			<DropdownMenu.Trigger
				class="inline-flex h-7 items-center gap-0.5 rounded-md px-2 text-[12px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
			>
				Subtitle <ChevronDown class="size-3 opacity-60" />
			</DropdownMenu.Trigger>
			<DropdownMenu.Content align="start" class="min-w-48">
				<DropdownMenu.Item onclick={() => studioUi.openSubtitle('paste')}
					>Paste script…</DropdownMenu.Item
				>
				<DropdownMenu.Item onclick={() => void importSrtFromDialog()}
					>Import SRT…</DropdownMenu.Item
				>
				<DropdownMenu.Item
					disabled={transcriptionStore.isTranscribing}
					onclick={() => void extractSubs()}>Extract Subs</DropdownMenu.Item
				>
				<DropdownMenu.Item onclick={() => studioUi.openSubtitle('translate')}
					>Translate…</DropdownMenu.Item
				>
				<DropdownMenu.Separator />
				<DropdownMenu.Item onclick={() => studioUi.openSubtitle('style')}
					>Style…</DropdownMenu.Item
				>
			</DropdownMenu.Content>
		</DropdownMenu.Root>

		<DropdownMenu.Root>
			<DropdownMenu.Trigger
				class="inline-flex h-7 items-center gap-0.5 rounded-md px-2 text-[12px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
			>
				Video <ChevronDown class="size-3 opacity-60" />
			</DropdownMenu.Trigger>
			<DropdownMenu.Content align="start" class="min-w-48">
				<DropdownMenu.Item
					disabled={tempoStore.isRemastering || !projectStore.current.cues.length}
					onclick={alignScript}>Align script ↔ video</DropdownMenu.Item
				>
				<DropdownMenu.Item onclick={() => studioUi.openTempo()}>Tempo…</DropdownMenu.Item>
				<DropdownMenu.Separator />
				<DropdownMenu.Item
					onclick={() => {
						projectStore.toggleOriginalAudioMute();
						dndStore.flash(
							projectStore.originalAudioMuted
								? 'Original audio muted'
								: 'Original audio unmuted'
						);
					}}
				>
					{projectStore.originalAudioMuted ? 'Unmute original audio' : 'Mute original audio'}
				</DropdownMenu.Item>
			</DropdownMenu.Content>
		</DropdownMenu.Root>

		<DropdownMenu.Root>
			<DropdownMenu.Trigger
				class="inline-flex h-7 items-center gap-0.5 rounded-md px-2 text-[12px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
			>
				Voice <ChevronDown class="size-3 opacity-60" />
			</DropdownMenu.Trigger>
			<DropdownMenu.Content align="start" class="min-w-48">
				<DropdownMenu.Item
					disabled={projectStore.isGenerating || !projectStore.selectedCueIds.length}
					onclick={() => void generateSelected()}>Generate selected</DropdownMenu.Item
				>
				<DropdownMenu.Item onclick={() => studioUi.openVoiceEngine()}
					>Engine & Speakers…</DropdownMenu.Item
				>
				<DropdownMenu.Item onclick={() => studioUi.openProsody()}>Prosody…</DropdownMenu.Item>
			</DropdownMenu.Content>
		</DropdownMenu.Root>
	</div>

	<Separator orientation="vertical" class="mx-0.5 hidden h-5 opacity-70 md:block" />

	<div class="min-w-0 flex-1" data-tauri-drag-region>
		{#if editingName}
			<input
				bind:this={nameInput}
				class="h-7 w-full max-w-md rounded-md border border-primary/45 bg-background/50 px-2 text-[13px] font-medium text-foreground outline-none ring-2 ring-primary/20"
				bind:value={draftName}
				onblur={commitRename}
				onkeydown={onNameKeydown}
				aria-label="Project name"
				data-tauri-drag-region="false"
				data-no-drag
			/>
		{:else}
			<button
				type="button"
				class="group/name flex max-w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-muted/60 focus-visible:bg-muted/60"
				onclick={startRename}
				title={isDirty ? 'Rename project (unsaved changes)' : 'Rename project'}
				data-tauri-drag-region="false"
				data-no-drag
			>
				{#if isDirty}
					<span
						class="shrink-0 text-[15px] leading-none text-amber-500"
						aria-label="Unsaved changes"
						title="Unsaved changes"
					>•</span
					>
				{/if}
				<span class="truncate text-[13px] font-medium text-foreground/95">
					{projectStore.current.name}
				</span>
				<span
					class="hidden shrink-0 rounded border border-border/70 bg-secondary/55 px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground sm:inline"
					title="{languageLabel(projectStore.current.sourceLanguage)} → {languageLabel(
						projectStore.current.targetLanguage
					)}"
				>
					{sourceCode} → {targetCode}
				</span>
			</button>
		{/if}
	</div>

	<Tooltip.Provider>
		<div class="flex shrink-0 items-center gap-1.5" data-tauri-drag-region="false" data-no-drag>
			<div class="toolbar-group">
				<Tooltip.Root>
					<Tooltip.Trigger
						class="inline-flex"
						onclick={() => onUndo?.()}
						disabled={!canUndo}
						aria-label="Undo"
					>
						<span
							class="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:bg-muted"
							class:opacity-40={!canUndo}
						>
							<Undo2 class="size-3.5" />
						</span>
					</Tooltip.Trigger>
					<Tooltip.Content sideOffset={6}>Undo</Tooltip.Content>
				</Tooltip.Root>

				<Tooltip.Root>
					<Tooltip.Trigger
						class="inline-flex"
						onclick={() => onRedo?.()}
						disabled={!canRedo}
						aria-label="Redo"
					>
						<span
							class="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:bg-muted"
							class:opacity-40={!canRedo}
						>
							<Redo2 class="size-3.5" />
						</span>
					</Tooltip.Trigger>
					<Tooltip.Content sideOffset={6}>Redo</Tooltip.Content>
				</Tooltip.Root>
			</div>

			<Separator orientation="vertical" class="mx-0.5 h-5 opacity-70" />

			<Tooltip.Root>
				<Tooltip.Trigger class="inline-flex">
					{#snippet child({ props })}
						<Button
							{...props}
							variant="ghost"
							size="icon-sm"
							aria-label="New project"
							class="size-7 text-muted-foreground hover:bg-muted hover:text-foreground"
							onclick={() => onNew?.()}
						>
							<FilePlus2 class="size-3.5" />
						</Button>
					{/snippet}
				</Tooltip.Trigger>
				<Tooltip.Content sideOffset={6}>New project</Tooltip.Content>
			</Tooltip.Root>

			<Tooltip.Root>
				<Tooltip.Trigger class="inline-flex">
					{#snippet child({ props })}
						<Button
							{...props}
							variant="ghost"
							size="icon-sm"
							aria-label="Open project"
							class="size-7 text-muted-foreground hover:bg-muted hover:text-foreground"
							onclick={() => onOpen?.()}
						>
							<FolderOpen class="size-3.5" />
						</Button>
					{/snippet}
				</Tooltip.Trigger>
				<Tooltip.Content sideOffset={6}>Open project</Tooltip.Content>
			</Tooltip.Root>

			<Tooltip.Root>
				<Tooltip.Trigger class="inline-flex">
					{#snippet child({ props })}
						<Button
							{...props}
							variant="outline"
							size="sm"
							class="h-7 gap-1.5 border-border/80 bg-secondary/45 px-2.5 text-xs text-foreground hover:bg-secondary"
							onclick={() => onSave?.()}
						>
							<Save class="size-3.5" />
							<span class="hidden md:inline">Save</span>
							{#if isDirty}
								<span class="text-amber-500 md:hidden" aria-hidden="true">•</span>
							{/if}
						</Button>
					{/snippet}
				</Tooltip.Trigger>
				<Tooltip.Content sideOffset={6}>
					{isDirty ? 'Save project (unsaved changes)' : 'Save project'}
				</Tooltip.Content>
			</Tooltip.Root>

			{#if autoSaveHint}
				<span
					class="hidden max-w-[7.5rem] truncate text-[10px] text-muted-foreground/90 sm:inline"
					aria-live="polite"
					title={autoSaveHint}
				>
					{autoSaveHint}
				</span>
			{/if}

			<Tooltip.Root>
				<Tooltip.Trigger class="inline-flex">
					{#snippet child({ props })}
						<Button
							{...props}
							size="sm"
							class="h-7 gap-1.5 border border-emerald-400/30 bg-emerald-500 px-2.5 text-xs font-semibold text-white shadow-[0_0_16px_oklch(0.72_0.17_155/22%)] hover:bg-emerald-400 hover:text-emerald-950"
							onclick={() => onExport?.()}
						>
							<Download class="size-3.5" />
							Export
						</Button>
					{/snippet}
				</Tooltip.Trigger>
				<Tooltip.Content sideOffset={6}>Export subtitles or video</Tooltip.Content>
			</Tooltip.Root>

			<Tooltip.Root>
				<Tooltip.Trigger class="inline-flex">
					{#snippet child({ props })}
						{#if onSettings}
							<Button
								{...props}
								variant="ghost"
								size="icon-sm"
								aria-label="Project settings"
								class="size-7 text-muted-foreground hover:bg-muted hover:text-foreground"
								onclick={() => onSettings?.()}
							>
								<Settings class="size-3.5" />
							</Button>
						{:else}
							<Button
								{...props}
								variant="ghost"
								size="icon-sm"
								aria-label="Settings"
								href="/settings"
								class="size-7 text-muted-foreground hover:bg-muted hover:text-foreground"
							>
								<Settings class="size-3.5" />
							</Button>
						{/if}
					{/snippet}
				</Tooltip.Trigger>
				<Tooltip.Content sideOffset={6}
					>{onSettings ? 'Project settings' : 'Settings'}</Tooltip.Content
				>
			</Tooltip.Root>

			<ThemeToggle />
		</div>
	</Tooltip.Provider>

	{#if showNativeChrome && !macLayout}
		<WindowControls />
	{/if}
</header>
