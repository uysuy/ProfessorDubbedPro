<script lang="ts">
	import TrackLane from './TrackLane.svelte';
	import { projectStore } from '$lib/stores/project.svelte';
</script>

<section class="flex min-h-0 flex-1 flex-col border-t border-[var(--border)] bg-[var(--surface-0)]">
	<header
		class="flex items-center justify-between border-b border-[var(--border)] px-4 py-2 text-xs uppercase tracking-[0.14em] text-[var(--text-muted)]"
	>
		<span>Timeline</span>
		<span>{projectStore.current.tracks.length} tracks</span>
	</header>
	<div class="min-h-0 flex-1 overflow-auto">
		{#each projectStore.current.tracks as track (track.id)}
			<TrackLane {track} />
		{/each}
	</div>
</section>
