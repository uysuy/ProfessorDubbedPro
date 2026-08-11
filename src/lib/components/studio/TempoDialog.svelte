<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
	import { Progress } from '$lib/components/ui/progress/index.js';
	import { Slider } from '$lib/components/ui/slider/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { projectStore } from '$lib/stores/project.svelte';
	import { dndStore } from '$lib/stores/dnd.svelte';
	import { tempoStore } from '$lib/stores/tempo.svelte';
	import { studioUi } from '$lib/stores/studio-ui.svelte';
	import { ALIGN_BREATH_MS, ALIGN_HANG_PAD_MS } from '$lib/utils/cue-gaps';
	import { LoaderCircle, X } from '@lucide/svelte';

	const open = $derived(studioUi.tempoOpen);

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

	function formatEstDuration(ms: number): string {
		if (ms <= 0) return '—';
		const totalSec = Math.round(ms / 1000);
		const m = Math.floor(totalSec / 60);
		const s = totalSec % 60;
		return `${m}:${String(s).padStart(2, '0')}`;
	}

	function onOpenChange(v: boolean) {
		studioUi.tempoOpen = v;
	}
</script>

<Dialog.Root open={open} onOpenChange={onOpenChange}>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>Tempo (pitch-safe)</Dialog.Title>
			<Dialog.Description>
				Manual video slowdown and gap packing. Prefer
				<span class="font-medium text-foreground/80">Align script ↔ video</span>
				on the left pipeline for everyday fit.
			</Dialog.Description>
		</Dialog.Header>

		<div class="space-y-3 py-1">
			<div class="flex items-center justify-between gap-2">
				<p class="text-[11px] font-semibold text-foreground">Factor</p>
				<span class="font-mono text-[11px] font-medium text-primary"
					>{tempoStore.tempoFactor.toFixed(2)}×
					{#if Math.abs(appliedTempo - tempoStore.tempoFactor) >= 0.001}
						<span class="text-muted-foreground">· now {appliedTempo.toFixed(2)}×</span>
					{/if}
				</span>
			</div>

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

			{#if estimatedDurationMs > 0}
				<p class="font-mono text-[10px] text-muted-foreground">
					Est. → {formatEstDuration(estimatedDurationMs)}
				</p>
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
				Optional pack for long ASR pauses only. Leave breath gaps by trimming on the timeline
				when you can.
			</p>

			{#if tempoStore.isRemastering || tempoStore.error}
				<div class="space-y-1.5 rounded-md border border-border/70 bg-muted/30 p-2">
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

		<Dialog.Footer>
			<Button class="h-8" onclick={() => onOpenChange(false)}>Done</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
