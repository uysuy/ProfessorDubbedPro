<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Film, FileAudio2, Captions, Upload } from '@lucide/svelte';
	import { classifyMediaFile, dndStore, isFileDrag } from '$lib/stores/dnd.svelte';
	import { projectStore } from '$lib/stores/project.svelte';

	let {
		children
	}: {
		children: Snippet;
	} = $props();

	let depth = $state(0);

	function onDragEnter(e: DragEvent) {
		if (!isFileDrag(e)) return;
		e.preventDefault();
		depth += 1;
		dndStore.setFileHover(true);
	}

	function onDragLeave(e: DragEvent) {
		if (!isFileDrag(e)) return;
		depth = Math.max(0, depth - 1);
		if (depth === 0) dndStore.setFileHover(false);
	}

	function onDragOver(e: DragEvent) {
		if (!isFileDrag(e)) return;
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
		dndStore.move(e.clientX, e.clientY);
		dndStore.setFileHover(true);
	}

	function onDrop(e: DragEvent) {
		if (!isFileDrag(e)) return;
		e.preventDefault();
		e.stopPropagation();
		depth = 0;
		dndStore.setFileHover(false);

		const files = Array.from(e.dataTransfer?.files ?? []);
		const media = files.filter((f) => classifyMediaFile(f) != null);
		if (!media.length) {
			dndStore.flash('Drop video, audio, or subtitle files');
			return;
		}
		const count = projectStore.importMediaFiles(media);
		const kinds = new Set(media.map((f) => classifyMediaFile(f)));
		const labels = [
			kinds.has('video') ? 'video' : null,
			kinds.has('audio') ? 'audio' : null,
			kinds.has('subtitle') ? 'subtitles' : null
		].filter(Boolean);
		dndStore.flash(
			count === 1
				? `Imported ${media[0].name}`
				: `Imported ${count} files (${labels.join(', ')})`
		);
	}
</script>

<div
	class="relative h-full min-h-0 min-w-0"
	ondragenter={onDragEnter}
	ondragleave={onDragLeave}
	ondragover={onDragOver}
	ondrop={onDrop}
	role="presentation"
>
	{@render children()}

	{#if dndStore.fileHover}
		<div class="file-drop-overlay" aria-live="polite">
			<div class="file-drop-card">
				<div class="file-drop-icon">
					<Upload class="size-6" />
				</div>
				<p class="file-drop-title">Drop media to import</p>
				<p class="file-drop-sub">Video · Audio · Subtitles</p>
				<div class="file-drop-kinds">
					<span><Film class="size-3.5" /> Video</span>
					<span><FileAudio2 class="size-3.5" /> Audio</span>
					<span><Captions class="size-3.5" /> Subs</span>
				</div>
			</div>
		</div>
	{/if}
</div>

<style>
	.file-drop-overlay {
		position: absolute;
		inset: 0;
		z-index: 40;
		display: grid;
		place-items: center;
		padding: 1.5rem;
		background:
			radial-gradient(circle at 50% 40%, color-mix(in oklab, var(--primary) 20%, transparent), transparent 58%),
			color-mix(in oklab, var(--background) 52%, transparent);
		backdrop-filter: blur(8px);
		animation: drop-fade var(--motion-fast) var(--motion-ease-out);
		pointer-events: none;
	}

	.file-drop-card {
		display: flex;
		min-width: min(100%, 22rem);
		flex-direction: column;
		align-items: center;
		gap: 0.45rem;
		border-radius: 1rem;
		border: 1.5px dashed color-mix(in oklab, var(--primary) 58%, var(--border));
		background: color-mix(in oklab, var(--card) 90%, var(--primary) 7%);
		padding: 1.35rem 1.5rem 1.2rem;
		box-shadow:
			var(--elevation-float),
			0 0 32px color-mix(in oklab, var(--primary) 14%, transparent);
		transform: scale(1.02);
		animation: drop-pop var(--motion-base) var(--motion-spring);
	}

	.file-drop-icon {
		display: grid;
		place-items: center;
		width: 2.75rem;
		height: 2.75rem;
		margin-bottom: 0.2rem;
		border-radius: 0.85rem;
		background: color-mix(in oklab, var(--primary) 16%, transparent);
		color: var(--primary);
		box-shadow: 0 0 18px color-mix(in oklab, var(--primary) 18%, transparent);
		animation: drop-icon-pulse 1.6s ease-in-out infinite;
	}

	.file-drop-title {
		margin: 0;
		font-size: 0.95rem;
		font-weight: 650;
		color: var(--foreground);
	}

	.file-drop-sub {
		margin: 0;
		font-size: 0.75rem;
		color: var(--muted-foreground);
	}

	.file-drop-kinds {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: 0.45rem;
		margin-top: 0.55rem;
	}

	.file-drop-kinds span {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		border-radius: 999px;
		border: 1px solid color-mix(in oklab, var(--border) 80%, transparent);
		background: color-mix(in oklab, var(--muted) 45%, transparent);
		padding: 0.2rem 0.55rem;
		font-size: 0.65rem;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--muted-foreground);
	}

	@keyframes drop-fade {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
	}

	@keyframes drop-pop {
		from {
			opacity: 0;
			transform: scale(0.94);
		}
		to {
			opacity: 1;
			transform: scale(1.02);
		}
	}

	@keyframes drop-icon-pulse {
		0%,
		100% {
			transform: scale(1);
			box-shadow: 0 0 14px color-mix(in oklab, var(--primary) 14%, transparent);
		}
		50% {
			transform: scale(1.05);
			box-shadow: 0 0 22px color-mix(in oklab, var(--primary) 28%, transparent);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.file-drop-icon {
			animation: none;
		}
	}
</style>
