<script lang="ts">
	import { onMount } from 'svelte';
	import { invoke } from '@tauri-apps/api/core';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Slider } from '$lib/components/ui/slider/index.js';
	import { Separator } from '$lib/components/ui/separator/index.js';
	import { Progress } from '$lib/components/ui/progress/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import VoiceSelect from '$lib/components/studio/VoiceSelect.svelte';
	import { projectStore } from '$lib/stores/project.svelte';
	import { dndStore } from '$lib/stores/dnd.svelte';
	import { tempoStore } from '$lib/stores/tempo.svelte';
	import {
		preferencesStore,
		TTS_ENGINE_OPTIONS
	} from '$lib/stores/preferences.svelte';
	import { getTtsEngine, type TtsEngineId } from '$lib/tts';
	import { DEFAULT_VOXCPM_VOICE_ID, VOXCPM_VOICES } from '$lib/tts/voxcpm-voices';
	import { voiceMatchesEngine } from '$lib/tts/voice-engine';
	import { isTauriRuntime } from '$lib/utils/platform';
	import { AudioLines, LoaderCircle, PanelRightClose, Sparkles } from '@lucide/svelte';

	const selectedCount = $derived(projectStore.selectedCueIds.length);
	const busy = $derived(projectStore.isGenerating);
	const engineId = $derived(preferencesStore.ttsEngine);
	const engineLabel = $derived(
		TTS_ENGINE_OPTIONS.find((o) => o.value === engineId)?.label ?? getTtsEngine().label
	);
	const voiceList = $derived(engineId === 'voxcpm' ? VOXCPM_VOICES : undefined);

	type VoxStatus = {
		setupReady: boolean;
		serverRunning: boolean;
		modelLoaded: boolean;
		weightsCached: boolean;
		loading: boolean;
		loadProgress: number;
		loadStage: string;
		model: string;
		port: number;
		message: string;
	};

	let voxStatus = $state<VoxStatus | null>(null);
	let voxBusy = $state(false);
	let voxError = $state<string | null>(null);
	const voxCached = $derived(voxStatus?.weightsCached === true);
	const voxRunning = $derived(voxStatus?.serverRunning === true);
	const voxLoaded = $derived(voxStatus?.modelLoaded === true);
	const voxLoading = $derived(voxBusy || voxStatus?.loading === true);
	const voxProgress = $derived(
		Math.max(0, Math.min(100, Number(voxStatus?.loadProgress ?? (voxLoading ? 5 : 0))))
	);
	const voxStageLabel = $derived.by(() => {
		const stage = (voxStatus?.loadStage ?? '').toLowerCase();
		if (stage === 'ready') return 'Ready';
		if (stage === 'downloading') return 'Downloading weights';
		if (stage === 'loading_weights' || stage === 'importing') return 'Loading weights';
		if (stage === 'to_gpu') return 'Moving to GPU';
		if (stage === 'resolving_cache' || stage === 'queued' || stage === 'starting') {
			return voxCached ? 'Starting from local cache' : 'Starting';
		}
		if (voxLoading) return voxCached ? 'Loading into VRAM' : 'Working';
		return '';
	});

	const generateStatus = $derived.by(() => {
		if (busy) {
			return selectedCount > 0
				? `Generating ${selectedCount} segment${selectedCount === 1 ? '' : 's'} with ${engineLabel}…`
				: 'Generating audio…';
		}
		if (projectStore.generateError) return projectStore.generateError;
		if (selectedCount === 1) return `1 segment selected — ${engineLabel}`;
		if (selectedCount > 1) return `${selectedCount} segments selected — ${engineLabel}`;
		return `Select subtitle(s) to generate speech (${engineLabel})`;
	});

	async function refreshVoxStatus() {
		if (!isTauriRuntime() || engineId !== 'voxcpm') {
			voxStatus = null;
			return;
		}
		try {
			voxStatus = await invoke<VoxStatus>('voxcpm_status');
		} catch {
			voxStatus = null;
		}
	}

	onMount(() => {
		void refreshVoxStatus();
	});

	$effect(() => {
		void engineId;
		void refreshVoxStatus();
		// Session default only — cue voices are remapped in onEngineChange / syncVoicesToTtsEngine.
		if (!voiceMatchesEngine(projectStore.voiceId, engineId)) {
			projectStore.setVoiceId(
				engineId === 'voxcpm' ? DEFAULT_VOXCPM_VOICE_ID : preferencesStore.defaultVoiceId,
				{ applyToCues: false }
			);
		}
	});

	function onEngineChange(value: string | undefined) {
		if (!value || !TTS_ENGINE_OPTIONS.some((o) => o.value === value)) return;
		const engine = value as TtsEngineId;
		preferencesStore.setTtsEngine(engine);
		const { cues } = projectStore.syncVoicesToTtsEngine(engine);
		dndStore.flash(
			cues > 0
				? `Switched to ${TTS_ENGINE_OPTIONS.find((o) => o.value === engine)?.label ?? engine} — updated ${cues} subtitle voice${cues === 1 ? '' : 's'}`
				: `Switched to ${TTS_ENGINE_OPTIONS.find((o) => o.value === engine)?.label ?? engine}`
		);
		void refreshVoxStatus();
	}

	/** Start server + load model (one click). */
	async function onVoxStart() {
		voxBusy = true;
		voxError = null;
		dndStore.flash(
			voxCached
				? 'Starting VoxCPM2 from local cache…'
				: 'Starting VoxCPM2 (first time may download ~5GB)…'
		);
		const poll = setInterval(() => void refreshVoxStatus(), 1000);
		try {
			voxStatus = await invoke<VoxStatus>('load_voxcpm_model');
			dndStore.flash('VoxCPM2 ready');
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			voxError = msg;
			dndStore.flash(msg);
			await refreshVoxStatus();
		} finally {
			clearInterval(poll);
			voxBusy = false;
			await refreshVoxStatus();
		}
	}

	async function onVoxStop() {
		voxBusy = true;
		try {
			voxStatus = await invoke<VoxStatus>('stop_voxcpm_server');
			voxError = null;
			dndStore.flash('VoxCPM stopped — VRAM freed');
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			voxError = msg;
			dndStore.flash(msg);
		} finally {
			voxBusy = false;
			await refreshVoxStatus();
		}
	}

	async function onGenerate() {
		if (!selectedCount) {
			dndStore.flash('Select a subtitle first');
			return;
		}
		const n = await projectStore.generateSelected();
		if (n > 0) {
			const prompted = tempoStore.promptOverhangAfterTts();
			if (!prompted) {
				dndStore.flash(
					n === 1 ? `${engineLabel} audio generated` : `${engineLabel} audio generated ×${n}`
				);
			}
		} else if (projectStore.generateError) {
			dndStore.flash(projectStore.generateError);
		}
		void refreshVoxStatus();
	}
</script>

<aside class="voice-mix flex h-full min-h-0 flex-col bg-transparent text-sidebar-foreground">
	<div class="panel-header">
		<span>Voice & Mix</span>
		<div class="flex items-center gap-1.5">
			<span class="normal-case tracking-normal">{selectedCount} selected</span>
			<Button
				variant="ghost"
				size="icon-xs"
				aria-label="Collapse right panel"
				onclick={() => projectStore.toggleRight()}
			>
				<PanelRightClose class="size-3.5" />
			</Button>
		</div>
	</div>

	<div class="min-h-0 flex-1 space-y-2.5 overflow-auto p-2.5">
		<section class="space-y-1.5 rounded-md border border-border/70 bg-card p-2 shadow-[var(--elevation-panel)]">
			<Label class="text-[10px] font-semibold tracking-[0.12em] text-foreground/75 uppercase"
				>TTS engine</Label
			>
			<Select.Root type="single" value={engineId} onValueChange={onEngineChange}>
				<Select.Trigger class="h-8 w-full text-[12px]" aria-label="TTS engine"
					>{engineLabel}</Select.Trigger
				>
				<Select.Content>
					{#each TTS_ENGINE_OPTIONS as opt (opt.value)}
						<Select.Item value={opt.value} label={opt.label}>
							<span class="flex w-full items-center justify-between gap-3">
								<span>{opt.label}</span>
								<span class="text-[10px] text-muted-foreground">{opt.hint}</span>
							</span>
						</Select.Item>
					{/each}
				</Select.Content>
			</Select.Root>
			{#if engineId === 'voxcpm'}
				<p class="text-[10px] leading-snug text-muted-foreground">
					{#if voxStatus}
						{voxStatus.message}
					{:else}
						Optional local engine — run
						<span class="font-mono">pnpm voxcpm:setup</span>
						once.
					{/if}
				</p>
				<div class="flex flex-wrap gap-1">
					{#if voxRunning || voxLoaded || voxLoading}
						<Button
							size="sm"
							variant="outline"
							class="h-7 text-[10px]"
							disabled={voxBusy && !voxRunning}
							onclick={onVoxStop}
							title="Stop server and free VRAM"
						>
							{voxBusy && voxRunning && !voxLoaded ? 'Stopping…' : 'Stop'}
						</Button>
					{:else}
						<Button
							size="sm"
							variant="outline"
							class="h-7 text-[10px]"
							disabled={voxBusy}
							onclick={onVoxStart}
							title="Start server and load model into VRAM"
						>
							{voxBusy ? 'Starting…' : 'Start'}
						</Button>
					{/if}
				</div>
				{#if voxLoading || (voxBusy && !voxLoaded)}
					<div class="space-y-1 rounded-md border border-primary/30 bg-primary/8 px-2 py-1.5">
						<div class="flex items-center justify-between gap-2 text-[10px] text-primary">
							<span class="truncate">{voxStageLabel || 'Loading…'}</span>
							<span class="font-mono tabular-nums">{voxProgress}%</span>
						</div>
						<Progress value={voxProgress} max={100} class="h-1.5" />
						<p class="text-[10px] leading-snug text-muted-foreground">
							{#if voxCached}
								No download — loading weights into GPU VRAM.
							{:else}
								First run may download ~5GB. Keep the terminal open with HF_TOKEN set.
							{/if}
						</p>
					</div>
				{/if}
				{#if voxError}
					<p
						class="max-h-24 overflow-auto rounded border border-destructive/40 bg-destructive/10 px-1.5 py-1 text-[10px] leading-snug text-destructive whitespace-pre-wrap"
					>
						{voxError}
					</p>
				{/if}
			{/if}
		</section>

		<section class="space-y-1.5 rounded-md border border-border/70 bg-card p-2 shadow-[var(--elevation-panel)]">
			<Label class="text-[10px] font-semibold tracking-[0.12em] text-foreground/75 uppercase"
				>Voice Selection</Label
			>
			<VoiceSelect
				value={projectStore.voiceId}
				voices={voiceList}
				onValueChange={(id) => {
					projectStore.setVoiceId(id);
					const n = selectedCount || projectStore.current.cues.length;
					dndStore.flash(
						selectedCount > 0
							? `Voice applied to ${selectedCount} selected subtitle${selectedCount === 1 ? '' : 's'}`
							: n > 0
								? `Voice applied to all ${n} subtitle${n === 1 ? '' : 's'}`
								: 'Default voice updated'
					);
				}}
			/>
			<p class="text-[10px] leading-snug text-muted-foreground">
				Applies to selected subtitles (or all if none selected). Re-Generate to hear the new
				voice.
			</p>
		</section>

		{#if engineId === 'voxcpm'}
			<section
				class="space-y-1.5 rounded-md border border-border/70 bg-card p-2 shadow-[var(--elevation-panel)]"
			>
				<div class="flex items-center justify-between gap-2">
					<Label class="text-[10px] font-semibold tracking-[0.12em] text-foreground/75 uppercase"
						>Speakers</Label
					>
					<Button
						size="sm"
						variant="outline"
						class="h-7 text-[10px]"
						disabled={projectStore.speakersDetecting}
						onclick={async () => {
							const n = await projectStore.detectSpeakers();
							if (n > 0) {
								dndStore.flash(
									n === 1 ? '1 speaker locked' : `${n} speakers locked for clone`
								);
							} else if (projectStore.speakersError) {
								dndStore.flash(projectStore.speakersError);
							}
						}}
					>
						{#if projectStore.speakersDetecting}
							<LoaderCircle class="size-3 animate-spin" />
							Detecting…
						{:else}
							Detect / rebuild
						{/if}
					</Button>
				</div>
				{#if projectStore.speakerBank.length}
					<ul class="space-y-1">
						{#each projectStore.speakerBank as sp (sp.id)}
							<li
								class="rounded border border-border/55 bg-muted/30 px-2 py-1.5 text-[10px] leading-snug"
							>
								<div class="font-medium text-foreground">{sp.id}</div>
								<div class="text-muted-foreground">
									{sp.gender} · {sp.cueCount} cues · {sp.refWavPath ? 'clone ref' : 'preset only'}
								</div>
							</li>
						{/each}
					</ul>
					<p class="text-[10px] leading-snug text-muted-foreground">
						Generate uses each cue’s Speaker + reference clip so boy/girl timbre stays stable.
						Khmer script drives tone (questions, pace).
					</p>
				{:else}
					<p class="text-[10px] leading-snug text-muted-foreground">
						Extract Subs, then Detect Speakers. VoxCPM will clone each speaker from the video.
					</p>
				{/if}
				{#if projectStore.speakersError}
					<p class="text-[10px] text-destructive whitespace-pre-wrap">{projectStore.speakersError}</p>
				{/if}
			</section>
		{/if}

		<section
			class="space-y-1.5 rounded-md border border-border/70 bg-card p-2 shadow-[var(--elevation-panel)]"
		>
			<Label class="text-[10px] font-semibold tracking-[0.12em] text-foreground/75 uppercase"
				>Prosody</Label
			>
			<p class="text-[10px] leading-snug text-muted-foreground">
				Applies to
				<span class="font-medium text-foreground/80">
					{selectedCount > 0 ? `${selectedCount} selected` : 'all cues'}
				</span>
				and is used when you Generate.
				{#if engineId === 'voxcpm'}
					<span class="text-muted-foreground/80">
						(VoxCPM uses Voice Selection prompts for tone; pitch/volume mainly affect Edge TTS.)
					</span>
				{/if}
			</p>

			<div class="space-y-2 rounded-md border border-border/55 bg-muted/35 p-2">
				<div class="space-y-1">
					<div class="flex items-center justify-between gap-2">
						<Label class="text-[11px] font-medium text-foreground/80">Pitch</Label>
						<span class="font-mono text-[11px] font-medium text-primary"
							>{projectStore.pitch > 0 ? '+' : ''}{projectStore.pitch} st</span
						>
					</div>
					<Slider
						type="single"
						value={projectStore.pitch}
						onValueChange={(v) => projectStore.setPitch(v)}
						min={-6}
						max={6}
						step={1}
					/>
				</div>

				<div class="space-y-1">
					<div class="flex items-center justify-between gap-2">
						<Label class="text-[11px] font-medium text-foreground/80">Speed</Label>
						<span class="font-mono text-[11px] font-medium text-primary"
							>{projectStore.speed.toFixed(2)}×</span
						>
					</div>
					<Slider
						type="single"
						value={projectStore.speed}
						onValueChange={(v) => projectStore.setSpeed(v)}
						min={0.5}
						max={1.5}
						step={0.05}
					/>
				</div>

				<div class="space-y-1">
					<div class="flex items-center justify-between gap-2">
						<Label class="text-[11px] font-medium text-foreground/80">Volume</Label>
						<span class="font-mono text-[11px] font-medium text-primary"
							>{projectStore.volume}%</span
						>
					</div>
					<Slider
						type="single"
						value={projectStore.volume}
						onValueChange={(v) => projectStore.setVolume(v)}
						min={0}
						max={100}
						step={1}
					/>
				</div>
			</div>
			<Button
				size="sm"
				variant="outline"
				class="w-full"
				disabled={!projectStore.current.cues.length}
				onclick={() => {
					const n = projectStore.stampProsodyToCues();
					dndStore.flash(
						n === 1 ? 'Prosody applied to 1 cue' : `Prosody applied to ${n} cues`
					);
				}}
			>
				Apply Prosody to {selectedCount > 0 ? 'selected' : 'all'}
			</Button>
		</section>

		{#if busy}
			<div class="space-y-1.5 rounded-md border border-primary/35 bg-primary/10 px-2.5 py-2">
				<div class="flex items-center gap-2 text-[11px] font-medium text-primary">
					<AudioLines class="size-3.5 animate-pulse" />
					Generating…
				</div>
				<Progress value={projectStore.generateProgress} max={100} class="h-1.5" />
			</div>
		{/if}
	</div>

	<div
		class="generate-dock shrink-0 space-y-2 border-t border-border/80 bg-card/90 px-2.5 pt-2.5 pb-3 shadow-[0_-6px_18px_oklch(0.4_0.04_265/6%)]"
	>
		<div class="flex items-center gap-2">
			<Separator class="flex-1" />
			<span
				class="shrink-0 text-[10px] font-semibold tracking-[0.14em] text-foreground/70 uppercase"
			>
				Generate
			</span>
			<Separator class="flex-1" />
		</div>

		<Button
			size="lg"
			class="generate-btn h-11 w-full gap-2 text-sm font-semibold shadow-[0_0_18px_color-mix(in_oklab,var(--primary)_28%,transparent)] dark:shadow-[0_0_18px_color-mix(in_oklab,var(--primary)_28%,transparent)]"
			disabled={!selectedCount || busy}
			onclick={onGenerate}
		>
			{#if busy}
				<LoaderCircle class="size-4 animate-spin" />
				Generating...
			{:else}
				<Sparkles class="size-4" />
				Generate Selected Audio
			{/if}
		</Button>

		<p
			class="text-center text-[11px] font-medium text-muted-foreground"
			class:text-primary={busy}
			class:text-destructive={!busy && Boolean(projectStore.generateError)}
		>
			{generateStatus}
		</p>
	</div>
</aside>

<style>
	:global(.dark) .generate-dock {
		background: color-mix(in oklab, var(--sidebar) 40%, transparent);
		box-shadow: none;
	}
</style>
