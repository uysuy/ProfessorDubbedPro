<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Slider } from '$lib/components/ui/slider/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { projectStore } from '$lib/stores/project.svelte';
	import { dndStore } from '$lib/stores/dnd.svelte';
	import { studioUi } from '$lib/stores/studio-ui.svelte';
	import { preferencesStore } from '$lib/stores/preferences.svelte';

	const open = $derived(studioUi.prosodyOpen);
	const selectedCount = $derived(projectStore.selectedCueIds.length);
	const engineId = $derived(preferencesStore.ttsEngine);

	function onOpenChange(v: boolean) {
		studioUi.prosodyOpen = v;
	}
</script>

<Dialog.Root open={open} onOpenChange={onOpenChange}>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>Prosody</Dialog.Title>
			<Dialog.Description>
				Pitch, speed, and volume for
				<span class="font-medium text-foreground/80">
					{selectedCount > 0 ? `${selectedCount} selected` : 'all cues'}
				</span>
				when you Generate.
			</Dialog.Description>
		</Dialog.Header>

		<div class="space-y-3 py-1">
			{#if engineId === 'voxcpm'}
				<p class="text-[10px] leading-snug text-muted-foreground">
					VoxCPM uses Voice Selection prompts for tone; pitch/volume mainly affect Edge TTS.
				</p>
			{/if}

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
		</div>

		<Dialog.Footer>
			<Button class="h-8" onclick={() => onOpenChange(false)}>Done</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
