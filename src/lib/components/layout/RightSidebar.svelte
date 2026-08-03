<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Slider } from '$lib/components/ui/slider/index.js';
	import { Separator } from '$lib/components/ui/separator/index.js';
	import { Progress } from '$lib/components/ui/progress/index.js';
	import VoiceSelect from '$lib/components/studio/VoiceSelect.svelte';
	import { projectStore } from '$lib/stores/project.svelte';
	import { dndStore } from '$lib/stores/dnd.svelte';
	import { AudioLines, LoaderCircle, PanelRightClose, Sparkles } from '@lucide/svelte';

	const selectedCount = $derived(projectStore.selectedCueIds.length);
	const busy = $derived(projectStore.isGenerating);

	const generateStatus = $derived.by(() => {
		if (busy) {
			return selectedCount > 0
				? `Generating ${selectedCount} segment${selectedCount === 1 ? '' : 's'} with Edge-TTS…`
				: 'Generating audio…';
		}
		if (projectStore.generateError) return projectStore.generateError;
		if (selectedCount === 1) return '1 segment selected — Khmer Edge-TTS';
		if (selectedCount > 1) return `${selectedCount} segments selected — Khmer Edge-TTS`;
		return 'Select subtitle(s) to generate Khmer speech';
	});

	async function onGenerate() {
		if (!selectedCount) {
			dndStore.flash('Select a subtitle first');
			return;
		}
		const n = await projectStore.generateSelected();
		if (n > 0) {
			dndStore.flash(
				n === 1 ? 'Edge-TTS audio generated' : `Edge-TTS audio generated ×${n}`
			);
		} else if (projectStore.generateError) {
			dndStore.flash(projectStore.generateError);
		}
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
				>Voice Selection</Label
			>
			<VoiceSelect
				value={projectStore.voiceId}
				onValueChange={(id) => projectStore.setVoiceId(id)}
			/>
		</section>

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
