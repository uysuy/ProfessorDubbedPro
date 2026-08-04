<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
	import { Progress } from '$lib/components/ui/progress/index.js';
	import { Separator } from '$lib/components/ui/separator/index.js';
	import { Slider } from '$lib/components/ui/slider/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import { projectStore } from '$lib/stores/project.svelte';
	import { dndStore } from '$lib/stores/dnd.svelte';
	import { tempoStore } from '$lib/stores/tempo.svelte';
	import { transcriptionStore } from '$lib/stores/transcription.svelte';
	import { translationStore } from '$lib/stores/translation.svelte';
	import {
		preferencesStore,
		TRANSLATION_QUALITY_OPTIONS,
		type TranslationQuality
	} from '$lib/stores/preferences.svelte';
	import { translateProviderLabel } from '$lib/utils/translate';
	import { listSystemFonts, type SystemFontInfo } from '$lib/utils/system-fonts';
	import VideoPreview from '$lib/components/studio/VideoPreview.svelte';
	import {
		ClipboardPaste,
		Gauge,
		Languages,
		LoaderCircle,
		Mic2,
		PanelLeftClose,
		Scissors,
		Subtitles,
		Type,
		X
	} from '@lucide/svelte';
	import { onMount } from 'svelte';

	const videoTools = [
		{ id: 'trim', label: 'Trim', icon: Scissors },
		{ id: 'tempo', label: 'Tempo', icon: Gauge },
		{ id: 'subs', label: 'Extract Subs', icon: Subtitles }
	] as const;

	const dubTools = [
		{ id: 'translate', label: 'Translate', icon: Languages },
		{ id: 'script', label: 'Paste Script', icon: ClipboardPaste },
		{ id: 'voice', label: 'Clone Tone', icon: Mic2 }
	] as const;

	let resizing = $state(false);
	let startY = 0;
	let startHeight = 0;
	let scriptDraft = $state('');
	let scriptFeedback = $state<string | null>(null);
	let systemFonts = $state<SystemFontInfo[]>([]);
	let fontsLoading = $state(false);

	const subStyle = $derived(
		projectStore.current.subtitleStyle ?? {
			fontFamily: 'Noto Sans Khmer',
			fontFile: null,
			fontSizePx: 20,
			x: 0.5,
			y: 0.84,
			look: 'outline' as const,
			maxWidthPct: 0.96,
			outlineWidth: 1
		}
	);

	/** Clear paste-script draft when the open project changes (New / Open). */
	$effect(() => {
		const projectId = projectStore.current.id;
		void projectId;
		scriptDraft = '';
		scriptFeedback = null;
	});

	onMount(() => {
		fontsLoading = true;
		void listSystemFonts()
			.then((list) => {
				systemFonts = list;
			})
			.finally(() => {
				fontsLoading = false;
			});
	});

	function pickFont(family: string) {
		const hit = systemFonts.find((f) => f.family === family);
		projectStore.setSubtitleStyle({
			fontFamily: family,
			fontFile: hit?.path ?? null
		});
	}

	function setSubPreset(where: 'top' | 'middle' | 'bottom') {
		// Bottom = top edge of Khmer under typical CN/EN hardsubs (grows downward).
		const y = where === 'top' ? 0.08 : where === 'middle' ? 0.5 : 0.84;
		projectStore.setSubtitleStyle({ x: 0.5, y });
	}

	const translatorEngine = $derived(translateProviderLabel(translationStore.provider));
	const qualityLabel = $derived(
		preferencesStore.translationQuality === 'high' ? 'High Quality' : 'Fast'
	);
	const estimatedDurationMs = $derived(
		projectStore.current.durationMs > 0 && tempoStore.tempoFactor > 0
			? Math.round(projectStore.current.durationMs / tempoStore.tempoFactor)
			: 0
	);
	const fitToDubPlan = $derived(tempoStore.fitToDubPlan);

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

	function formatEstDuration(ms: number): string {
		if (ms <= 0) return '—';
		const totalSec = Math.round(ms / 1000);
		const m = Math.floor(totalSec / 60);
		const s = totalSec % 60;
		return `${m}:${String(s).padStart(2, '0')}`;
	}

	function applyPastedScript() {
		if (!projectStore.current.cues.length) {
			scriptFeedback = 'Extract subtitles first, then paste Khmer lines.';
			dndStore.flash(scriptFeedback);
			return;
		}
		const result = projectStore.applyScriptTranslations(scriptDraft);
		if (result.applied === 0) {
			scriptFeedback = 'No lines found. Paste one Khmer line per cue.';
			dndStore.flash(scriptFeedback);
			return;
		}
		const bits = [`Applied ${result.applied} line${result.applied === 1 ? '' : 's'}`];
		if (result.createdCues > 0) {
			bits.push(`created ${result.createdCues} cue${result.createdCues === 1 ? '' : 's'} for extra lines`);
		}
		if (result.unfilledCues > 0) bits.push(`${result.unfilledCues} cue(s) unchanged`);
		scriptFeedback = bits.join(' · ');
		dndStore.flash(`${scriptFeedback} — Generate TTS, then Fit video to dub if needed`);
		projectStore.setDubTool('script');
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
			<div
				class="mb-3 space-y-2 rounded-md border border-border/70 bg-card/80 p-2.5 shadow-[var(--elevation-panel)]"
			>
				<div class="flex items-center justify-between gap-2">
					<p class="flex items-center gap-1.5 text-[11px] font-semibold text-foreground">
						<Type class="size-3.5" />
						Subtitle style
					</p>
				</div>
				<div class="space-y-1">
					<p class="text-[10px] text-muted-foreground">Font (Windows list)</p>
					<Select.Root
						type="single"
						value={subStyle.fontFamily}
						onValueChange={(v) => {
							if (v) pickFont(v);
						}}
					>
						<Select.Trigger class="h-8 w-full text-[12px]" aria-label="Subtitle font">
							{fontsLoading ? 'Loading fonts…' : subStyle.fontFamily}
						</Select.Trigger>
						<Select.Content class="max-h-64">
							{#if systemFonts.length === 0}
								<Select.Item value="Noto Sans Khmer" label="Noto Sans Khmer"
									>Noto Sans Khmer</Select.Item
								>
								<Select.Item value="Khmer UI" label="Khmer UI">Khmer UI</Select.Item>
								<Select.Item value="Khmer OS" label="Khmer OS">Khmer OS</Select.Item>
							{:else}
								{#each systemFonts as font}
									<Select.Item value={font.family} label={font.family}
										>{font.family}</Select.Item
									>
								{/each}
							{/if}
						</Select.Content>
					</Select.Root>
				</div>
				<div class="space-y-1">
					<p class="text-[10px] text-muted-foreground">Look</p>
					<div class="grid grid-cols-2 gap-1">
						<button
							type="button"
							class="rounded border px-1.5 py-1 text-[10px] transition-colors
								{subStyle.look === 'outline'
								? 'border-primary/50 bg-primary/10 text-primary'
								: 'border-border/60 text-muted-foreground hover:text-foreground'}"
							onclick={() => projectStore.setSubtitleStyle({ look: 'outline' })}
						>
							Outline (no box)
						</button>
						<button
							type="button"
							class="rounded border px-1.5 py-1 text-[10px] transition-colors
								{subStyle.look === 'box'
								? 'border-primary/50 bg-primary/10 text-primary'
								: 'border-border/60 text-muted-foreground hover:text-foreground'}"
							onclick={() => projectStore.setSubtitleStyle({ look: 'box' })}
						>
							Background box
						</button>
					</div>
				</div>
				<div class="space-y-1">
					<div class="flex items-center justify-between gap-2">
						<p class="text-[10px] text-muted-foreground">Size</p>
						<span
							class="rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 font-mono text-[11px] font-semibold tabular-nums text-foreground"
							title="Design size at 720p height (preview & burn-in scale together)"
							>{Math.round(subStyle.fontSizePx)} px</span
						>
					</div>
					<Slider
						type="single"
						value={subStyle.fontSizePx}
						min={12}
						max={72}
						step={1}
						onValueChange={(v) => projectStore.setSubtitleStyle({ fontSizePx: v })}
						aria-label="Subtitle font size"
					/>
				</div>
				{#if subStyle.look === 'outline'}
					<div class="space-y-1">
						<div class="flex items-center justify-between gap-2">
							<p class="text-[10px] text-muted-foreground">Outline thickness</p>
							<span class="font-mono text-[10px] text-muted-foreground"
								>{(subStyle.outlineWidth ?? 1).toFixed(1)}</span
							>
						</div>
						<Slider
							type="single"
							value={subStyle.outlineWidth ?? 1}
							min={0}
							max={4}
							step={0.25}
							onValueChange={(v) => projectStore.setSubtitleStyle({ outlineWidth: v })}
							aria-label="Subtitle outline thickness"
						/>
					</div>
				{/if}
				<div class="flex flex-wrap gap-1">
					<button
						type="button"
						class="rounded border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
						onclick={() => setSubPreset('top')}
					>
						Top
					</button>
					<button
						type="button"
						class="rounded border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
						onclick={() => setSubPreset('middle')}
					>
						Middle
					</button>
					<button
						type="button"
						class="rounded border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
						onclick={() => setSubPreset('bottom')}
					>
						Bottom
					</button>
				</div>
				<p class="text-[10px] leading-snug text-muted-foreground">
					Bottom places the top of Khmer under the hardsubs — text grows down only.
					Drag on preview to fine-tune. Export matches this box.
				</p>
			</div>

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
						disabled={(transcriptionStore.isTranscribing && tool.id !== 'subs') ||
							(tempoStore.isRemastering && tool.id !== 'tempo')}
						onclick={() => onVideoToolClick(tool.id)}
					>
						{#if tool.id === 'subs' && transcriptionStore.isTranscribing}
							<LoaderCircle class="size-3.5 animate-spin" />
						{:else if tool.id === 'tempo' && tempoStore.isRemastering}
							<LoaderCircle class="size-3.5 animate-spin" />
						{:else}
							<tool.icon class="size-3.5" />
						{/if}
						{tool.id === 'subs' && transcriptionStore.isTranscribing
							? 'Extracting…'
							: tool.id === 'tempo' && tempoStore.isRemastering
								? 'Remastering…'
								: tool.label}
					</button>
				{/each}
			</div>

			<!-- Always show Tempo controls (not only when the chip is selected). -->
			<div
				class="mt-2 space-y-2 rounded-md border border-border/70 bg-card/80 p-2.5 shadow-[var(--elevation-panel)]"
			>
				<div class="flex items-center justify-between gap-2">
					<p class="text-[11px] font-semibold text-foreground">Tempo (pitch-safe)</p>
					<span class="font-mono text-[11px] font-medium text-primary"
						>{tempoStore.tempoFactor.toFixed(2)}×</span
					>
				</div>
				<Button
					size="sm"
					variant="secondary"
					class="w-full"
					disabled={tempoStore.isRemastering ||
						!fitToDubPlan ||
						fitToDubPlan.alreadyFits ||
						fitToDubPlan.tooExtreme ||
						(!projectStore.videoPath && !projectStore.videoFile)}
					onclick={() => {
						projectStore.setVideoTool('tempo');
						void tempoStore.fitToDub();
					}}
				>
					{#if tempoStore.isRemastering}
						<LoaderCircle class="size-3.5 animate-spin" />
						Fitting…
					{:else if fitToDubPlan && !fitToDubPlan.alreadyFits}
						Fit video to dub ({fitToDubPlan.tempo.toFixed(2)}×)
					{:else}
						Fit video to dub
					{/if}
				</Button>
				<p class="text-[10px] leading-snug text-muted-foreground">
					{#if !projectStore.videoPath && !projectStore.videoFile}
						Open a video first.
					{:else if !projectStore.current.cues.length}
						Generate / load subtitles & TTS first.
					{:else if fitToDubPlan?.alreadyFits}
						Video and dub lengths already match
						{#if tempoStore.mediaDurationMs > 0}
							<span class="font-mono"> ({formatEstDuration(tempoStore.mediaDurationMs)})</span>
						{/if}.
					{:else if fitToDubPlan?.tooExtreme}
						{#if fitToDubPlan.mode === 'shorten'}
							Video is too long vs dub (need ≤ 2×). Extend Khmer or trim the source.
						{:else}
							Dub is too long to stretch (need &lt; 2× video). Shorten Khmer lines.
						{/if}
					{:else if fitToDubPlan?.mode === 'shorten'}
						Speeds picture to match shorter Khmer TTS
						<span class="font-mono">
							({formatEstDuration(fitToDubPlan.videoMs)} → {formatEstDuration(fitToDubPlan.contentMs)})</span
						>
						— pitch-safe; cue times & TTS stay put.
					{:else if fitToDubPlan}
						Stretches picture to cover longer Khmer TTS
						<span class="font-mono">
							({formatEstDuration(fitToDubPlan.videoMs)} → {formatEstDuration(fitToDubPlan.contentMs)})</span
						>
						— keeps speech natural; cue times & TTS stay put.
					{:else}
						Waiting for video length / cues…
					{/if}
				</p>
				<Button
					size="sm"
					variant="outline"
					class="w-full"
					disabled={!projectStore.current.cues.some((c) => c.assignedAudio?.durationMs)}
					onclick={() => {
						const { pulledMs, changed } = projectStore.tightenCueGaps({
							maxGapMs: 100,
							hangPadMs: 40
						});
						if (!changed) {
							dndStore.flash('Gaps already tight');
							return;
						}
						dndStore.flash(
							`Tightened ${changed} cue${changed === 1 ? '' : 's'} · removed ~${Math.round(pulledMs / 1000)}s silence`
						);
					}}
				>
					Tighten silent gaps
				</Button>
				<p class="text-[10px] leading-snug text-muted-foreground">
					Packs Khmer TTS back-to-back (~0.1s breath). Use after Generate if long ASR pauses remain.
				</p>
				<Button
					size="sm"
					class="w-full"
					disabled={tempoStore.isRemastering ||
						Math.abs(tempoStore.tempoFactor - 1) < 0.001 ||
						(!projectStore.videoPath && !projectStore.videoFile)}
					onclick={() => {
						projectStore.setVideoTool('tempo');
						void tempoStore.apply();
					}}
				>
					{#if tempoStore.isRemastering}
						<LoaderCircle class="size-3.5 animate-spin" />
						Remastering…
					{:else}
						Apply pitch-safe slowdown
					{/if}
				</Button>
				<Slider
					type="single"
					value={tempoStore.tempoFactor}
					min={0.5}
					max={1}
					step={0.01}
					disabled={tempoStore.isRemastering}
					onValueChange={(v) => tempoStore.setTempoFactor(v)}
					aria-label="Pitch-safe tempo factor"
				/>
				<div class="flex flex-wrap gap-1">
					{#each tempoStore.presets as preset}
						<button
							type="button"
							class="rounded border border-border/60 px-1.5 py-0.5 font-mono text-[10px] transition-colors
								{Math.abs(tempoStore.tempoFactor - preset) < 0.001
								? 'border-primary/50 bg-primary/10 text-primary'
								: 'text-muted-foreground hover:text-foreground'}"
							disabled={tempoStore.isRemastering}
							onclick={() => tempoStore.setTempoFactor(preset)}
						>
							{preset.toFixed(2)}×
						</button>
					{/each}
				</div>
				<p class="text-[10px] leading-snug text-muted-foreground">
					Manual apply also stretches subtitle times. Prefer
					<span class="font-medium text-foreground/80"> Fit video to dub </span>
					to match picture length to Khmer TTS (stretch or shorten).
					{#if estimatedDurationMs > 0}
						<span class="font-mono"> Est. → {formatEstDuration(estimatedDurationMs)}</span>
					{/if}
				</p>
				{#if tempoStore.isRemastering || tempoStore.error}
					<div class="space-y-1.5">
						<div class="flex items-start justify-between gap-2">
							<p
								class="min-w-0 flex-1 text-[11px] font-medium leading-snug"
								class:text-destructive={Boolean(tempoStore.error) && !tempoStore.isRemastering}
								class:text-primary={tempoStore.isRemastering}
							>
								{tempoStore.isRemastering
									? tempoStore.message || 'Remastering…'
									: tempoStore.error}
							</p>
							{#if tempoStore.isRemastering}
								<Button
									variant="ghost"
									size="icon-xs"
									aria-label="Cancel tempo remaster"
									onclick={() => tempoStore.cancel()}
								>
									<X class="size-3.5" />
								</Button>
							{/if}
						</div>
						{#if tempoStore.isRemastering}
							<Progress value={tempoStore.progress} max={100} class="h-1.5" />
							<p class="font-mono text-[10px] text-muted-foreground">
								{tempoStore.progress}% · FFmpeg (pitch-safe)
							</p>
						{/if}
					</div>
				{/if}
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

			<!-- Paste Khmer script → match cues in order (skip auto Translate). -->
			<div
				class="mt-2 space-y-2 rounded-md border border-border/70 bg-card/80 p-2.5 shadow-[var(--elevation-panel)]"
			>
				<div class="flex items-center justify-between gap-2">
					<p class="text-[11px] font-semibold text-foreground">Paste Khmer script</p>
					<span class="font-mono text-[10px] text-muted-foreground"
						>{projectStore.current.cues.length} cues</span
					>
				</div>
				<textarea
					class="script-paste-area min-h-[7.5rem] w-full resize-y rounded-md border border-border/70 bg-background px-2 py-1.5 font-khmer text-[12px] leading-relaxed text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
					placeholder={"One Khmer line per subtitle cue…\n\nស្រីកំណាន់…\nប្រាក់បៀវត្ស…"}
					bind:value={scriptDraft}
					spellcheck="false"
				></textarea>
				<p class="text-[10px] leading-snug text-muted-foreground">
					One line → one cue (timeline order). Extra lines create new cues after the last ASR
					window. Clears old TTS — Generate, then Fit video to dub if lengths diverge.
				</p>
				<Button
					size="sm"
					class="w-full"
					disabled={!scriptDraft.trim() || !projectStore.current.cues.length}
					onclick={applyPastedScript}
				>
					<ClipboardPaste class="size-3.5" />
					Apply to cues in order
				</Button>
				{#if scriptFeedback}
					<p class="text-[10px] font-medium text-primary">{scriptFeedback}</p>
				{/if}
			</div>
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
