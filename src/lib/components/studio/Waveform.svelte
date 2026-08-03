<script lang="ts">
	interface Props {
		peaks: number[];
		color?: string;
		class?: string;
	}

	let { peaks, color = 'var(--track-tts)', class: className = '' }: Props = $props();

	/** Dense peak sets use tighter bars so zoomed-out audio doesn’t look chunky. */
	const step = $derived(peaks.length > 900 ? 1 : 2);
	const barWidth = $derived(peaks.length > 900 ? 0.65 : peaks.length > 400 ? 1 : 1.5);
</script>

<svg
	class="pointer-events-none h-full w-full {className}"
	viewBox="0 0 {Math.max(1, peaks.length * step)} 100"
	preserveAspectRatio="none"
	aria-hidden="true"
>
	{#each peaks as peak, i}
		{@const h = Math.max(7, peak * 94)}
		<rect
			x={i * step}
			y={(100 - h) / 2}
			width={barWidth}
			height={h}
			rx={peaks.length > 900 ? 0.2 : 0.55}
			fill={color}
			opacity={0.82 + peak * 0.18}
		/>
	{/each}
</svg>
