<script lang="ts">
	import { projectStore } from '$lib/stores/project.svelte';
	import { normalizeDubLanguage } from '$lib/stores/preferences.svelte';
	import { formatTimecode } from '$lib/utils/time';

	const sourceCode = $derived(
		(projectStore.current.sourceLanguage || 'en').toUpperCase().slice(0, 2)
	);
	const targetCode = $derived(
		normalizeDubLanguage(projectStore.current.targetLanguage).toUpperCase()
	);
</script>

<div
	class="flex items-center justify-between gap-4 border-b border-[var(--border)] bg-[var(--surface-1)] px-4 py-2"
>
	<div class="flex items-center gap-2">
		<button
			type="button"
			class="studio-btn"
			onclick={() => projectStore.stop()}
			aria-label="Stop"
		>
			■
		</button>
		<button
			type="button"
			class="studio-btn studio-btn-accent"
			onclick={() => projectStore.togglePlayback()}
			aria-label={projectStore.isPlaying ? 'Pause' : 'Play'}
		>
			{projectStore.isPlaying ? '❚❚' : '▶'}
		</button>
	</div>

	<div
		class="rounded-md border border-border bg-[var(--surface-recessed)] px-3 py-1 font-mono text-sm tracking-wider text-primary"
	>
		{formatTimecode(projectStore.playheadMs, projectStore.current.fps)}
	</div>

	<div class="flex items-center gap-3 text-xs text-[var(--text-muted)]">
		<span>FPS {projectStore.current.fps}</span>
		<span class="h-3 w-px bg-[var(--border)]"></span>
		<span>{sourceCode} → {targetCode}</span>
	</div>
</div>
