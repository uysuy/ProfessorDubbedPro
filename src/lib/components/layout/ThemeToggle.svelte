<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import { themeStore, type ThemePreference } from '$lib/stores/theme.svelte';
	import { Check, Monitor, Moon, Sun } from '@lucide/svelte';

	const labels: Record<ThemePreference, string> = {
		system: 'System',
		light: 'Light',
		dark: 'Dark'
	};

	const options: { value: ThemePreference; label: string; hint: string }[] = [
		{ value: 'system', label: 'System', hint: 'Match OS' },
		{ value: 'light', label: 'Light', hint: 'Studio light' },
		{ value: 'dark', label: 'Dark', hint: 'Studio dark' }
	];
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger>
		{#snippet child({ props })}
			<Button
				{...props}
				variant="ghost"
				size="icon-sm"
				title="Theme · {labels[themeStore.preference]}"
				aria-label="Theme: {labels[themeStore.preference]}"
				class="size-7 text-muted-foreground hover:bg-muted hover:text-foreground"
				data-tauri-drag-region="false"
				data-no-drag
			>
				{#if themeStore.resolved === 'dark'}
					<Moon class="size-3.5" />
				{:else}
					<Sun class="size-3.5" />
				{/if}
			</Button>
		{/snippet}
	</DropdownMenu.Trigger>

	<DropdownMenu.Content align="end" class="min-w-44">
		<DropdownMenu.Label class="text-[10px] tracking-[0.12em] text-muted-foreground uppercase">
			Appearance
		</DropdownMenu.Label>
		<DropdownMenu.Separator />
		{#each options as option}
			<DropdownMenu.Item
				class="gap-2"
				onclick={() => themeStore.setPreference(option.value)}
			>
				{#if option.value === 'system'}
					<Monitor class="size-3.5 opacity-80" />
				{:else if option.value === 'light'}
					<Sun class="size-3.5 opacity-80" />
				{:else}
					<Moon class="size-3.5 opacity-80" />
				{/if}
				<span class="flex-1">
					<span class="block text-sm leading-tight">{option.label}</span>
					<span class="block text-[10px] text-muted-foreground">{option.hint}</span>
				</span>
				{#if themeStore.preference === option.value}
					<Check class="size-3.5 text-primary" />
				{/if}
			</DropdownMenu.Item>
		{/each}
	</DropdownMenu.Content>
</DropdownMenu.Root>
