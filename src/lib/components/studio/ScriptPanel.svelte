<script lang="ts">
	const cues = [
		{ in: '00:01:12:08', out: '00:01:16:02', text: 'We need the take ready before night fall.' },
		{ in: '00:01:16:10', out: '00:01:19:18', text: 'Keep the breath natural on the last line.' },
		{ in: '00:01:20:00', out: '00:01:24:06', text: 'Match lip sync on the close-up.' }
	];
</script>

<aside class="flex w-72 shrink-0 flex-col border-l border-[var(--border)] bg-[var(--surface-1)]">
	<header
		class="border-b border-[var(--border)] px-4 py-3 text-xs uppercase tracking-[0.14em] text-[var(--text-muted)]"
	>
		Script / ADR
	</header>
	<div class="min-h-0 flex-1 space-y-3 overflow-auto p-3">
		{#each cues as cue}
			<article class="rounded-md border border-[var(--border)] bg-[var(--surface-2)] p-3">
				<p class="font-mono text-[11px] text-[var(--accent-soft)]">{cue.in} → {cue.out}</p>
				<p class="mt-2 text-sm leading-relaxed text-[var(--text-primary)]">{cue.text}</p>
			</article>
		{/each}
	</div>
</aside>
