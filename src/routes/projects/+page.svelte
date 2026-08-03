<script lang="ts">
	import TopToolbar from '$lib/components/layout/TopToolbar.svelte';
	import { Button } from '$lib/components/ui/button/index.js';

	const projects = [
		{ name: 'Untitled Dub Session', updated: 'Just now', languages: 'EN → KM' },
		{ name: 'Feature Reel Pass 02', updated: 'Yesterday', languages: 'EN → TH' },
		{ name: 'Trailer ADR Block', updated: '3 days ago', languages: 'EN → VI' }
	];
</script>

<div class="flex h-dvh flex-col bg-background">
	<TopToolbar />
	<section class="panel-body min-h-0 flex-1 overflow-auto p-5">
		<header class="mb-5">
			<h2 class="text-xl font-semibold tracking-tight">Projects</h2>
			<p class="mt-1 text-sm text-muted-foreground">
				Open an existing dub session or start a new timeline.
			</p>
		</header>
		<div class="mb-4">
			<Button href="/" class="h-8">Back to Studio</Button>
		</div>
		<ul
			class="divide-y divide-border/80 overflow-hidden rounded-md border border-border/80 bg-card shadow-[var(--elevation-panel)]"
		>
			{#each projects as project}
				<li
					class="flex items-center justify-between px-3.5 py-2.5 transition-colors hover:bg-muted/40"
				>
					<div>
						<p class="text-sm font-medium">{project.name}</p>
						<p class="text-[11px] text-muted-foreground">{project.languages}</p>
					</div>
					<p class="text-[11px] text-muted-foreground">{project.updated}</p>
				</li>
			{/each}
		</ul>
	</section>
</div>
