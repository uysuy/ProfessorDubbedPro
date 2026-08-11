<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import type { VoiceProfile } from '$lib/types/project';
	import { voicesStore } from '$lib/stores/voices.svelte';
	import { dndStore } from '$lib/stores/dnd.svelte';
	import { migrateVoiceId } from '$lib/tts/edge-voices';
	import { isVoxcpmVoiceId } from '$lib/tts/voxcpm-voices';
	import { previewVoice as playVoicePreview, stopVoicePreview } from '$lib/tts/voice-preview';
	import { Check, ChevronsUpDown, LoaderCircle, Pause, Play, Volume2 } from '@lucide/svelte';

	interface Props {
		voices?: VoiceProfile[];
		value?: string;
		onValueChange?: (id: string) => void;
		class?: string;
		placeholder?: string;
	}

	let {
		voices = undefined,
		value = $bindable(''),
		onValueChange,
		class: className = '',
		placeholder = 'Select a voice'
	}: Props = $props();

	let open = $state(false);
	let previewingId = $state<string | null>(null);
	let previewLoadingId = $state<string | null>(null);

	const list = $derived(voices?.length ? voices : voicesStore.voices);
	const selected = $derived(
		list.find((voice) => voice.id === value) ??
			voicesStore.find(value) ??
			list[0] ??
			null
	);
	const loadingVoices = $derived(voicesStore.status === 'loading');
	const listIsVoxcpm = $derived(list.length > 0 && list.every((v) => isVoxcpmVoiceId(v.id)));
	const engineBadge = $derived(listIsVoxcpm ? 'VoxCPM2' : 'Edge TTS');
	const listTitle = $derived(listIsVoxcpm ? 'Khmer VoxCPM2 voices' : 'Khmer Edge-TTS voices');

	const typeStyles: Record<VoiceProfile['type'], string> = {
		Neural:
			'border-violet-700/30 bg-violet-600/12 text-violet-800 dark:border-violet-400/35 dark:bg-violet-500/15 dark:text-violet-200',
		Studio:
			'border-sky-700/30 bg-sky-600/12 text-sky-800 dark:border-sky-400/35 dark:bg-sky-500/15 dark:text-sky-200',
		Ready:
			'border-emerald-700/30 bg-emerald-600/12 text-emerald-800 dark:border-emerald-400/35 dark:bg-emerald-500/15 dark:text-emerald-200'
	};

	const genderStyles: Record<VoiceProfile['gender'], string> = {
		female:
			'border-fuchsia-700/25 bg-fuchsia-600/10 text-fuchsia-800 dark:border-fuchsia-400/30 dark:bg-fuchsia-500/10 dark:text-fuchsia-200',
		male: 'border-cyan-700/25 bg-cyan-600/10 text-cyan-800 dark:border-cyan-400/30 dark:bg-cyan-500/10 dark:text-cyan-200',
		neutral:
			'border-zinc-600/30 bg-zinc-500/10 text-zinc-700 dark:border-zinc-400/30 dark:bg-zinc-500/10 dark:text-zinc-200'
	};

	const genderLabel: Record<VoiceProfile['gender'], string> = {
		female: 'Female',
		male: 'Male',
		neutral: 'Neutral'
	};

	function initials(name: string) {
		return name
			.split(/\s+/)
			.slice(0, 2)
			.map((part) => part[0]?.toUpperCase() ?? '')
			.join('');
	}

	function avatarGradient(voice: VoiceProfile) {
		if (voice.gender === 'female') {
			return 'from-fuchsia-500/80 to-violet-600/90';
		}
		if (voice.gender === 'male') {
			return 'from-cyan-500/80 to-indigo-600/90';
		}
		return 'from-slate-400/80 to-zinc-600/90';
	}

	function stopPreview() {
		stopVoicePreview();
		previewingId = null;
		previewLoadingId = null;
	}

	function friendlyPreviewError(raw: string, isVoxcpm: boolean): string {
		const msg = raw.trim() || 'Voice preview failed';
		const lower = msg.toLowerCase();
		if (
			isVoxcpm &&
			(lower.includes('not reachable') ||
				lower.includes('not loaded') ||
				lower.includes('not started') ||
				lower.includes('not ready') ||
				lower.includes('no model') ||
				lower.includes('model load') ||
				lower.includes('click start') ||
				lower.includes('connection') ||
				lower.includes('refused') ||
				lower.includes('unreachable'))
		) {
			return 'Start VoxCPM2 first — Voice → Engine & Speakers… → Start.';
		}
		return msg;
	}

	async function previewVoice(voice: VoiceProfile, e: MouseEvent) {
		e.preventDefault();
		e.stopPropagation();

		if (previewingId === voice.id || previewLoadingId === voice.id) {
			stopPreview();
			return;
		}

		stopPreview();
		previewLoadingId = voice.id;

		try {
			await playVoicePreview(voice.id, {
				language: voice.language,
				onStart: () => {
					previewLoadingId = null;
					previewingId = voice.id;
				},
				onEnd: () => {
					if (previewingId === voice.id) previewingId = null;
					previewLoadingId = null;
				}
			});
		} catch (err) {
			previewLoadingId = null;
			previewingId = null;
			const msg = err instanceof Error ? err.message : String(err);
			dndStore.flash(friendlyPreviewError(msg, isVoxcpmVoiceId(voice.id)));
		}
	}

	function choose(id: string) {
		const next = migrateVoiceId(id);
		value = next;
		onValueChange?.(next);
		open = false;
		stopPreview();
	}

	onMount(() => {
		void voicesStore.ensureLoaded();
		if (value) {
			value = voicesStore.ensureVoicePresent(value);
		} else if (list[0]) {
			value = list[0].id;
		}
	});

	onDestroy(stopPreview);
</script>

<DropdownMenu.Root bind:open>
	<DropdownMenu.Trigger class="w-full {className}">
		{#snippet child({ props })}
			<Button
				{...props}
				variant="outline"
				class="h-auto w-full justify-between gap-3 border-border/70 bg-card/40 px-2.5 py-2 text-left hover:bg-accent/40"
			>
				{#if selected}
					<span class="flex min-w-0 flex-1 items-center gap-2.5">
						<span
							class="flex size-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br text-[11px] font-semibold text-white shadow-[0_0_18px_oklch(0.68_0.19_285/25%)] {avatarGradient(
								selected
							)}"
						>
							{initials(selected.name)}
						</span>
						<span class="min-w-0 flex-1">
							<span class="flex items-center gap-1.5">
								<span class="truncate text-sm font-medium text-foreground">{selected.name}</span>
								<Badge
									variant="outline"
									class="h-5 px-1.5 text-[10px] tracking-wide {typeStyles[selected.type]}"
								>
									{selected.type}
								</Badge>
							</span>
							<span class="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
								<span class="font-medium text-foreground/70">{genderLabel[selected.gender]}</span>
								<span class="text-border">·</span>
								<span>{engineBadge}</span>
								<span class="text-border">·</span>
								<span class="uppercase">{selected.language}</span>
							</span>
						</span>
					</span>
				{:else}
					<span class="text-sm text-muted-foreground">{placeholder}</span>
				{/if}
				{#if loadingVoices}
					<LoaderCircle class="size-4 shrink-0 animate-spin text-muted-foreground" />
				{:else}
					<ChevronsUpDown class="size-4 shrink-0 text-muted-foreground" />
				{/if}
			</Button>
		{/snippet}
	</DropdownMenu.Trigger>

	<DropdownMenu.Content
		align="start"
		class="w-[var(--bits-dropdown-menu-anchor-width)] min-w-[20rem] border-border/70 bg-popover/95 p-1.5 shadow-xl backdrop-blur-md"
	>
		<div class="flex items-center justify-between gap-2 px-2 py-1.5">
			<p class="text-[10px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
				{listTitle}
			</p>
			{#if loadingVoices}
				<span class="text-[10px] text-muted-foreground">Loading…</span>
			{:else if voicesStore.status === 'error'}
				<button
					type="button"
					class="text-[10px] text-primary hover:underline"
					onclick={() => void voicesStore.ensureLoaded(true)}
				>
					Retry
				</button>
			{:else}
				<span class="text-[10px] text-muted-foreground">{list.length} voices</span>
			{/if}
		</div>

		{#each list as voice (voice.id)}
			{@const isSelected = voice.id === value}
			{@const isPreviewing = previewingId === voice.id}
			{@const isLoadingPreview = previewLoadingId === voice.id}
			<div
				class="group flex items-center gap-2 rounded-lg border border-transparent p-1.5 transition-colors
					{isSelected
					? 'border-primary/30 bg-primary/10'
					: 'hover:border-border/60 hover:bg-muted/40'}"
			>
				<button
					type="button"
					class="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-1 py-1 text-left outline-none"
					onclick={() => choose(voice.id)}
				>
					<span
						class="relative flex size-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br text-[11px] font-semibold text-white {avatarGradient(
							voice
						)}"
					>
						{initials(voice.name)}
						{#if isPreviewing}
							<span
								class="absolute inset-0 animate-ping rounded-full bg-white/20"
								aria-hidden="true"
							></span>
						{/if}
					</span>

					<span class="min-w-0 flex-1">
						<span class="flex items-center gap-1.5">
							<span class="truncate text-sm font-medium text-foreground">{voice.name}</span>
							{#if isSelected}
								<Check class="size-3.5 shrink-0 text-primary" />
							{/if}
						</span>
						<span class="mt-1 flex flex-wrap items-center gap-1">
							<Badge
								variant="outline"
								class="h-5 px-1.5 text-[10px] {genderStyles[voice.gender]}"
							>
								{genderLabel[voice.gender]}
							</Badge>
							<Badge variant="outline" class="h-5 px-1.5 text-[10px] {typeStyles[voice.type]}">
								{voice.type}
							</Badge>
							<span class="text-[10px] text-muted-foreground uppercase">{voice.language}</span>
						</span>
					</span>
				</button>

				<Button
					variant={isPreviewing || isLoadingPreview ? 'default' : 'ghost'}
					size="icon-sm"
					class="shrink-0 {isPreviewing || isLoadingPreview
						? 'bg-primary text-primary-foreground'
						: 'text-muted-foreground hover:text-foreground'}"
					aria-label={isPreviewing
						? `Stop preview of ${voice.name}`
						: isLoadingPreview
							? `Loading preview of ${voice.name}`
							: `Preview ${voice.name}`}
					disabled={loadingVoices && !list.length}
					onclick={(e) => previewVoice(voice, e)}
				>
					{#if isLoadingPreview}
						<LoaderCircle class="size-3.5 animate-spin" />
					{:else if isPreviewing}
						<Pause class="size-3.5 fill-current" />
					{:else}
						<Play class="size-3.5 fill-current" />
					{/if}
				</Button>
			</div>
		{/each}

		<div
			class="mt-1 flex items-center gap-1.5 rounded-md border border-border/50 bg-muted/20 px-2.5 py-2 text-[11px] text-muted-foreground"
		>
			<Volume2 class="size-3.5 shrink-0 text-primary/80" />
			Preview speaks a short Khmer sample. Selection is remembered for generate.
		</div>
	</DropdownMenu.Content>
</DropdownMenu.Root>
