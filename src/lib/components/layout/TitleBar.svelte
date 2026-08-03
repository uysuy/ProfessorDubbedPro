<script lang="ts">
	import { projectStore } from '$lib/stores/project.svelte';
</script>

<header
	class="flex h-12 shrink-0 items-center justify-between border-b border-[var(--border)] bg-[var(--surface-2)] px-4"
>
	<div class="flex items-center gap-3">
		<div
			class="flex h-7 w-7 items-center justify-center rounded-md bg-[var(--accent)] text-xs font-bold text-[var(--on-accent)]"
		>
			PD
		</div>
		<div>
			<h1 class="text-sm font-semibold tracking-wide text-[var(--text-primary)]">
				ProfessorDubbedPro
			</h1>
			<p class="text-[11px] text-[var(--text-muted)]">{projectStore.current.name}</p>
		</div>
	</div>
	<div class="flex items-center gap-2">
		<button type="button" class="studio-btn">Import</button>
		<button type="button" class="studio-btn studio-btn-accent">Export Mix</button>
	</div>
</header>
