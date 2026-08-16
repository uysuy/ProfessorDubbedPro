<script lang="ts">
	/**
	 * Full-frame export snapshot of a Title Liver clip at hold (fully appeared).
	 * Used so burned-in video matches the studio preview graphic.
	 */
	import type { TitleLiverClip } from '$lib/types/project';
	import TitleLiverGraphic from '$lib/components/studio/TitleLiverGraphic.svelte';
	import { sampleTitleLiverMotion, titleLiverTemplate } from '$lib/utils/title-liver';

	interface Props {
		clip: TitleLiverClip;
		width: number;
		height: number;
	}

	let { clip, width, height }: Props = $props();

	const designScale = $derived(Math.max(0.25, height / 720));
	const userScale = $derived(Math.max(0.5, Math.min(2, clip.scale ?? 1)));
	const maxW = $derived(Math.max(0.25, Math.min(0.98, clip.maxWidthPct ?? 0.92)));
	const fontPx = $derived(Math.max(8, (clip.fontSizePx ?? 22) * designScale * userScale));
	const outlinePx = $derived(Math.max(0, (clip.outlineWidth ?? 1.25) * designScale * userScale));
	const ax = $derived(Math.max(0.02, Math.min(0.98, clip.x ?? 0.5)));
	const ay = $derived(Math.max(0.02, Math.min(0.98, clip.y ?? 0.82)));
	const motion = $derived(sampleTitleLiverMotion(titleLiverTemplate(clip.templateId).anim, 1));

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
	/** Hold-state CSS vars — same channels as TitleLiverOverlay at full appear. */
	const gfxStyle = $derived(
		[
			`left: ${ax * 100}%`,
			`top: ${ay * 100}%`,
			`max-width: ${maxW * 100}%`,
			`--tl-accent: ${clip.accent}`,
			`--tl-op: ${motion.opacity}`,
			`--tl-tx: ${motion.tx}px`,
			`--tl-ty: ${motion.ty}px`,
			`--tl-sc: ${motion.sc * userScale}`,
			`--tl-blur: ${motion.blur}px`,
			`--tl-clip: ${motion.clip}`,
			`--tl-bar: ${motion.bar}`,
			`--tl-s1: ${motion.s1}`,
			`--tl-s2: ${motion.s2}`,
			`--tl-glow: ${motion.glow}`,
			`--tl-letter: ${motion.letterEm}em`,
			`--tl-flash: ${motion.flash}`,
			`--tl-font: ${fontStack}`,
			`--tl-size: ${fontPx}px`,
			`--tl-size2: ${Math.max(8, fontPx * 0.72)}px`,
			`--tl-shadow: ${textShadow}`
		].join('; ')
	);
</script>

<div class="tl-export-frame" style="width: {width}px; height: {height}px;">
	<div class="tl-export-anchor" style={gfxStyle}>
		<TitleLiverGraphic
			templateId={clip.templateId}
			line1={clip.line1}
			line2={clip.line2}
			line3={clip.line3 ?? ''}
		/>
	</div>
</div>

<style>
	.tl-export-frame {
		position: relative;
		overflow: hidden;
		background: transparent;
		container-type: size;
	}
	.tl-export-anchor {
		position: absolute;
		transform: translate(-50%, -50%);
		width: max-content;
		box-sizing: border-box;
		pointer-events: none;
	}
	.tl-export-anchor :global(.tl-gfx) {
		max-width: 100%;
		box-sizing: border-box;
	}
</style>
