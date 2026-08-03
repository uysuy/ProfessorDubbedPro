<script lang="ts">
	import { page } from '$app/state';

	const links = [
		{ href: '/', label: 'Studio' },
		{ href: '/projects', label: 'Projects' },
		{ href: '/settings', label: 'Settings' }
	];
</script>

<aside class="flex w-56 shrink-0 flex-col border-r border-[var(--border)] bg-[var(--surface-1)]">
	<div class="border-b border-[var(--border)] px-4 py-4">
		<p class="text-[11px] uppercase tracking-[0.22em] text-[var(--text-muted)]">Workspace</p>
		<p class="mt-1 text-base font-semibold text-[var(--text-primary)]">Dubbing Desk</p>
	</div>
	<nav class="flex flex-1 flex-col gap-1 p-2">
		{#each links as link}
			{@const active = page.url.pathname === link.href}
			<a
				href={link.href}
				class="rounded-md px-3 py-2 text-sm transition-colors {active
					? 'bg-[var(--accent)]/15 text-[var(--accent-soft)]'
					: 'text-[var(--text-secondary)] hover:bg-white/5 hover:text-[var(--text-primary)]'}"
			>
				{link.label}
			</a>
		{/each}
	</nav>
	<div class="border-t border-[var(--border)] p-3 text-[11px] text-[var(--text-muted)]">
		Tauri 2 · SvelteKit · Tailwind v4
	</div>
</aside>
