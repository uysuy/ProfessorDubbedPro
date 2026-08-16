<script lang="ts">
	/**
	 * Looping mini-stage preview for a Title Liver template.
	 * Uses the same sampleTitleLiverMotion + TitleLiverGraphic as the live overlay.
	 */
	import { onMount } from 'svelte';
	import type { TitleLiverTemplateDef } from '$lib/utils/title-liver';
	import {
		sampleTitleLiverMotion,
		titleLiverPreviewExitFade,
		titleLiverPreviewLoopU
	} from '$lib/utils/title-liver';
	import TitleLiverGraphic from '$lib/components/studio/TitleLiverGraphic.svelte';

	interface Props {
		template: TitleLiverTemplateDef;
		selected?: boolean;
		accent?: string;
		line1?: string;
		line2?: string;
		line3?: string;
		onclick?: () => void;
	}

	let {
		template,
		selected = false,
		accent,
		line1 = 'Sophea Chan',
		line2 = 'Guest host',
		line3 = '',
		onclick
	}: Props = $props();

	const accentColor = $derived(accent?.trim() || template.previewAccent);

	let elapsedMs = $state(0);
	let raf = 0;

	const motion = $derived(
		sampleTitleLiverMotion(template.anim, titleLiverPreviewLoopU(elapsedMs, template.animMs))
	);
	const exitFade = $derived(titleLiverPreviewExitFade(elapsedMs, template.animMs));

	onMount(() => {
		const t0 = performance.now();
		const tick = (now: number) => {
			elapsedMs = now - t0;
			raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	});
</script>

<button
	type="button"
	class="tl-card"
	class:tl-card-selected={selected}
	style="--tl-accent: {accentColor};"
	aria-pressed={selected}
	aria-label="Preview {template.name}"
	{onclick}
>
	<div class="tl-stage" data-kind={template.kind}>
		<div class="tl-stage-grid" aria-hidden="true"></div>
		<div
			class="tl-motion"
			class:tl-motion-card={template.kind !== 'lower-third'}
			style="opacity: {exitFade}; --tl-op: {motion.opacity}; --tl-tx: {motion.tx * 0.55}px; --tl-ty: {motion.ty * 0.55}px; --tl-sc: {motion.sc}; --tl-blur: {motion.blur * 0.55}px; --tl-clip: {motion.clip}; --tl-bar: {motion.bar}; --tl-s1: {motion.s1}; --tl-s2: {motion.s2}; --tl-glow: {motion.glow}; --tl-letter: {motion.letterEm}em; --tl-flash: {motion.flash}; --tl-font: 'Outfit', var(--font-sans), sans-serif; --tl-size: 12px; --tl-size2: 9px; --tl-shadow: none;"
		>
			<TitleLiverGraphic
				templateId={template.id}
				{line1}
				{line2}
				line3={line3 || template.sampleLine3 || ''}
				compact
			/>
		</div>
	</div>
	<div class="tl-meta">
		<span class="tl-name">{template.name}</span>
		<span class="tl-kind">{template.kind.replace('-', ' ')}</span>
		<span class="tl-hint">{template.hint}</span>
	</div>
</button>

<style>
	.tl-card {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		width: 100%;
		padding: 0;
		border: 1px solid color-mix(in oklab, var(--border) 80%, transparent);
		border-radius: 10px;
		background: color-mix(in oklab, var(--card) 92%, transparent);
		text-align: left;
		overflow: hidden;
		cursor: pointer;
		transition:
			border-color 160ms ease,
			box-shadow 160ms ease,
			transform 160ms ease;
	}

	.tl-card:hover {
		border-color: color-mix(in oklab, var(--tl-accent) 45%, var(--border));
		transform: translateY(-1px);
	}

	.tl-card-selected {
		border-color: color-mix(in oklab, var(--primary) 55%, var(--border));
		box-shadow:
			0 0 0 1px color-mix(in oklab, var(--primary) 35%, transparent),
			0 10px 28px oklch(0.25 0.05 280 / 18%);
	}

	.tl-stage {
		position: relative;
		height: 102px;
		overflow: hidden;
		container-type: size;
		background:
			radial-gradient(120% 80% at 50% 0%, oklch(0.28 0.02 265 / 45%), transparent 55%),
			linear-gradient(165deg, oklch(0.2 0.02 260), oklch(0.12 0.015 255));
	}

	.tl-stage-grid {
		position: absolute;
		inset: 0;
		opacity: 0.22;
		background-image:
			linear-gradient(oklch(1 0 0 / 6%) 1px, transparent 1px),
			linear-gradient(90deg, oklch(1 0 0 / 6%) 1px, transparent 1px);
		background-size: 14px 14px;
		pointer-events: none;
	}

	.tl-motion {
		position: absolute;
		left: 8%;
		right: 8%;
		bottom: 12%;
		z-index: 1;
	}

	.tl-motion-card {
		left: 50%;
		right: auto;
		bottom: auto;
		top: 48%;
		width: max(58%, 140px);
		transform: translate(-50%, -50%);
	}

	.tl-meta {
		display: grid;
		gap: 0.1rem;
		padding: 0 0.55rem 0.55rem;
	}

	.tl-name {
		font-size: 11px;
		font-weight: 650;
		color: var(--foreground);
	}

	.tl-kind {
		font-size: 9px;
		text-transform: uppercase;
		letter-spacing: 0.1em;
		color: color-mix(in oklab, var(--tl-accent) 55%, var(--muted-foreground));
	}

	.tl-hint {
		font-size: 10px;
		line-height: 1.35;
		color: var(--muted-foreground);
	}
</style>
