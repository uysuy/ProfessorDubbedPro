<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Film, FileAudio2, Captions, Upload } from '@lucide/svelte';
	import { classifyMediaFile, dndStore, isFileDrag } from '$lib/stores/dnd.svelte';
	import { projectStore } from '$lib/stores/project.svelte';
	import { tempoStore } from '$lib/stores/tempo.svelte';

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

	async function onDrop(e: DragEvent) {
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
		const srt = media.find((f) => /\.srt$/i.test(f.name));
		const count = await projectStore.importMediaFiles(media);
		const kinds = new Set(media.map((f) => classifyMediaFile(f)));
		if (kinds.has('video')) tempoStore.syncFromProject();
		const labels = [
			kinds.has('video') ? 'video' : null,
			kinds.has('audio') ? 'audio' : null,
			kinds.has('subtitle') ? 'subtitles' : null
		].filter(Boolean);

		if (srt && projectStore.current.cues.length) {
			dndStore.flash(
				`Imported ${srt.name} · ${projectStore.current.cues.length} cue${projectStore.current.cues.length === 1 ? '' : 's'}`
			);
			return;
		}
		dndStore.flash(
			count === 1
				? `Imported ${media[0]!.name}`
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
				<p class="file-drop-sub">Video · Audio · SRT subtitles</p>
				<div class="file-drop-kinds">
					<span><Film class="size-3.5" /> Video</span>
					<span><FileAudio2 class="size-3.5" /> Audio</span>
					<span><Captions class="size-3.5" /> SRT</span>
				</div>
			</div>
		</div>
	{/if}
</div>

<style>
	.file-drop-overlay {
		pointer-events: none;
		position: absolute;
		inset: 0;
		z-index: 40;
		display: grid;
		place-items: center;
		background: color-mix(in oklab, var(--background) 55%, transparent);
		backdrop-filter: blur(6px);
	}

	.file-drop-card {
		display: flex;
		min-width: min(360px, 86vw);
		flex-direction: column;
		align-items: center;
		gap: 0.5rem;
		border-radius: 0.85rem;
		border: 1px dashed color-mix(in oklab, var(--primary) 45%, var(--border));
		background: color-mix(in oklab, var(--card) 92%, var(--primary));
		padding: 1.35rem 1.5rem;
		box-shadow: var(--elevation-panel);
	}

	.file-drop-icon {
		display: grid;
		width: 2.75rem;
		height: 2.75rem;
		place-items: center;
		border-radius: 999px;
		background: color-mix(in oklab, var(--primary) 14%, transparent);
		color: var(--primary);
	}

	.file-drop-title {
		font-size: 0.95rem;
		font-weight: 600;
		color: var(--foreground);
	}

	.file-drop-sub {
		font-size: 0.75rem;
		color: var(--muted-foreground);
	}

	.file-drop-kinds {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: 0.65rem;
		margin-top: 0.35rem;
		font-size: 0.7rem;
		color: var(--muted-foreground);
	}

	.file-drop-kinds span {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
	}
</style>
