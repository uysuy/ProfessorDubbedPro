<script lang="ts">
	import TopToolbar from '$lib/components/layout/TopToolbar.svelte';
	import ProjectSettingsForm from '$lib/components/studio/ProjectSettingsForm.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import { themeStore, type ThemePreference } from '$lib/stores/theme.svelte';
	import { autosaveStore } from '$lib/stores/autosave.svelte';
	import { SHORTCUT_GROUPS } from '$lib/utils/shortcuts';
	import { Monitor, Moon, Sun } from '@lucide/svelte';

	let fps = $state('24');

	const themeLabels: Record<ThemePreference, string> = {
		system: 'System',
		dark: 'Dark',
		light: 'Light'
	};

	function onThemeChange(value: string | undefined) {
		if (value === 'system' || value === 'dark' || value === 'light') {
			themeStore.setPreference(value);
		}
	}
</script>

<div class="flex h-dvh flex-col bg-background">
	<TopToolbar />
	<section class="panel-body min-h-0 flex-1 overflow-auto p-5" tabindex="-1">
		<header class="mb-5">
			<h2 class="text-xl font-semibold tracking-tight">Settings</h2>
			<p class="mt-1 text-sm text-muted-foreground">
				Studio defaults, project preferences, and keyboard shortcuts.
			</p>
		</header>

		<div class="mb-4">
			<Button href="/" variant="outline" class="h-8">Back to Studio</Button>
		</div>

		<div
			class="max-w-5xl space-y-4 rounded-md border border-border/80 bg-card p-4 shadow-[var(--elevation-panel)]"
		>
			<header>
				<h3 class="text-sm font-semibold tracking-tight">Project Settings</h3>
				<p class="mt-1 text-[11px] text-muted-foreground">
					Voice, Khmer/English language, auto-save interval, and export defaults. Persisted on this
					device.
				</p>
			</header>
			<ProjectSettingsForm />
		</div>

		<div
			class="mt-5 max-w-5xl space-y-4 rounded-md border border-border/80 bg-card p-4 shadow-[var(--elevation-panel)]"
		>
			<header>
				<h3 class="text-sm font-semibold tracking-tight">App</h3>
				<p class="mt-1 text-[11px] text-muted-foreground">Theme and interface preferences.</p>
			</header>

			<div class="space-y-2">
				<Label class="text-xs" for="theme-select">Theme</Label>
				<Select.Root type="single" value={themeStore.preference} onValueChange={onThemeChange}>
					<Select.Trigger id="theme-select" class="h-8 w-full">
						<span class="flex items-center gap-2">
							{#if themeStore.preference === 'system'}
								<Monitor class="size-3.5 opacity-80" />
							{:else if themeStore.preference === 'light'}
								<Sun class="size-3.5 opacity-80" />
							{:else}
								<Moon class="size-3.5 opacity-80" />
							{/if}
							{themeLabels[themeStore.preference]}
						</span>
					</Select.Trigger>
					<Select.Content>
						<Select.Item value="system" label="System">System (match OS)</Select.Item>
						<Select.Item value="light" label="Light">Light</Select.Item>
						<Select.Item value="dark" label="Dark">Dark</Select.Item>
					</Select.Content>
				</Select.Root>
				<p class="text-[11px] text-muted-foreground">
					Currently showing <span class="font-medium text-foreground">{themeStore.resolved}</span>
					mode. Preference is saved on this device.
				</p>
			</div>

			<div class="space-y-2">
				<Label class="text-xs">Default FPS</Label>
				<Select.Root type="single" bind:value={fps}>
					<Select.Trigger class="h-8 w-full">{fps}</Select.Trigger>
					<Select.Content>
						<Select.Item value="24" label="24">24</Select.Item>
						<Select.Item value="25" label="25">25</Select.Item>
						<Select.Item value="30" label="30">30</Select.Item>
					</Select.Content>
				</Select.Root>
			</div>

			<div
				class="flex items-center justify-between gap-4 rounded-md border border-border/60 bg-muted/20 px-3 py-2.5"
			>
				<div>
					<Label class="text-xs">Auto-save project</Label>
					<p class="text-[11px] text-muted-foreground">
						Enable quiet snapshots. Interval is set under Project Settings.
					</p>
				</div>
				<Switch
					checked={autosaveStore.enabled}
					onCheckedChange={(v) => autosaveStore.setEnabled(v)}
				/>
			</div>
		</div>

		<div
			class="mt-5 max-w-xl space-y-4 rounded-md border border-border/80 bg-card p-4 shadow-[var(--elevation-panel)]"
		>
			<header>
				<h3 class="text-sm font-semibold tracking-tight">Keyboard shortcuts</h3>
				<p class="mt-1 text-[11px] text-muted-foreground">
					Bare letter keys are disabled while typing in subtitle fields. Ctrl/Cmd shortcuts still
					work.
				</p>
			</header>

			{#each SHORTCUT_GROUPS as group (group.title)}
				<div class="space-y-2">
					<p class="text-[10px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
						{group.title}
					</p>
					<ul class="divide-y divide-border/60 overflow-hidden rounded-md border border-border/70">
						{#each group.items as item (item.id)}
							{#each item.chords as chord, i (`${item.id}-${i}`)}
								<li
									class="flex items-start justify-between gap-3 bg-muted/15 px-3 py-2 text-xs"
								>
									<span class="text-muted-foreground">{chord.description}</span>
									<kbd
										class="shrink-0 rounded border border-border/80 bg-background px-1.5 py-0.5 font-mono text-[10px] text-foreground"
									>
										{chord.keys}
									</kbd>
								</li>
							{/each}
						{/each}
					</ul>
				</div>
			{/each}
		</div>
	</section>
</div>
