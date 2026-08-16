<script lang="ts">
	/**
	 * Live Title Liver graphic over the program monitor.
	 * Motion channels come from sampleTitleLiverMotion (same as dialog preview).
	 * Width is capped to the picture frame (container queries — not viewport).
	 */
	import type { TitleLiverClip } from '$lib/types/project';
	import TitleLiverGraphic from '$lib/components/studio/TitleLiverGraphic.svelte';
	import {
		sampleTitleLiverMotion,
		titleLiverExitFade,
		titleLiverLinearProgress,
		titleLiverTemplate
	} from '$lib/utils/title-liver';

	interface Props {
		clip: TitleLiverClip;
		playheadMs: number;
		designScale?: number;
		selected?: boolean;
		onSelect?: () => void;
		/** Double-click opens the Title Liver template browser. */
		onOpen?: () => void;
		onMove?: (x: number, y: number) => void;
	}

	let {
		clip,
		playheadMs,
		designScale = 1,
		selected = false,
		onSelect,
		onOpen,
		onMove
	}: Props = $props();

	const tmpl = $derived(titleLiverTemplate(clip.templateId));
	const anim = $derived(tmpl.anim);
	const kind = $derived(tmpl.kind);
	const motion = $derived(
		sampleTitleLiverMotion(anim, titleLiverLinearProgress(clip, playheadMs))
	);
	const exitFade = $derived(titleLiverExitFade(clip, playheadMs));
	const userScale = $derived(Math.max(0.5, Math.min(2, clip.scale ?? 1)));
	const maxW = $derived(Math.max(0.25, Math.min(0.98, clip.maxWidthPct ?? 0.92)));
	const fontPx = $derived(Math.max(8, (clip.fontSizePx ?? 22) * designScale * userScale));
	const outlinePx = $derived(Math.max(0, (clip.outlineWidth ?? 1.25) * designScale * userScale));
	const ax = $derived(Math.max(0.02, Math.min(0.98, clip.x ?? 0.5)));
	const ay = $derived(Math.max(0.02, Math.min(0.98, clip.y ?? 0.82)));

	function outlineShadow(w: number): string {
		const d = Math.max(0, Math.min(6, w));
		if (d < 0.05) return 'none';
		const a = d.toFixed(2);
		return [
			`-${a}px 0 0 #000`,
			`${a}px 0 0 #000`,
			`0 -${a}px 0 #000`,
			`0 ${a}px 0 #000`,
			`-${a}px -${a}px 0 #000`,
			`${a}px -${a}px 0 #000`,
			`-${a}px ${a}px 0 #000`,
			`${a}px ${a}px 0 #000`
		].join(', ');
	}

	const textShadow = $derived(outlineShadow(outlinePx));
	const fontStack = $derived(
		`'${clip.fontFamily || 'Noto Sans Khmer'}', var(--font-khmer), 'Noto Sans Khmer', sans-serif`
	);

	let drag: {
		pointerId: number;
		startX: number;
		startY: number;
		originX: number;
		originY: number;
		moved: boolean;
	} | null = null;

	function pictureBox(el: HTMLElement): DOMRect | null {
		const layer = el.closest('.video-picture-layer') as HTMLElement | null;
		return layer?.getBoundingClientRect() ?? null;
	}

	function onPointerDown(e: PointerEvent & { currentTarget: HTMLElement }) {
		e.stopPropagation();
		onSelect?.();
		if (!onMove) return;
		const box = pictureBox(e.currentTarget);
		if (!box || box.width < 2 || box.height < 2) return;
		drag = {
			pointerId: e.pointerId,
			startX: e.clientX,
			startY: e.clientY,
			originX: clip.x ?? 0.5,
			originY: clip.y ?? 0.82,
			moved: false
		};
		e.currentTarget.setPointerCapture(e.pointerId);
	}

	function onPointerMove(e: PointerEvent & { currentTarget: HTMLElement }) {
		if (!drag || e.pointerId !== drag.pointerId || !onMove) return;
		const box = pictureBox(e.currentTarget);
		if (!box || box.width < 2 || box.height < 2) return;
		const dx = (e.clientX - drag.startX) / box.width;
		const dy = (e.clientY - drag.startY) / box.height;
		if (!drag.moved && Math.hypot(dx, dy) < 0.004) return;
		drag = { ...drag, moved: true };
		onMove(
			Math.max(0.02, Math.min(0.98, drag.originX + dx)),
			Math.max(0.02, Math.min(0.98, drag.originY + dy))
		);
	}

	function onPointerUp(e: PointerEvent & { currentTarget: HTMLElement }) {
		if (!drag || e.pointerId !== drag.pointerId) return;
		drag = null;
		try {
			e.currentTarget.releasePointerCapture(e.pointerId);
		} catch {
			/* ignore */
		}
	}

	function onDblClick(e: MouseEvent) {
		e.stopPropagation();
		e.preventDefault();
		onSelect?.();
		onOpen?.();
	}
</script>

<button
	type="button"
	class="tl-root tl-{clip.templateId}"
	class:tl-selected={selected}
	class:tl-kind-card={kind === 'title-card' || kind === 'bumper'}
	class:tl-kind-lower={kind === 'lower-third'}
	class:tl-dragging={drag != null}
	data-anim={anim}
	style="left: {ax * 100}%; top: {ay * 100}%; max-width: min({maxW * 100}cqw, {maxW * 100}%); --tl-user-sc: {userScale}; --tl-exit: {exitFade}; --tl-accent: {clip.accent}; --tl-op: {motion.opacity * exitFade}; --tl-tx: {motion.tx}px; --tl-ty: {motion.ty}px; --tl-sc: {motion.sc * userScale}; --tl-blur: {motion.blur}px; --tl-clip: {motion.clip}; --tl-bar: {motion.bar}; --tl-s1: {motion.s1}; --tl-s2: {motion.s2}; --tl-glow: {motion.glow}; --tl-letter: {motion.letterEm}em; --tl-flash: {motion.flash}; --tl-font: {fontStack}; --tl-size: {fontPx}px; --tl-size2: {Math.max(8, fontPx * 0.72)}px; --tl-shadow: {textShadow};"
	aria-label="Title Liver overlay — drag to move, double-click for templates"
	title="Drag to move · Arrow keys nudge · Double-click for templates"
	onpointerdown={onPointerDown}
	onpointermove={onPointerMove}
	onpointerup={onPointerUp}
	onpointercancel={onPointerUp}
	ondblclick={onDblClick}
>
	<TitleLiverGraphic
		templateId={clip.templateId}
		line1={clip.line1}
		line2={clip.line2}
		line3={clip.line3 ?? ''}
	/>
</button>

<style>
	.tl-root {
		position: absolute;
		z-index: 4;
		border: 0;
		padding: 0;
		background: transparent;
		cursor: grab;
		text-align: left;
		pointer-events: auto;
		box-sizing: border-box;
		width: max-content;
		transform: translate(-50%, -50%);
		opacity: var(--tl-exit, 1);
	}

	.tl-root :global(.tl-gfx) {
		max-width: 100%;
		box-sizing: border-box;
	}

	.tl-dragging {
		cursor: grabbing;
	}

	.tl-selected {
		outline: 2px solid color-mix(in oklab, var(--tl-accent) 70%, white);
		outline-offset: 4px;
		border-radius: 6px;
	}
</style>
