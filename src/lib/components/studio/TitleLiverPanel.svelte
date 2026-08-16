<script lang="ts">
	/**
	 * Title Liver — floating template browser only.
	 * Clip properties live in the right sidebar when a clip is selected.
	 */
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import TitleLiverTemplatePreview from '$lib/components/studio/TitleLiverTemplatePreview.svelte';
	import { projectStore, playback } from '$lib/stores/project.svelte';
	import { studioUi } from '$lib/stores/studio-ui.svelte';
	import { dndStore } from '$lib/stores/dnd.svelte';
	import {
		TITLE_LIVER_CATEGORIES,
		TITLE_LIVER_PRESETS,
		filterTitleLiverTemplates,
		titleLiverTemplate,
		titleLiverTemplatesByCategory
	} from '$lib/utils/title-liver';
	import { Plus, X, GripHorizontal, Crosshair } from '@lucide/svelte';
	import type { TitleLiverCategoryId, TitleLiverTemplateId } from '$lib/types/project';

	const open = $derived(studioUi.titleLiverOpen);
	const clip = $derived(projectStore.selectedTitleLiver);

	let panelX = $state(24);
	let panelY = $state(72);
	let drag: { ox: number; oy: number; px: number; py: number } | null = null;
	/** Highlight in gallery when nothing selected yet (last browsed). */
	let browseTemplateId = $state<TitleLiverTemplateId>('soft-bar');
	let activeCategory = $state<TitleLiverCategoryId>('all');
	let searchQuery = $state('');

	const gallerySelectedId = $derived(clip?.templateId ?? browseTemplateId);
	const filteredTemplates = $derived(
		filterTitleLiverTemplates(titleLiverTemplatesByCategory(activeCategory), searchQuery)
	);
	const activeCategoryDef = $derived(
		TITLE_LIVER_CATEGORIES.find((c) => c.id === activeCategory) ?? TITLE_LIVER_CATEGORIES[0]!
	);

	/** Only auto-jump category when timeline selection changes — not on every category click. */
	let syncedClipId = $state<string | null>(null);

	$effect(() => {
		if (!clip) {
			syncedClipId = null;
			return;
		}
		browseTemplateId = clip.templateId;
		if (syncedClipId === clip.id) return;
		syncedClipId = clip.id;
		activeCategory = titleLiverTemplate(clip.templateId).category;
	});

	function close() {
		studioUi.closeTitleLiver();
	}

	function onAdd(templateId?: TitleLiverTemplateId) {
		const id = templateId ?? browseTemplateId ?? 'soft-bar';
		const c = projectStore.addTitleLiverClip({
			templateId: id,
			startMs: playback.playheadMs
		});
		browseTemplateId = c.templateId;
		projectStore.setRightCollapsed(false);
		dndStore.flash(`Title Liver added · ${titleLiverTemplate(c.templateId).name}`);
	}

	function onPreset(presetId: string) {
		const n = projectStore.applyTitleLiverPreset(presetId, playback.playheadMs);
		dndStore.flash(n > 0 ? `Added pack · ${n} titles` : 'Pack failed');
	}

	function onTemplate(id: TitleLiverTemplateId) {
		browseTemplateId = id;
		if (!clip) return;
		const tmpl = titleLiverTemplate(id);
		projectStore.updateTitleLiverClip(clip.id, {
			templateId: id,
			accent: tmpl.previewAccent,
			x: tmpl.defaultX,
			y: tmpl.defaultY
		});
	}

	function onHeaderPointerDown(e: PointerEvent) {
		if ((e.target as HTMLElement).closest('button')) return;
		drag = { ox: e.clientX, oy: e.clientY, px: panelX, py: panelY };
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
	}

	function onHeaderPointerMove(e: PointerEvent) {
		if (!drag) return;
		panelX = Math.max(8, drag.px + (e.clientX - drag.ox));
		panelY = Math.max(8, drag.py + (e.clientY - drag.oy));
	}

	function onHeaderPointerUp() {
		drag = null;
	}
</script>

{#if open}
	<aside
		class="title-liver-panel"
		style="left: {panelX}px; top: {panelY}px;"
		role="dialog"
		aria-modal="false"
		aria-label="Title Liver"
	>
		<header
			class="title-liver-header"
			onpointerdown={onHeaderPointerDown}
			onpointermove={onHeaderPointerMove}
			onpointerup={onHeaderPointerUp}
		>
			<GripHorizontal class="size-3.5 shrink-0 opacity-50" />
			<span class="min-w-0 flex-1 truncate text-[12px] font-semibold tracking-wide">Title Liver</span>
			<Button
				size="icon-xs"
				variant="ghost"
				class="shrink-0"
				aria-label="Close Title Liver"
				onclick={close}
			>
				<X class="size-3.5" />
			</Button>
		</header>

		<div class="space-y-3 overflow-auto p-3">
			<p class="text-[10px] leading-snug text-muted-foreground">
				Browse templates, then Add. Edit text, font, and timing in the
				<span class="font-medium text-foreground">right sidebar</span> when a live title is
				selected.
			</p>

			<div class="flex flex-wrap gap-1.5">
				<Button size="sm" class="h-7 gap-1 text-[10px]" onclick={() => onAdd(gallerySelectedId)}>
					<Plus class="size-3" />
					Add · {titleLiverTemplate(gallerySelectedId).name}
				</Button>
				<Button
					size="sm"
					variant="outline"
					class="h-7 gap-1 text-[10px]"
					onclick={() => studioUi.toggleTitleSafeGuides()}
				>
					<Crosshair class="size-3" />
					{studioUi.titleSafeGuides ? 'Hide guides' : 'Safe guides'}
				</Button>
			</div>

			<div class="flex flex-wrap gap-1">
				{#each TITLE_LIVER_PRESETS as pack (pack.id)}
					<Button
						size="sm"
						variant="secondary"
						class="h-6 text-[9px]"
						title={pack.hint}
						onclick={() => onPreset(pack.id)}
					>
						{pack.label}
					</Button>
				{/each}
			</div>

			<Input
				class="h-7 text-[11px]"
				placeholder="Search templates…"
				value={searchQuery}
				oninput={(e) => (searchQuery = (e.currentTarget as HTMLInputElement).value)}
			/>

			<div class="tl-browser">
				<nav class="tl-cats" aria-label="Template categories">
					{#each TITLE_LIVER_CATEGORIES as cat (cat.id)}
						<button
							type="button"
							class="tl-cat"
							class:active={activeCategory === cat.id}
							title={cat.hint}
							onclick={() => (activeCategory = cat.id)}
						>
							<span class="tl-cat-label">{cat.label}</span>
							<span class="tl-cat-count">
								{titleLiverTemplatesByCategory(cat.id).length}
							</span>
						</button>
					{/each}
				</nav>

				<div class="tl-browser-main">
					<div class="flex items-baseline justify-between gap-2">
						<div class="min-w-0">
							<Label class="text-[10px] font-semibold tracking-[0.12em] text-foreground/75 uppercase"
								>{activeCategoryDef.label}</Label
							>
							<p class="truncate text-[9px] text-muted-foreground">{activeCategoryDef.hint}</p>
						</div>
						<span class="shrink-0 text-[9px] text-muted-foreground">Live preview</span>
					</div>
					{#if filteredTemplates.length === 0}
						<p
							class="rounded border border-dashed border-border/60 px-2 py-4 text-center text-[10px] text-muted-foreground"
						>
							No templates in this category.
						</p>
					{:else}
						<div class="tl-gallery">
							{#each filteredTemplates as t (t.id)}
								<TitleLiverTemplatePreview
									template={t}
									selected={gallerySelectedId === t.id}
									accent={clip && clip.templateId === t.id ? clip.accent : t.previewAccent}
									line1={clip && clip.templateId === t.id
										? clip.line1 || t.sampleLine1 || 'Sophea Chan'
										: t.sampleLine1 || 'Sophea Chan'}
									line2={clip && clip.templateId === t.id
										? clip.line2 || t.sampleLine2 || 'Guest host'
										: t.sampleLine2 || 'Guest host'}
									onclick={() => onTemplate(t.id)}
								/>
							{/each}
						</div>
					{/if}
				</div>
			</div>
		</div>
	</aside>
{/if}

<style>
	.title-liver-panel {
		position: fixed;
		z-index: 120;
		width: min(560px, calc(100vw - 24px));
		max-height: min(88vh, 820px);
		display: flex;
		flex-direction: column;
		overflow: hidden;
		border-radius: 12px;
		border: 1px solid color-mix(in oklab, var(--border) 85%, var(--primary));
		background: color-mix(in oklab, var(--card) 96%, var(--primary) 4%);
		box-shadow:
			0 16px 48px oklch(0.2 0.04 265 / 32%),
			0 0 0 1px color-mix(in oklab, var(--primary) 18%, transparent);
		pointer-events: auto;
	}

	.title-liver-header {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.45rem 0.55rem;
		border-bottom: 1px solid color-mix(in oklab, var(--border) 80%, transparent);
		cursor: grab;
		user-select: none;
		background: color-mix(in oklab, var(--muted) 55%, transparent);
	}

	.title-liver-header:active {
		cursor: grabbing;
	}

	.tl-browser {
		display: grid;
		grid-template-columns: 108px minmax(0, 1fr);
		gap: 0.55rem;
		min-height: 220px;
		align-items: start;
	}

	.tl-cats {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		padding: 0.25rem;
		border-radius: 8px;
		border: 1px solid color-mix(in oklab, var(--border) 75%, transparent);
		background: color-mix(in oklab, var(--muted) 40%, transparent);
	}

	.tl-cat {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.25rem;
		width: 100%;
		padding: 0.38rem 0.45rem;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: var(--muted-foreground);
		cursor: pointer;
		text-align: left;
		transition:
			background 120ms ease,
			color 120ms ease;
	}

	.tl-cat:hover {
		background: color-mix(in oklab, var(--background) 70%, transparent);
		color: var(--foreground);
	}

	.tl-cat.active {
		background: color-mix(in oklab, var(--primary) 18%, var(--background));
		color: var(--foreground);
		box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--primary) 35%, transparent);
	}

	.tl-cat-label {
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.02em;
	}

	.tl-cat-count {
		font-size: 9px;
		font-variant-numeric: tabular-nums;
		opacity: 0.65;
	}

	.tl-browser-main {
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
		min-width: 0;
	}

	.tl-gallery {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.55rem;
	}
</style>
