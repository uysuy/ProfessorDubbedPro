<script lang="ts">
	import { dndStore } from '$lib/stores/dnd.svelte';
	import { GripVertical, AudioLines, Film } from '@lucide/svelte';

	const drag = $derived(dndStore.drag);
	const pointer = $derived(dndStore.pointer);
</script>

{#if drag}
	<div
		class="dnd-ghost"
		style="transform: translate3d({pointer.x + 14}px, {pointer.y + 12}px, 0);"
		aria-hidden="true"
	>
		<div class="dnd-ghost-card" class:dnd-ghost-audio={drag.kind === 'tts-audio'}>
			<span class="dnd-ghost-icon">
				{#if drag.kind === 'cue-reorder'}
					<GripVertical class="size-3.5" />
				{:else if drag.kind === 'tts-audio'}
					<AudioLines class="size-3.5" />
				{:else}
					<Film class="size-3.5" />
				{/if}
			</span>
			<span class="dnd-ghost-text">
				<span class="dnd-ghost-title">{drag.label}</span>
				{#if drag.subtitle}
					<span class="dnd-ghost-sub">{drag.subtitle}</span>
				{/if}
			</span>
		</div>
	</div>
{/if}

{#if dndStore.feedback}
	<div class="dnd-toast" role="status">
		{dndStore.feedback}
	</div>
{/if}

<style>
	.dnd-ghost {
		position: fixed;
		top: 0;
		left: 0;
		z-index: 80;
		pointer-events: none;
		will-change: transform;
	}

	.dnd-ghost-card {
		display: flex;
		max-width: 240px;
		align-items: center;
		gap: 0.5rem;
		border-radius: 0.6rem;
		border: 1px solid color-mix(in oklab, var(--primary) 38%, var(--border));
		background: color-mix(in oklab, var(--card) 88%, var(--primary) 8%);
		padding: 0.45rem 0.65rem;
		box-shadow:
			var(--elevation-float),
			0 0 20px color-mix(in oklab, var(--primary) 12%, transparent);
		backdrop-filter: blur(12px);
		opacity: 0.97;
		transform: scale(1.045) rotate(-0.4deg);
		animation: dnd-ghost-in var(--motion-fast) var(--motion-spring);
	}

	.dnd-ghost-audio {
		border-color: color-mix(in oklab, var(--track-tts, #8b5cf6) 45%, var(--border));
		background: color-mix(in oklab, var(--card) 85%, var(--track-tts, #8b5cf6) 12%);
	}

	.dnd-ghost-icon {
		display: grid;
		size: 1.5rem;
		place-items: center;
		border-radius: 0.4rem;
		background: color-mix(in oklab, var(--primary) 16%, transparent);
		color: var(--primary);
		flex-shrink: 0;
	}

	.dnd-ghost-audio .dnd-ghost-icon {
		background: color-mix(in oklab, var(--track-tts, #8b5cf6) 18%, transparent);
		color: var(--track-tts, #8b5cf6);
	}

	.dnd-ghost-text {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 0.05rem;
	}

	.dnd-ghost-title {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--foreground);
	}

	.dnd-ghost-sub {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 0.65rem;
		color: var(--muted-foreground);
	}

	.dnd-toast {
		position: fixed;
		bottom: 1.25rem;
		left: 50%;
		z-index: 90;
		transform: translateX(-50%);
		border-radius: 0.65rem;
		border: 1px solid color-mix(in oklab, var(--primary) 32%, var(--border));
		background: color-mix(in oklab, var(--card) 92%, var(--primary) 6%);
		padding: 0.55rem 0.9rem;
		font-size: 0.75rem;
		font-weight: 500;
		color: var(--foreground);
		box-shadow:
			var(--elevation-float),
			0 0 24px color-mix(in oklab, var(--primary) 10%, transparent);
		backdrop-filter: blur(12px);
		animation: dnd-toast-in var(--motion-base) var(--motion-ease-out);
		pointer-events: none;
	}

	@keyframes dnd-ghost-in {
		from {
			opacity: 0;
			transform: scale(0.9) rotate(0deg);
		}
		to {
			opacity: 0.97;
			transform: scale(1.045) rotate(-0.4deg);
		}
	}

	@keyframes dnd-toast-in {
		from {
			opacity: 0;
			transform: translateX(-50%) translateY(10px) scale(0.96);
		}
		to {
			opacity: 1;
			transform: translateX(-50%) translateY(0) scale(1);
		}
	}
</style>
