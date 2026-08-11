<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Separator } from '$lib/components/ui/separator/index.js';
	import { Progress } from '$lib/components/ui/progress/index.js';
	import VoiceSelect from '$lib/components/studio/VoiceSelect.svelte';
	import { projectStore } from '$lib/stores/project.svelte';
	import { dndStore } from '$lib/stores/dnd.svelte';
	import { tempoStore } from '$lib/stores/tempo.svelte';
	import { studioUi } from '$lib/stores/studio-ui.svelte';
	import { preferencesStore, TTS_ENGINE_OPTIONS } from '$lib/stores/preferences.svelte';
	import { getTtsEngine } from '$lib/tts';
	import { VOXCPM_VOICES } from '$lib/tts/voxcpm-voices';
	import { AudioLines, LoaderCircle, PanelRightClose, Settings2, Sparkles } from '@lucide/svelte';

	const selectedCount = $derived(projectStore.selectedCueIds.length);
	const busy = $derived(projectStore.isGenerating);
	const engineId = $derived(preferencesStore.ttsEngine);
	const engineLabel = $derived(
		TTS_ENGINE_OPTIONS.find((o) => o.value === engineId)?.label ?? getTtsEngine().label
	);
	const voiceList = $derived(engineId === 'voxcpm' ? VOXCPM_VOICES : undefined);

	const unlockedSelectedCount = $derived.by(() => {
		if (engineId !== 'voxcpm' || !projectStore.speakerBank.length) return 0;
		const selected = new Set(projectStore.selectedCueIds);
		const cues =
			selected.size > 0
				? projectStore.current.cues.filter((c) => selected.has(c.id))
				: [];
		let n = 0;
		for (const c of cues) {
			const bank = projectStore.speakerBank.find((s) => s.id === (c.speaker || '').trim());
			if (bank && !bank.locked) n += 1;
		}
		return n;
	});

	const generateStatus = $derived.by(() => {
		if (busy) {
			return selectedCount > 0
				? `Generating ${selectedCount} segment${selectedCount === 1 ? '' : 's'} with ${engineLabel}…`
				: 'Generating audio…';
		}
		if (projectStore.generateError) return projectStore.generateError;
		if (unlockedSelectedCount > 0) {
			return `Lock voice on speaker(s) for stable lines (${unlockedSelectedCount} unlocked)`;
		}
		if (selectedCount === 1) return `1 segment selected — ${engineLabel}`;
		if (selectedCount > 1) return `${selectedCount} segments selected — ${engineLabel}`;
		return `Select subtitle(s) to generate speech (${engineLabel})`;
	});

	async function onGenerate() {
		if (!selectedCount) {
			dndStore.flash('Select a subtitle first');
			return;
		}
		if (engineId === 'voxcpm' && unlockedSelectedCount > 0) {
			dndStore.flash(
				'Tip: Voice → Engine & Speakers… → Lock voice for consistent speaker timbre'
			);
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
		<section
			class="flex items-center justify-between gap-2 rounded-md border border-border/70 bg-card p-2 shadow-[var(--elevation-panel)]"
		>
			<div class="min-w-0">
				<p class="text-[10px] font-semibold tracking-[0.12em] text-foreground/75 uppercase">
					Engine
				</p>
				<p class="truncate text-[12px] font-medium text-foreground">{engineLabel}</p>
			</div>
			<Button
				size="sm"
				variant="outline"
				class="h-7 shrink-0 gap-1 text-[10px]"
				onclick={() => studioUi.openVoiceEngine()}
			>
				<Settings2 class="size-3" />
				Engine…
			</Button>
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
				Applies to selected (or all). Re-Generate to hear the new voice.
			</p>
			<button
				type="button"
				class="text-[10px] text-primary underline-offset-2 hover:underline"
				onclick={() => studioUi.openProsody()}
			>
				Prosody…
			</button>
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
			class="generate-btn h-11 w-full gap-2 text-sm font-semibold shadow-[0_0_18px_color-mix(in_oklab,var(--primary)_28%,transparent)]"
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
