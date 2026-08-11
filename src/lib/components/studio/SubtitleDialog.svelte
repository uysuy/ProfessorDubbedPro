<script lang="ts">
	import { onMount } from 'svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Progress } from '$lib/components/ui/progress/index.js';
	import { Slider } from '$lib/components/ui/slider/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import * as Tabs from '$lib/components/ui/tabs/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import { projectStore } from '$lib/stores/project.svelte';
	import { dndStore } from '$lib/stores/dnd.svelte';
	import { studioUi } from '$lib/stores/studio-ui.svelte';
	import { tempoStore } from '$lib/stores/tempo.svelte';
	import { translationStore } from '$lib/stores/translation.svelte';
	import {
		preferencesStore,
		TRANSLATION_QUALITY_OPTIONS,
		type TranslationQuality
	} from '$lib/stores/preferences.svelte';
	import { translateProviderLabel } from '$lib/utils/translate';
	import { listSystemFonts, type SystemFontInfo } from '$lib/utils/system-fonts';
	import { importSrtFromDialog } from '$lib/utils/import-srt';
	import { ClipboardPaste, FileText, Languages, LoaderCircle } from '@lucide/svelte';

	const open = $derived(studioUi.subtitleOpen);
	const tab = $derived(studioUi.subtitleTab);
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
	const qualityLabel = $derived(
		preferencesStore.translationQuality === 'high' ? 'High Quality' : 'Fast'
	);
	const translatorEngine = $derived(translateProviderLabel(translationStore.provider));

	$effect(() => {
		const projectId = projectStore.current.id;
		void projectId;
		studioUi.clearPasteDraft();
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

	function onOpenChange(v: boolean) {
		studioUi.subtitleOpen = v;
	}

	function setTab(v: string | undefined) {
		if (v === 'paste' || v === 'import' || v === 'style' || v === 'translate') {
			studioUi.subtitleTab = v;
		}
	}

	function formatEstDuration(ms: number): string {
		if (ms <= 0) return '—';
		const totalSec = Math.round(ms / 1000);
		const m = Math.floor(totalSec / 60);
		const s = totalSec % 60;
		return `${m}:${String(s).padStart(2, '0')}`;
	}

	function pickFont(family: string) {
		const hit = systemFonts.find((f) => f.family === family);
		projectStore.setSubtitleStyle({
			fontFamily: family,
			fontFile: hit?.path ?? null
		});
	}

	function setSubPreset(where: 'top' | 'middle' | 'bottom') {
		const y = where === 'top' ? 0.08 : where === 'middle' ? 0.5 : 0.84;
		projectStore.setSubtitleStyle({ x: 0.5, y });
	}

	function applyPastedScript() {
		const draft = studioUi.scriptDraft;
		const createExtra = studioUi.createExtraCues;
		const extractCueCount = projectStore.current.cues.length;
		const result = projectStore.applyScriptTranslations(draft, {
			mergeExtraLines: extractCueCount > 0 && !createExtra,
			fitToExtractSpan: createExtra
		});
		if (result.applied === 0) {
			studioUi.scriptFeedback =
				'No sentences found. Paste Khmer (one hardsub line per line).';
			dndStore.flash(studioUi.scriptFeedback);
			return;
		}
		const bits: string[] = [];
		if (result.extractCueCount === 0) {
			bits.push(
				`Created ${result.cueCount} cue${result.cueCount === 1 ? '' : 's'} from script — drag/trim on the timeline, leave gaps for breath`
			);
		} else if (result.fittedToSpan) {
			bits.push(
				`Fitted ${result.sentenceCount} line${result.sentenceCount === 1 ? '' : 's'} into Extract span (${extractCueCount} → ${result.cueCount} cues)`
			);
		} else {
			bits.push(
				`Mapped ${result.sentenceCount} → ${extractCueCount} Extract cue${extractCueCount === 1 ? '' : 's'}`
			);
		}
		if (result.mergedExtraLines > 0) {
			bits.push(`merged ${result.mergedExtraLines} extras`);
		}
		const videoMs = tempoStore.mediaDurationMs;
		if (result.estimatedSpeechMs > 0 && videoMs > 500) {
			bits.push(
				`est. Khmer ~${formatEstDuration(result.estimatedSpeechMs)} vs video ${formatEstDuration(videoMs)}`
			);
		}
		studioUi.scriptFeedback = bits.join(' · ');
		projectStore.stampPictureAnchorsOnly();
		dndStore.flash(
			`${studioUi.scriptFeedback} — arrange periods, then Generate`
		);
		projectStore.setDubTool('script');
	}

	function setQuality(q: TranslationQuality) {
		preferencesStore.setTranslationQuality(q);
	}

	async function runTranslate() {
		if (translationStore.isTranslating) return;
		await translationStore.translateSmart();
	}
</script>

<Dialog.Root open={open} onOpenChange={onOpenChange}>
	<Dialog.Content class="flex max-h-[min(90vh,720px)] flex-col gap-0 overflow-hidden p-0 sm:max-w-xl">
		<Dialog.Header class="shrink-0 border-b border-border/70 px-5 py-4">
			<Dialog.Title>Subtitle</Dialog.Title>
			<Dialog.Description>
				Paste script, import SRT, style burn-in, or translate — keep the main studio uncluttered.
			</Dialog.Description>
		</Dialog.Header>

		<Tabs.Root
			value={tab}
			onValueChange={setTab}
			class="flex min-h-0 flex-1 flex-col overflow-hidden"
		>
			<Tabs.List class="mx-5 mt-3 grid h-auto w-auto shrink-0 grid-cols-4 gap-1">
				<Tabs.Trigger value="paste" class="text-xs">Paste</Tabs.Trigger>
				<Tabs.Trigger value="import" class="text-xs">Import</Tabs.Trigger>
				<Tabs.Trigger value="style" class="text-xs">Style</Tabs.Trigger>
				<Tabs.Trigger value="translate" class="text-xs">Translate</Tabs.Trigger>
			</Tabs.List>

			<div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
				<Tabs.Content value="paste" class="mt-0 space-y-3">
					<div class="flex items-center justify-between gap-2">
						<p class="text-[11px] font-semibold text-foreground">Paste Khmer script</p>
						<span class="font-mono text-[10px] text-muted-foreground"
							>{projectStore.current.cues.length} cues</span
						>
					</div>
					<textarea
						class="min-h-[10rem] w-full resize-y rounded-md border border-border/70 bg-background px-2 py-1.5 font-khmer text-[12px] leading-relaxed text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
						placeholder={"Paste Khmer (one hardsub line per line)…\n\nស្រីកំណាន់…\nប្រាក់បៀវត្ស…"}
						value={studioUi.scriptDraft}
						oninput={(e) => {
							studioUi.scriptDraft = (e.currentTarget as HTMLTextAreaElement).value;
						}}
						spellcheck="false"
					></textarea>
					<p class="text-[10px] leading-snug text-muted-foreground">
						Works with or without Extract. Without Extract: one cue per line from the playhead —
						drag/trim and leave breath gaps yourself. With Extract: fits into the speech span.
					</p>
					{#if projectStore.current.cues.length > 0}
						<label
							class="flex cursor-pointer items-start gap-2 text-[10px] leading-snug text-muted-foreground"
						>
							<input
								type="checkbox"
								class="mt-0.5 size-3.5 shrink-0 rounded border-border"
								checked={!studioUi.createExtraCues}
								onchange={(e) => {
									studioUi.createExtraCues = !(e.currentTarget as HTMLInputElement).checked;
								}}
							/>
							<span>Merge into FunASR cue count (not recommended)</span>
						</label>
					{/if}
					<Button
						size="sm"
						class="w-full"
						disabled={!studioUi.scriptDraft.trim()}
						onclick={applyPastedScript}
					>
						<ClipboardPaste class="size-3.5" />
						{projectStore.current.cues.length
							? 'Apply lines → Extract timeline'
							: 'Apply lines → new timeline cues'}
					</Button>
					{#if studioUi.scriptFeedback}
						<p class="text-[10px] font-medium text-primary">{studioUi.scriptFeedback}</p>
					{/if}
				</Tabs.Content>

				<Tabs.Content value="import" class="mt-0 space-y-3">
					<p class="text-[10px] leading-snug text-muted-foreground">
						Use when you already have hardsub-accurate timings. Prefer Extract → Paste when
						FunASR is your only clock.
					</p>
					<Button
						size="sm"
						variant="secondary"
						class="w-full"
						onclick={() => void importSrtFromDialog()}
					>
						<FileText class="size-3.5" />
						Import SRT…
					</Button>
				</Tabs.Content>

				<Tabs.Content value="style" class="mt-0 space-y-3">
					<div class="space-y-1">
						<p class="text-[10px] text-muted-foreground">Font</p>
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
								Outline
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
							<span class="font-mono text-[11px] font-semibold tabular-nums"
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
								<p class="text-[10px] text-muted-foreground">Outline</p>
								<span class="font-mono text-[10px]"
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
								aria-label="Outline thickness"
							/>
						</div>
					{/if}
					<div class="flex flex-wrap gap-1">
						{#each ['top', 'middle', 'bottom'] as where}
							<button
								type="button"
								class="rounded border border-border/60 px-2 py-0.5 text-[10px] text-muted-foreground capitalize hover:text-foreground"
								onclick={() => setSubPreset(where as 'top' | 'middle' | 'bottom')}
							>
								{where}
							</button>
						{/each}
					</div>
					<p class="text-[10px] leading-snug text-muted-foreground">
						Drag the burn-in box on the video preview to fine-tune. Export matches this style.
					</p>
				</Tabs.Content>

				<Tabs.Content value="translate" class="mt-0 space-y-3">
					<div class="grid grid-cols-2 gap-1 rounded-md border border-border/60 bg-muted/20 p-0.5">
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
					<Button
						size="sm"
						class="w-full"
						disabled={translationStore.isTranslating || !projectStore.current.cues.length}
						onclick={() => void runTranslate()}
					>
						{#if translationStore.isTranslating}
							<LoaderCircle class="size-3.5 animate-spin" />
							Translating…
						{:else}
							<Languages class="size-3.5" />
							Translate ZH → KM
						{/if}
					</Button>
					{#if translationStore.isTranslating || translationStore.error}
						<div class="space-y-1.5 rounded-md border border-border/70 bg-muted/30 p-2">
							<p
								class="text-[11px] font-medium leading-snug"
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
									{translationStore.progress}% · {qualityLabel} · {translatorEngine}
								</p>
							{/if}
						</div>
					{/if}
					<p class="text-[10px] leading-snug text-muted-foreground">
						Prefer Paste when you already have a Khmer script. Translate fills empty translation
						cells from Chinese source.
					</p>
				</Tabs.Content>
			</div>
		</Tabs.Root>

		<Dialog.Footer class="shrink-0 border-t border-border/70 px-5 py-3">
			<Button class="h-8" onclick={() => onOpenChange(false)}>Done</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
