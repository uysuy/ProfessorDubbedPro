<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
	import { Progress } from '$lib/components/ui/progress/index.js';
	import { projectStore } from '$lib/stores/project.svelte';
	import { tempoStore } from '$lib/stores/tempo.svelte';
	import { transcriptionStore } from '$lib/stores/transcription.svelte';
	import { studioUi } from '$lib/stores/studio-ui.svelte';
	import VideoPreview from '$lib/components/studio/VideoPreview.svelte';
	import {
		ClipboardPaste,
		Gauge,
		LoaderCircle,
		PanelLeftClose,
		Subtitles,
		X
	} from '@lucide/svelte';

	let resizing = $state(false);
	let startY = 0;
	let startHeight = 0;

	const fitToDubPlan = $derived(tempoStore.fitToDubPlan);

	function formatEstDuration(ms: number): string {
		if (ms <= 0) return '—';
		const totalSec = Math.round(ms / 1000);
		const m = Math.floor(totalSec / 60);
		const s = totalSec % 60;
		return `${m}:${String(s).padStart(2, '0')}`;
	}

	function onResizePointerDown(e: PointerEvent & { currentTarget: HTMLElement }) {
		e.preventDefault();
		resizing = true;
		startY = e.clientY;
		startHeight = projectStore.previewHeightPx;
		e.currentTarget.setPointerCapture(e.pointerId);
	}

	function onResizePointerMove(e: PointerEvent) {
		if (!resizing) return;
		projectStore.setPreviewHeight(startHeight + (e.clientY - startY));
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

	async function extractSubs() {
		projectStore.setVideoTool('subs');
		if (transcriptionStore.isTranscribing) return;
		await transcriptionStore.extractSubs();
	}

	function alignScript() {
		projectStore.setVideoTool('tempo');
		void tempoStore.fitToDub();
	}

	const alignDisabled = $derived(
		tempoStore.isRemastering ||
			(!projectStore.videoPath && !projectStore.videoFile) ||
			!projectStore.current.cues.length ||
			tempoStore.mediaDurationMs < 500 ||
			(!!fitToDubPlan?.alreadyFits &&
				tempoStore.dubOverhangMs <= 400 &&
				tempoStore.videoUnderhangMs <= 800 &&
				!tempoStore.hasOverhangPrompt)
	);
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

	<div class="min-h-0 flex-1 space-y-3 overflow-auto p-3">
		<section class="space-y-2">
			<p class="text-[11px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
				Pipeline
			</p>
			<p class="text-[10px] leading-snug text-muted-foreground">
				<span class="font-medium text-foreground/80">Extract → Paste → Generate → Align</span>
				· Style / Import / Tempo live under the top menus.
			</p>

			<div class="grid grid-cols-1 gap-1.5">
				<Button
					size="sm"
					variant="secondary"
					class="w-full justify-start gap-2"
					disabled={transcriptionStore.isTranscribing || tempoStore.isRemastering}
					onclick={() => void extractSubs()}
				>
					{#if transcriptionStore.isTranscribing}
						<LoaderCircle class="size-3.5 animate-spin" />
						Extracting…
					{:else}
						<Subtitles class="size-3.5" />
						1 · Extract Subs
					{/if}
				</Button>

				<Button
					size="sm"
					variant="secondary"
					class="w-full justify-start gap-2"
					onclick={() => studioUi.openSubtitle('paste')}
				>
					<ClipboardPaste class="size-3.5" />
					2 · Paste Script…
				</Button>

				<Button
					size="sm"
					class="w-full justify-start gap-2"
					disabled={alignDisabled}
					onclick={alignScript}
				>
					{#if tempoStore.isRemastering}
						<LoaderCircle class="size-3.5 animate-spin" />
						Aligning…
					{:else}
						<Gauge class="size-3.5" />
						{#if fitToDubPlan && !fitToDubPlan.alreadyFits}
							{#if fitToDubPlan.smartStrategy === 'overhang'}
								3 · Align (needs choice…)
							{:else if fitToDubPlan.tempo < 0.995}
								3 · Align ({fitToDubPlan.tempo.toFixed(2)}×)
							{:else}
								3 · Align script ↔ video
							{/if}
						{:else}
							3 · Align script ↔ video
						{/if}
					{/if}
				</Button>
			</div>

			<p class="text-[10px] leading-snug text-muted-foreground">
				{#if !projectStore.videoPath && !projectStore.videoFile}
					Open a video first.
				{:else if !projectStore.current.cues.length}
					Extract or Paste script, then Generate on the right, then Align.
				{:else if tempoStore.mediaDurationMs < 500}
					Waiting for video length (waveform)…
				{:else if fitToDubPlan?.alreadyFits}
					Khmer fits picture
					{#if tempoStore.mediaDurationMs > 0}
						<span class="font-mono"> ({formatEstDuration(tempoStore.mediaDurationMs)})</span>
					{/if}.
				{:else if fitToDubPlan?.smartStrategy === 'overhang'}
					Khmer runs past the video — Align, then choose extend / trim / manual.
				{:else if fitToDubPlan}
					{fitToDubPlan.summary ?? 'Align fits Khmer to picture anchors.'}
				{:else}
					Generate TTS, then Align if audio runs long.
				{/if}
			</p>

			{#if tempoStore.hasOverhangPrompt && tempoStore.overhangPlan}
				<div
					class="space-y-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 p-2"
					role="status"
				>
					<p class="text-[10px] font-medium leading-snug text-amber-950 dark:text-amber-100">
						Khmer runs
						<span class="font-mono"
							>{formatEstDuration(tempoStore.overhangPlan.overhangMs)}</span
						>
						past the video. Choose:
					</p>
					<div class="grid grid-cols-1 gap-1">
						<Button
							size="sm"
							variant="secondary"
							class="w-full text-[11px]"
							disabled={tempoStore.isRemastering}
							onclick={() => void tempoStore.resolveOverhangExtend()}
						>
							Auto-extend video (pitch-safe)
						</Button>
						<Button
							size="sm"
							variant="secondary"
							class="w-full text-[11px]"
							disabled={tempoStore.isRemastering}
							onclick={() => void tempoStore.resolveOverhangTrim()}
						>
							Auto-trim into picture
						</Button>
						<Button
							size="sm"
							variant="outline"
							class="w-full text-[11px]"
							disabled={tempoStore.isRemastering}
							onclick={() => tempoStore.resolveOverhangManual()}
						>
							Manual (edit timeline)
						</Button>
					</div>
				</div>
			{/if}

			{#if tempoStore.lastAlignResult && !tempoStore.isRemastering}
				<div
					class="rounded-md border border-border/60 bg-muted/30 px-2 py-1.5 font-mono text-[10px] leading-relaxed text-muted-foreground"
				>
					Video
					<span class="text-foreground"
						>{formatEstDuration(tempoStore.lastAlignResult.originalVideoMs)}</span
					>
					· Khmer
					<span class="text-foreground"
						>{formatEstDuration(tempoStore.lastAlignResult.khmerAudioMs)}</span
					>
					· {tempoStore.lastAlignResult.videoTempo.toFixed(2)}× · {tempoStore.lastAlignResult
						.strategy}
				</div>
			{/if}

			<button
				type="button"
				class="text-left text-[10px] text-primary underline-offset-2 hover:underline"
				onclick={() => studioUi.openTempo()}
			>
				Advanced Tempo…
			</button>
		</section>

		{#if transcriptionStore.isTranscribing || transcriptionStore.error}
			<div
				class="space-y-1.5 rounded-md border border-border/70 bg-card/80 p-2 shadow-[var(--elevation-panel)]"
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
						{transcriptionStore.progress}% · ASR
					</p>
				{/if}
			</div>
		{/if}
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
	.preview-resize-handle:focus-visible .preview-resize-grip,
	.preview-resize-handle-active .preview-resize-grip {
		background: color-mix(in oklab, var(--primary) 55%, transparent);
	}
</style>
