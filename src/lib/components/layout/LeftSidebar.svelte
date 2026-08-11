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
	import { ALIGN_BREATH_MS, ALIGN_HANG_PAD_MS } from '$lib/utils/cue-gaps';
	import { isTauriRuntime } from '$lib/utils/platform';
	import VideoPreview from '$lib/components/studio/VideoPreview.svelte';
	import {
		ClipboardPaste,
		FileText,
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
		{ id: 'speakers', label: 'Detect Speakers', icon: Mic2 }
	] as const;

	let resizing = $state(false);
	let startY = 0;
	let startHeight = 0;
	let scriptDraft = $state('');
	let scriptFeedback = $state<string | null>(null);
	/** When on, extra paste lines append cues after the video (old behavior). Default off = merge. */
	let createExtraCues = $state(true);
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
		(() => {
			const factor = tempoStore.tempoFactor;
			if (factor <= 0) return 0;
			const sourceMs =
				projectStore.sourceDurationMs ||
				(projectStore.current.durationMs > 0
					? Math.round(
							projectStore.current.durationMs *
								(projectStore.current.mediaTempoFromSource ?? 1)
						)
					: 0);
			return sourceMs > 0 ? Math.round(sourceMs / factor) : 0;
		})()
	);
	const appliedTempo = $derived(projectStore.current.mediaTempoFromSource ?? 1);
	const tempoApplyDisabled = $derived(
		tempoStore.isRemastering ||
			Math.abs(tempoStore.tempoFactor - appliedTempo) < 0.001 ||
			(!projectStore.videoPath &&
				!projectStore.videoFile &&
				!projectStore.sourceVideoPath &&
				!projectStore.sourceVideoFile)
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

	async function importSrtFromDialog() {
		if (transcriptionStore.isTranscribing || tempoStore.isRemastering) return;
		try {
			if (isTauriRuntime()) {
				const { open } = await import('@tauri-apps/plugin-dialog');
				const { readTextFile } = await import('@tauri-apps/plugin-fs');
				const selected = await open({
					multiple: false,
					filters: [{ name: 'SubRip subtitles', extensions: ['srt'] }]
				});
				const path = Array.isArray(selected) ? selected[0] : selected;
				if (!path || typeof path !== 'string') return;
				const raw = await readTextFile(path);
				const name = path.split(/[/\\]/).pop() || 'import.srt';
				const { count, khmer } = projectStore.importSrtText(raw, {
					replace: true,
					fileName: name
				});
				if (!count) {
					dndStore.flash('No cues found in that SRT file.');
					return;
				}
				dndStore.flash(
					khmer
						? `Imported ${count} Khmer cue${count === 1 ? '' : 's'} from ${name}`
						: `Imported ${count} cue${count === 1 ? '' : 's'} from ${name} — Paste Khmer or Translate next`
				);
				return;
			}

			const input = document.createElement('input');
			input.type = 'file';
			input.accept = '.srt,application/x-subrip,text/plain';
			input.onchange = async () => {
				const file = input.files?.[0];
				if (!file) return;
				const { count, khmer } = await projectStore.importSrtFile(file, { replace: true });
				if (!count) {
					dndStore.flash('No cues found in that SRT file.');
					return;
				}
				dndStore.flash(
					khmer
						? `Imported ${count} Khmer cue${count === 1 ? '' : 's'} from ${file.name}`
						: `Imported ${count} cue${count === 1 ? '' : 's'} from ${file.name} — Paste Khmer or Translate next`
				);
			};
			input.click();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			dndStore.flash(msg || 'Could not import SRT.');
		}
	}

	async function onDubToolClick(toolId: string) {
		projectStore.setDubTool(toolId);
		if (toolId === 'translate') {
			if (translationStore.isTranslating) return;
			await translationStore.translateSmart();
			return;
		}
		if (toolId === 'speakers') {
			if (projectStore.speakersDetecting) return;
			const n = await projectStore.detectSpeakers();
			if (n > 0) {
				dndStore.flash(
					n === 1
						? '1 speaker detected — voice locked for VoxCPM clone'
						: `${n} speakers detected — voices locked for VoxCPM clone`
				);
			} else if (projectStore.speakersError) {
				dndStore.flash(projectStore.speakersError);
			}
		}
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
		const extractCueCount = projectStore.current.cues.length;
		const result = projectStore.applyScriptTranslations(scriptDraft, {
			mergeExtraLines: extractCueCount > 0 && !createExtraCues,
			fitToExtractSpan: createExtraCues
		});
		if (result.applied === 0) {
			scriptFeedback =
				'No sentences found. Paste Khmer (one hardsub line per line).';
			dndStore.flash(scriptFeedback);
			return;
		}
		const bits: string[] = [];
		if (result.extractCueCount === 0) {
			bits.push(
				`Created ${result.cueCount} cue${result.cueCount === 1 ? '' : 's'} from script — drag/trim on the timeline to match the video, leave gaps for breath`
			);
		} else if (result.fittedToSpan) {
			bits.push(
				`Fitted ${result.sentenceCount} script line${result.sentenceCount === 1 ? '' : 's'} into Extract span (${extractCueCount} FunASR blob${extractCueCount === 1 ? '' : 's'} → ${result.cueCount} cues)`
			);
		} else {
			bits.push(
				`Mapped ${result.sentenceCount} sentence${result.sentenceCount === 1 ? '' : 's'} → ${extractCueCount} Extract cue${extractCueCount === 1 ? '' : 's'}`
			);
		}
		if (result.mergedExtraLines > 0) {
			bits.push(
				`merged ${result.mergedExtraLines} extra into ${extractCueCount} cues (opt-in)`
			);
		}
		if (!result.fittedToSpan && result.extractCueCount > 0 && result.createdCues > 0) {
			bits.push(
				`+${result.createdCues} extra cue${result.createdCues === 1 ? '' : 's'} for leftover sentences`
			);
		}
		if (result.unfilledCues > 0) {
			bits.push(`${result.unfilledCues} cue(s) left empty`);
		}
		const videoMs = tempoStore.mediaDurationMs;
		if (result.estimatedSpeechMs > 0 && videoMs > 500) {
			bits.push(
				`est. Khmer ~${formatEstDuration(result.estimatedSpeechMs)} vs video ${formatEstDuration(videoMs)}`
			);
		}
		scriptFeedback = bits.join(' · ');
		projectStore.stampPictureAnchorsOnly();
		dndStore.flash(
			`${scriptFeedback} — arrange periods, then Generate (audio stays inside each cue)`
		);
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
			<button
				type="button"
				class="tool-chip mt-1.5 w-full justify-start gap-2"
				disabled={transcriptionStore.isTranscribing || tempoStore.isRemastering}
				onclick={() => void importSrtFromDialog()}
			>
				<FileText class="size-3.5" />
				Import SRT…
			</button>
			<p class="mt-1 text-[10px] leading-snug text-muted-foreground">
				Optional. Prefer
				<span class="font-medium text-foreground/80">Extract → Paste → Generate → Align</span>.
				Import only when you already have hardsub-accurate timings (better than FunASR line breaks).
			</p>

			<!-- Always show Tempo controls (not only when the chip is selected). -->
			<div
				class="mt-2 space-y-2 rounded-md border border-border/70 bg-card/80 p-2.5 shadow-[var(--elevation-panel)]"
			>
				<div class="flex items-center justify-between gap-2">
					<p class="text-[11px] font-semibold text-foreground">Tempo (pitch-safe)</p>
					<span class="font-mono text-[11px] font-medium text-primary"
						>{tempoStore.tempoFactor.toFixed(2)}×
						{#if Math.abs(appliedTempo - tempoStore.tempoFactor) >= 0.001}
							<span class="text-muted-foreground">· now {appliedTempo.toFixed(2)}×</span>
						{/if}
					</span>
				</div>
				<Button
					size="sm"
					variant="secondary"
					class="w-full"
					disabled={tempoStore.isRemastering ||
						(!projectStore.videoPath && !projectStore.videoFile) ||
						!projectStore.current.cues.length ||
						tempoStore.mediaDurationMs < 500 ||
						(!!fitToDubPlan?.alreadyFits &&
							tempoStore.dubOverhangMs <= 400 &&
							tempoStore.videoUnderhangMs <= 800 &&
							!tempoStore.hasOverhangPrompt)}
					onclick={() => {
						projectStore.setVideoTool('tempo');
						void tempoStore.fitToDub();
					}}
				>
					{#if tempoStore.isRemastering}
						<LoaderCircle class="size-3.5 animate-spin" />
						Aligning…
					{:else if fitToDubPlan && !fitToDubPlan.alreadyFits}
						{#if fitToDubPlan.smartStrategy === 'overhang'}
							Align script ↔ video (needs choice…)
						{:else if fitToDubPlan.tempo < 0.995}
							Align script ↔ video ({fitToDubPlan.tempo.toFixed(2)}× video)
						{:else}
							Align script ↔ video
						{/if}
					{:else}
						Align script ↔ video
					{/if}
				</Button>
				<p class="text-[10px] leading-snug text-muted-foreground">
					{#if !projectStore.videoPath && !projectStore.videoFile}
						Open a video first.
					{:else if !projectStore.current.cues.length}
						Extract Subs, Paste Khmer, Generate TTS — then Align.
					{:else if tempoStore.mediaDurationMs < 500}
						Waiting for true video length (waveform)… re-open the video if this stays empty.
					{:else if fitToDubPlan?.alreadyFits && tempoStore.videoUnderhangMs > 800}
						Picture is longer than Khmer — Align keeps Extract starts; Manual tempo 1.00× if
						you over-slowed.
					{:else if fitToDubPlan?.alreadyFits}
						Khmer fits picture — Align keeps Extract anchors and trims cue ends to speech
						{#if tempoStore.mediaDurationMs > 0}
							<span class="font-mono"> ({formatEstDuration(tempoStore.mediaDurationMs)})</span>
						{/if}.
					{:else if fitToDubPlan?.smartStrategy === 'overhang' || fitToDubPlan?.tooExtreme}
						Khmer runs past the video. Align places natural speech (expands gaps), then you
						choose Auto-extend (slow video), Auto-trim, or Manual.
					{:else if fitToDubPlan?.smartStrategy === 'gap-expand'}
						Align expands quiet gaps so long Khmer keeps Extract starts when possible.
					{:else if fitToDubPlan?.strategy === 'video-only' || fitToDubPlan?.smartStrategy === 'mild'}
						Slightly long Khmer — Align gently fits (small speech nudge and/or pitch-safe video)
						{#if fitToDubPlan.tempo < 0.995}
							<span class="font-mono">
								({formatEstDuration(fitToDubPlan.videoMs)} → ~{formatEstDuration(fitToDubPlan.effectiveContentMs)}
								at {fitToDubPlan.tempo.toFixed(2)}×)</span
							>
						{/if}.
					{:else if fitToDubPlan}
						{fitToDubPlan.summary ?? 'Align fits Khmer to Extract picture anchors.'}
					{:else}
						Waiting for video length / cues…
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
							past the video after placement. Choose:
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
						class="space-y-0.5 rounded-md border border-border/60 bg-muted/30 px-2 py-1.5 font-mono text-[10px] leading-relaxed text-muted-foreground"
					>
						<p>
							Video
							<span class="text-foreground"
								>{formatEstDuration(tempoStore.lastAlignResult.originalVideoMs)}</span
							>
							· Khmer
							<span class="text-foreground"
								>{formatEstDuration(tempoStore.lastAlignResult.khmerAudioMs)}</span
							>
						</p>
						<p>
							Tempo
							<span class="text-foreground"
								>{tempoStore.lastAlignResult.videoTempo.toFixed(2)}×</span
							>
							· Speech
							<span class="text-foreground"
								>{tempoStore.lastAlignResult.audioStretch.toFixed(2)}×</span
							>
							· {tempoStore.lastAlignResult.strategy}
						</p>
					</div>
				{/if}
				<Button
					size="sm"
					variant="outline"
					class="w-full"
					disabled={!projectStore.current.cues.some((c) => c.assignedAudio?.durationMs)}
					onclick={() => {
						const { pulledMs, changed } = projectStore.tightenCueGaps({
							maxGapMs: ALIGN_BREATH_MS,
							hangPadMs: ALIGN_HANG_PAD_MS
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
					Optional pack for long ASR pauses only. Import SRT / Generate keep your times as-is.
				</p>
				<Button
					size="sm"
					class="w-full"
					disabled={tempoApplyDisabled}
					onclick={() => {
						projectStore.setVideoTool('tempo');
						void tempoStore.apply();
					}}
				>
					{#if tempoStore.isRemastering}
						<LoaderCircle class="size-3.5 animate-spin" />
						Remastering…
					{:else if Math.abs(tempoStore.tempoFactor - 1) < 0.001 && Math.abs(appliedTempo - 1) >= 0.001}
						Restore original (1.00×)
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
					Slows only the video/audio from the original (pitch safe). Prefer
					<span class="font-medium text-foreground/80"> Align script ↔ video </span>
					after Extract → Paste → Generate — Align places cues, then slows video only if
					needed.
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
						disabled={
							(translationStore.isTranslating && tool.id !== 'translate') ||
							(projectStore.speakersDetecting && tool.id !== 'speakers')
						}
						onclick={() => onDubToolClick(tool.id)}
					>
						{#if tool.id === 'translate' && translationStore.isTranslating}
							<LoaderCircle class="size-3.5 animate-spin" />
						{:else if tool.id === 'speakers' && projectStore.speakersDetecting}
							<LoaderCircle class="size-3.5 animate-spin" />
						{:else}
							<tool.icon class="size-3.5" />
						{/if}
						{tool.id === 'translate' && translationStore.isTranslating
							? 'Translating…'
							: tool.id === 'speakers' && projectStore.speakersDetecting
								? 'Detecting…'
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

			{#if projectStore.speakersDetecting || projectStore.speakersError || projectStore.speakerBank.length}
				<div
					class="mt-2 space-y-1.5 rounded-md border border-border/70 bg-card/80 p-2 shadow-[var(--elevation-panel)]"
				>
					<p
						class="text-[11px] font-medium leading-snug"
						class:text-primary={projectStore.speakersDetecting}
						class:text-destructive={Boolean(projectStore.speakersError) &&
							!projectStore.speakersDetecting}
					>
						{#if projectStore.speakersDetecting}
							Detecting speakers (stop VoxCPM first if loaded)…
						{:else if projectStore.speakersError}
							{projectStore.speakersError}
						{:else}
							{projectStore.speakerBank.length} speaker{projectStore.speakerBank.length === 1
								? ''
								: 's'} locked for VoxCPM clone
						{/if}
					</p>
					{#if projectStore.speakerBank.length && !projectStore.speakersDetecting}
						<ul class="space-y-0.5 text-[10px] text-muted-foreground">
							{#each projectStore.speakerBank as sp (sp.id)}
								<li>
									{sp.id} · {sp.gender} · {sp.cueCount} cues · {sp.refWavPath
										? 'ref ready'
										: 'no ref'}
								</li>
							{/each}
						</ul>
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
					placeholder={"Paste Khmer script (one sentence per line is OK)…\n\nស្រីកំណាន់…\nប្រាក់បៀវត្ស…"}
					bind:value={scriptDraft}
					spellcheck="false"
				></textarea>
				<p class="text-[10px] leading-snug text-muted-foreground">
					Paste works with or without Extract. Without Extract: creates one cue per line
					(starting at the playhead) so you can
					<span class="font-medium text-foreground/80">drag / trim periods</span>
					and leave gaps for breath yourself. With Extract: fits lines into the speech span.
					Generate keeps your periods — TTS stops at each cue end (does not spill into gaps).
				</p>
				{#if projectStore.current.cues.length > 0}
					<label
						class="flex cursor-pointer items-start gap-2 text-[10px] leading-snug text-muted-foreground"
					>
						<input
							type="checkbox"
							class="mt-0.5 size-3.5 shrink-0 rounded border-border"
							checked={!createExtraCues}
							onchange={(e) => {
								createExtraCues = !(e.currentTarget as HTMLInputElement).checked;
							}}
						/>
						<span
							>Merge into FunASR cue count instead (not recommended — glues several lines onto
							one blob)</span
						>
					</label>
				{/if}
				<Button
					size="sm"
					class="w-full"
					disabled={!scriptDraft.trim()}
					onclick={applyPastedScript}
				>
					<ClipboardPaste class="size-3.5" />
					{projectStore.current.cues.length
						? 'Apply lines → Extract timeline'
						: 'Apply lines → new timeline cues'}
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
