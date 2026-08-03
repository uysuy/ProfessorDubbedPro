<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
	import { Progress } from '$lib/components/ui/progress/index.js';
	import { Separator } from '$lib/components/ui/separator/index.js';
	import { projectStore } from '$lib/stores/project.svelte';
	import { transcriptionStore } from '$lib/stores/transcription.svelte';
	import { translationStore } from '$lib/stores/translation.svelte';
	import {
		preferencesStore,
		TRANSLATION_QUALITY_OPTIONS,
		type TranslationQuality
	} from '$lib/stores/preferences.svelte';
	import { translateProviderLabel } from '$lib/utils/translate';
	import VideoPreview from '$lib/components/studio/VideoPreview.svelte';
	import {
		Film,
		Languages,
		LoaderCircle,
		Mic2,
		PanelLeftClose,
		Scissors,
		Subtitles,
		WandSparkles,
		X
	} from '@lucide/svelte';

	const videoTools = [
		{ id: 'trim', label: 'Trim', icon: Scissors },
		{ id: 'crop', label: 'Crop', icon: Film },
		{ id: 'subs', label: 'Extract Subs', icon: Subtitles }
	] as const;

	const dubTools = [
		{ id: 'translate', label: 'Translate', icon: Languages },
		{ id: 'align', label: 'Align', icon: WandSparkles },
		{ id: 'voice', label: 'Clone Tone', icon: Mic2 }
	];

	let resizing = $state(false);
	let startY = 0;
	let startHeight = 0;

	const translatorEngine = $derived(translateProviderLabel(translationStore.provider));
	const qualityLabel = $derived(
		preferencesStore.translationQuality === 'high' ? 'High Quality' : 'Fast'
	);

	function onResizePointerDown(e: PointerEvent & { currentTarget: HTMLElement }) {
		e.preventDefault();
		resizing = true;
		startY = e.clientY;
		startHeight = projectStore.previewHeightPx;
		e.currentTarget.setPointerCapture(e.pointerId);
	}

	function onResizePointerMove(e: PointerEvent) {
		if (!resizing) return;
		const next = startHeight + (e.clientY - startY);
		projectStore.setPreviewHeight(next);
	}

	function onResizePointerUp(e: PointerEvent & { currentTarget: HTMLElement }) {
		if (!resizing) return;
		resizing = false;
		try {
			e.currentTarget.releasePointerCapture(e.pointerId);
		} catch {
			/* already released */
		}
	}

	async function onVideoToolClick(toolId: string) {
		projectStore.setVideoTool(toolId);
		if (toolId !== 'subs') return;
		if (transcriptionStore.isTranscribing) return;
		await transcriptionStore.extractSubs();
	}

	async function onDubToolClick(toolId: string) {
		projectStore.setDubTool(toolId);
		if (toolId !== 'translate') return;
		if (translationStore.isTranslating) return;
		await translationStore.translateSmart();
	}

	function setQuality(q: TranslationQuality) {
		preferencesStore.setTranslationQuality(q);
	}
</script>

<aside class="flex h-full min-h-0 flex-col bg-transparent text-sidebar-foreground">
	<div class="panel-header">
		<span>Video Preview</span>
		<Button
			variant="ghost"
			size="icon-xs"
			aria-label="Collapse left panel"
			onclick={() => projectStore.toggleLeft()}
		>
			<PanelLeftClose class="size-3.5" />
		</Button>
	</div>

	<div
		class="flex shrink-0 flex-col overflow-hidden border-b border-border/70"
		style="height: {projectStore.previewHeightPx}px;"
	>
		<VideoPreview class="h-full min-h-0" />
	</div>

	<button
		type="button"
		class="preview-resize-handle"
		class:preview-resize-handle-active={resizing}
		aria-label="Resize video preview height"
		onpointerdown={onResizePointerDown}
		onpointermove={onResizePointerMove}
		onpointerup={onResizePointerUp}
		onpointercancel={onResizePointerUp}
		onkeydown={(e) => {
			if (e.key === 'ArrowUp') {
				e.preventDefault();
				projectStore.setPreviewHeight(projectStore.previewHeightPx - 24);
			}
			if (e.key === 'ArrowDown') {
				e.preventDefault();
				projectStore.setPreviewHeight(projectStore.previewHeightPx + 24);
			}
		}}
	>
		<span class="preview-resize-grip" aria-hidden="true"></span>
	</button>

	<div class="min-h-0 flex-1 space-y-4 overflow-auto p-3">
		<section>
			<p class="mb-2 text-[11px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
				Video Tools
			</p>
			<div class="grid grid-cols-1 gap-1.5">
				{#each videoTools as tool}
					<button
						type="button"
						class="tool-chip justify-start gap-2 {projectStore.activeVideoTool === tool.id
							? 'tool-chip-active'
							: ''}"
						disabled={transcriptionStore.isTranscribing && tool.id !== 'subs'}
						onclick={() => onVideoToolClick(tool.id)}
					>
						{#if tool.id === 'subs' && transcriptionStore.isTranscribing}
							<LoaderCircle class="size-3.5 animate-spin" />
						{:else}
							<tool.icon class="size-3.5" />
						{/if}
						{tool.id === 'subs' && transcriptionStore.isTranscribing
							? 'Extracting…'
							: tool.label}
					</button>
				{/each}
			</div>

			{#if transcriptionStore.isTranscribing || transcriptionStore.error}
				<div
					class="mt-2 space-y-1.5 rounded-md border border-border/70 bg-card/80 p-2 shadow-[var(--elevation-panel)]"
				>
					<div class="flex items-start justify-between gap-2">
						<p
							class="min-w-0 flex-1 text-[11px] font-medium leading-snug"
							class:text-destructive={Boolean(transcriptionStore.error) &&
								!transcriptionStore.isTranscribing}
							class:text-primary={transcriptionStore.isTranscribing}
						>
							{transcriptionStore.isTranscribing
								? transcriptionStore.message || 'Transcribing…'
								: transcriptionStore.error}
						</p>
						{#if transcriptionStore.isTranscribing}
							<Button
								variant="ghost"
								size="icon-xs"
								aria-label="Cancel transcription"
								onclick={() => transcriptionStore.cancel()}
							>
								<X class="size-3.5" />
							</Button>
						{/if}
					</div>
					{#if transcriptionStore.isTranscribing}
						<Progress value={transcriptionStore.progress} max={100} class="h-1.5" />
						<p class="font-mono text-[10px] text-muted-foreground">
							{transcriptionStore.progress}% · {transcriptionStore.message.includes('FunASR') ||
							transcriptionStore.lastEngine === 'funasr'
								? 'FunASR'
								: transcriptionStore.lastEngine === 'whisper'
									? 'Whisper'
									: 'ASR'} (local)
						</p>
					{/if}
				</div>
			{/if}
		</section>

		<Separator />

		<section>
			<p class="mb-2 text-[11px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
				Dubbing Tools
			</p>

			<div class="mb-2 grid grid-cols-2 gap-1 rounded-md border border-border/60 bg-muted/20 p-0.5">
				{#each TRANSLATION_QUALITY_OPTIONS as opt (opt.value)}
					<button
						type="button"
						class="rounded px-1.5 py-1 text-[10px] font-medium transition-colors
							{preferencesStore.translationQuality === opt.value
							? 'bg-card text-foreground shadow-sm'
							: 'text-muted-foreground hover:text-foreground'}"
						disabled={translationStore.isTranslating}
						onclick={() => setQuality(opt.value)}
						title={opt.hint}
					>
						{opt.label}
					</button>
				{/each}
			</div>

			<div class="grid grid-cols-1 gap-1.5">
				{#each dubTools as tool}
					<button
						type="button"
						class="tool-chip justify-start gap-2 {projectStore.activeDubTool === tool.id
							? 'tool-chip-active'
							: ''}"
						disabled={translationStore.isTranslating && tool.id !== 'translate'}
						onclick={() => onDubToolClick(tool.id)}
					>
						{#if tool.id === 'translate' && translationStore.isTranslating}
							<LoaderCircle class="size-3.5 animate-spin" />
						{:else}
							<tool.icon class="size-3.5" />
						{/if}
						{tool.id === 'translate' && translationStore.isTranslating
							? 'Translating…'
							: tool.label}
					</button>
				{/each}
			</div>

			{#if translationStore.isTranslating || translationStore.error}
				<div
					class="mt-2 space-y-1.5 rounded-md border border-border/70 bg-card/80 p-2 shadow-[var(--elevation-panel)]"
				>
					<p
						class="min-w-0 text-[11px] font-medium leading-snug"
						class:text-destructive={Boolean(translationStore.error) &&
							!translationStore.isTranslating}
						class:text-primary={translationStore.isTranslating}
					>
						{translationStore.isTranslating
							? translationStore.message || 'Translating…'
							: translationStore.error}
					</p>
					{#if translationStore.isTranslating}
						<Progress value={translationStore.progress} max={100} class="h-1.5" />
						<p class="font-mono text-[10px] text-muted-foreground">
							{translationStore.progress}% · {qualityLabel} · {translatorEngine} · ZH → KM
						</p>
					{/if}
				</div>
			{/if}
		</section>
	</div>
</aside>

<style>
	.preview-resize-handle {
		display: flex;
		height: 0.55rem;
		width: 100%;
		flex-shrink: 0;
		cursor: row-resize;
		align-items: center;
		justify-content: center;
		border: none;
		border-bottom: 1px solid color-mix(in oklab, var(--border) 80%, transparent);
		border-radius: 0;
		padding: 0;
		background: color-mix(in oklab, var(--sidebar) 88%, var(--card));
		touch-action: none;
	}

	.preview-resize-handle:hover,
	.preview-resize-handle:focus-visible,
	.preview-resize-handle-active {
		background: color-mix(in oklab, var(--primary) 12%, var(--sidebar));
		outline: none;
	}

	.preview-resize-grip {
		width: 2.25rem;
		height: 0.2rem;
		border-radius: 999px;
		background: color-mix(in oklab, var(--muted-foreground) 45%, transparent);
	}

	.preview-resize-handle:hover .preview-resize-grip,
	.preview-resize-handle-active .preview-resize-grip {
		background: color-mix(in oklab, var(--primary) 70%, transparent);
	}
</style>
