<script lang="ts">
	/**
	 * Title Liver clip properties for the right sidebar.
	 * Shown only while a Title Liver clip is selected on the timeline.
	 */
	import { onMount } from 'svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Slider } from '$lib/components/ui/slider/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import { projectStore } from '$lib/stores/project.svelte';
	import { dndStore } from '$lib/stores/dnd.svelte';
	import { titleLiverTemplate } from '$lib/utils/title-liver';
	import { formatClock } from '$lib/utils/time';
	import { listSystemFonts, type SystemFontInfo } from '$lib/utils/system-fonts';
	import { Copy, Trash2 } from '@lucide/svelte';

	const clip = $derived(projectStore.selectedTitleLiver);

	let systemFonts = $state<SystemFontInfo[]>([]);
	let fontsLoading = $state(false);

	onMount(() => {
		fontsLoading = true;
		void listSystemFonts()
			.then((list) => {
				systemFonts = list;
			})
			.finally(() => {
				fontsLoading = false;
			});
	});

	function pickFont(family: string) {
		if (!clip) return;
		const hit = systemFonts.find((f) => f.family === family);
		projectStore.updateTitleLiverClip(clip.id, {
			fontFamily: family,
			fontFile: hit?.path ?? null
		});
	}

	function onDelete() {
		if (!clip) return;
		projectStore.removeTitleLiverClip(clip.id);
		dndStore.flash('Title Liver clip removed');
	}

	function onDuplicate() {
		const c = projectStore.duplicateTitleLiverClip();
		dndStore.flash(c ? 'Duplicated live title' : 'Nothing to duplicate');
	}
</script>

{#if clip}
	<section class="space-y-2 rounded-md border border-border/70 bg-card p-2 shadow-[var(--elevation-panel)]">
		<div class="flex items-start justify-between gap-2">
			<div class="min-w-0">
				<p class="text-[10px] font-semibold tracking-[0.12em] text-foreground/75 uppercase">
					Live Title
				</p>
				<p class="truncate text-[12px] font-medium text-foreground">
					{titleLiverTemplate(clip.templateId).name}
				</p>
				<p class="font-mono text-[9px] text-muted-foreground">
					{formatClock(clip.startMs)}–{formatClock(clip.endMs)}
				</p>
			</div>
			<div class="flex shrink-0 gap-1">
				<Button size="sm" variant="outline" class="h-7 gap-1 text-[10px]" onclick={onDuplicate}>
					<Copy class="size-3" />
					Dup
				</Button>
				<Button
					size="sm"
					variant="outline"
					class="h-7 gap-1 text-[10px] text-destructive"
					onclick={onDelete}
				>
					<Trash2 class="size-3" />
					Delete
				</Button>
			</div>
		</div>

		<div class="space-y-1">
			<Label class="text-[10px] text-muted-foreground">Line 1</Label>
			<Input
				class="h-7 text-[12px]"
				value={clip.line1}
				oninput={(e) =>
					projectStore.updateTitleLiverClip(clip.id, {
						line1: (e.currentTarget as HTMLInputElement).value
					})}
			/>
		</div>
		<div class="space-y-1">
			<Label class="text-[10px] text-muted-foreground">Line 2</Label>
			<Input
				class="h-7 text-[12px]"
				value={clip.line2}
				oninput={(e) =>
					projectStore.updateTitleLiverClip(clip.id, {
						line2: (e.currentTarget as HTMLInputElement).value
					})}
			/>
		</div>
		<div class="space-y-1">
			<Label class="text-[10px] text-muted-foreground">Line 3 (optional)</Label>
			<Input
				class="h-7 text-[12px]"
				value={clip.line3 ?? ''}
				placeholder="Org chart names: A,B,C…"
				oninput={(e) =>
					projectStore.updateTitleLiverClip(clip.id, {
						line3: (e.currentTarget as HTMLInputElement).value
					})}
			/>
		</div>

		<div class="space-y-1">
			<Label class="text-[10px] text-muted-foreground">Font</Label>
			<Select.Root
				type="single"
				value={clip.fontFamily}
				onValueChange={(v) => {
					if (v) pickFont(v);
				}}
			>
				<Select.Trigger class="h-7 w-full text-[10px]" aria-label="Title Liver font">
					{fontsLoading ? 'Loading fonts…' : clip.fontFamily}
				</Select.Trigger>
				<Select.Content class="max-h-56">
					{#each systemFonts.length ? systemFonts : [{ family: clip.fontFamily, path: null }] as f (f.family)}
						<Select.Item value={f.family} label={f.family}>{f.family}</Select.Item>
					{/each}
				</Select.Content>
			</Select.Root>
		</div>

		<div class="space-y-1">
			<div class="flex items-center justify-between">
				<Label class="text-[10px] text-muted-foreground">Font size</Label>
				<span class="font-mono text-[10px] text-muted-foreground">{clip.fontSizePx}px</span>
			</div>
			<Slider
				type="single"
				value={clip.fontSizePx ?? 22}
				min={12}
				max={72}
				step={1}
				onValueChange={(v) => projectStore.updateTitleLiverClip(clip.id, { fontSizePx: v })}
			/>
		</div>

		<div class="space-y-1">
			<div class="flex items-center justify-between">
				<Label class="text-[10px] text-muted-foreground">Scale</Label>
				<span class="font-mono text-[10px] text-muted-foreground"
					>{(clip.scale ?? 1).toFixed(2)}×</span
				>
			</div>
			<Slider
				type="single"
				value={clip.scale ?? 1}
				min={0.5}
				max={2}
				step={0.05}
				onValueChange={(v) => projectStore.updateTitleLiverClip(clip.id, { scale: v })}
			/>
		</div>

		<div class="space-y-1">
			<div class="flex items-center justify-between">
				<Label class="text-[10px] text-muted-foreground">Max width</Label>
				<span class="font-mono text-[10px] text-muted-foreground"
					>{Math.round((clip.maxWidthPct ?? 0.92) * 100)}%</span
				>
			</div>
			<Slider
				type="single"
				value={Math.round((clip.maxWidthPct ?? 0.92) * 100)}
				min={25}
				max={98}
				step={1}
				onValueChange={(v) =>
					projectStore.updateTitleLiverClip(clip.id, { maxWidthPct: v / 100 })}
			/>
		</div>

		<div class="space-y-1">
			<div class="flex items-center justify-between">
				<Label class="text-[10px] text-muted-foreground">Outline weight</Label>
				<span class="font-mono text-[10px] text-muted-foreground"
					>{(clip.outlineWidth ?? 1).toFixed(1)}</span
				>
			</div>
			<Slider
				type="single"
				value={clip.outlineWidth ?? 1}
				min={0}
				max={5}
				step={0.25}
				onValueChange={(v) => projectStore.updateTitleLiverClip(clip.id, { outlineWidth: v })}
			/>
		</div>

		<div class="grid grid-cols-2 gap-2">
			<div class="space-y-1">
				<Label class="text-[10px] text-muted-foreground">Start (ms)</Label>
				<Input
					type="number"
					class="h-7 font-mono text-[11px]"
					value={clip.startMs}
					oninput={(e) => {
						const n = Number((e.currentTarget as HTMLInputElement).value);
						if (Number.isFinite(n)) {
							projectStore.updateTitleLiverClip(clip.id, { startMs: n });
						}
					}}
				/>
			</div>
			<div class="space-y-1">
				<Label class="text-[10px] text-muted-foreground">End (ms)</Label>
				<Input
					type="number"
					class="h-7 font-mono text-[11px]"
					value={clip.endMs}
					oninput={(e) => {
						const n = Number((e.currentTarget as HTMLInputElement).value);
						if (Number.isFinite(n)) {
							projectStore.updateTitleLiverClip(clip.id, { endMs: n });
						}
					}}
				/>
			</div>
		</div>

		<div class="space-y-1">
			<Label class="text-[10px] text-muted-foreground">Accent</Label>
			<input
				type="color"
				class="h-7 w-full cursor-pointer rounded border border-border/55 bg-transparent"
				value={clip.accent}
				oninput={(e) =>
					projectStore.updateTitleLiverClip(clip.id, {
						accent: (e.currentTarget as HTMLInputElement).value
					})}
			/>
		</div>

		<p class="text-[9px] leading-snug text-muted-foreground">
			Arrow keys nudge on preview · Delete removes · Ctrl+D duplicates · Esc closes template panel
		</p>
	</section>
{/if}
