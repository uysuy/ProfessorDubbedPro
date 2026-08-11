<script lang="ts">
	import { Captions, Clapperboard, Flame, LoaderCircle } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { dndStore } from '$lib/stores/dnd.svelte';
	import { projectStore } from '$lib/stores/project.svelte';
	import { runProjectExport, type ExportMode } from '$lib/utils/export';
	import { preferencesStore } from '$lib/stores/preferences.svelte';
	import { isTauriRuntime } from '$lib/utils/platform';
	import { cueEffectivePlaybackRate } from '$lib/utils/tts-fit';

	interface Props {
		open?: boolean;
	}

	let { open = $bindable(false) }: Props = $props();

	/** Burned-in matches the studio preview (always visible). */
	let mode = $state<ExportMode>(preferencesStore.defaultExportMode);
	let busy = $state(false);
	let status = $state<string | null>(null);
	let error = $state<string | null>(null);

	const cueCount = $derived(projectStore.current.cues.length);
	const exportableCount = $derived(
		projectStore.current.cues.filter(
			(c) => (c.translation?.trim() || c.source?.trim()).length > 0
		).length
	);
	const ttsClipCount = $derived(
		projectStore.current.cues.filter((c) => Boolean(c.assignedAudio?.filePath?.trim())).length
	);
	const originalGain = $derived(projectStore.originalAudioEffectiveGain);
	const hasVideo = $derived(Boolean(projectStore.videoUrl));
	const needsVideo = $derived(mode === 'videoSoftSubs' || mode === 'videoBurnedIn');
	const canExport = $derived(exportableCount > 0 && !busy && (mode === 'srt' || hasVideo));

	/** Export mirrors Align state — same rate / play-through as preview (no re-tempo). */
	function collectDubClips() {
		return projectStore.current.cues
			.filter((c) => Boolean(c.assignedAudio?.filePath?.trim()))
			.map((c) => {
				const span = Math.max(200, c.endMs - c.startMs);
				const audioDur =
					typeof c.assignedAudio?.durationMs === 'number' && c.assignedAudio.durationMs > 0
						? c.assignedAudio.durationMs
						: span;
				const playbackRate = cueEffectivePlaybackRate(c, 1);
				const durationMs = Math.max(200, Math.ceil(audioDur / playbackRate));
				return {
					path: c.assignedAudio!.filePath!.trim(),
					startMs: c.startMs,
					volume: Math.max(
						0,
						Math.min(1, (Number.isFinite(c.volume) ? c.volume : projectStore.volume) / 100)
					),
					durationMs,
					playbackRate: Math.round(playbackRate * 1000) / 1000
				};
			});
	}

	$effect(() => {
		if (!open) {
			busy = false;
			status = null;
			error = null;
		} else {
			mode = preferencesStore.defaultExportMode;
		}
	});

	async function onConfirm() {
		if (!canExport) return;
		error = null;
		busy = true;
		status = 'Starting export…';

		try {
			const result = await runProjectExport({
				mode,
				cues: projectStore.current.cues,
				projectName: projectStore.current.name,
				videoPath: projectStore.videoPath,
				videoFile: projectStore.videoFile,
				originalAudioGain: projectStore.originalAudioEffectiveGain,
				dubClips: collectDubClips(),
				subtitleStyle: projectStore.current.subtitleStyle,
				onStatus: (msg) => {
					status = msg;
				}
			});
			open = false;
			const label =
				result.mode === 'srt'
					? 'Subtitles exported'
					: result.mode === 'videoBurnedIn'
						? 'Video exported with burned-in subtitles'
						: 'Video exported with soft subtitles';
			dndStore.flash(label);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (message === 'Export cancelled.') {
				status = null;
				return;
			}
			error = message;
			status = null;
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-md" showCloseButton={!busy}>
		<Dialog.Header>
			<Dialog.Title>Export</Dialog.Title>
			<Dialog.Description>
				Video export mixes your TTS dub and respects Original Audio mute/volume. Soft subtitle
				tracks stay hidden until a player enables them — use burned-in for always-visible text.
			</Dialog.Description>
		</Dialog.Header>

		{#if needsVideo}
			<p class="rounded-md border border-border/60 bg-muted/25 px-2.5 py-2 text-[11px] text-muted-foreground">
				Audio:
				{#if originalGain < 0.02}
					<span class="font-medium text-foreground">original muted</span>
				{:else}
					<span class="font-medium text-foreground"
						>original {Math.round(originalGain * 100)}%</span
					>
				{/if}
				·
				{#if ttsClipCount > 0}
					<span class="font-medium text-foreground">{ttsClipCount} TTS clip(s)</span>
				{:else}
					<span class="text-amber-700 dark:text-amber-400">no TTS yet — Generate first</span>
				{/if}
			</p>
		{/if}

		<div class="grid gap-2 py-1">
			<button
				type="button"
				class="export-option {mode === 'srt' ? 'export-option-active' : ''}"
				disabled={busy}
				onclick={() => (mode = 'srt')}
			>
				<span class="export-option-icon">
					<Captions class="size-4" />
				</span>
				<span class="min-w-0 flex-1 text-left">
					<span class="block text-sm font-medium text-foreground">Export SRT only</span>
					<span class="mt-0.5 block text-xs text-muted-foreground">
						UTF-8 SubRip file ({exportableCount}/{cueCount} cues with text)
					</span>
				</span>
			</button>

			<button
				type="button"
				class="export-option {mode === 'videoBurnedIn' ? 'export-option-active' : ''}"
				disabled={busy || !hasVideo}
				onclick={() => (mode = 'videoBurnedIn')}
			>
				<span class="export-option-icon">
					<Flame class="size-4" />
				</span>
				<span class="min-w-0 flex-1 text-left">
					<span class="block text-sm font-medium text-foreground">
						Video + burned-in subtitles
						<span
							class="ml-1 text-[10px] font-semibold tracking-wide text-emerald-600 uppercase dark:text-emerald-400"
							>Recommended</span
						>
					</span>
					<span class="mt-0.5 block text-xs text-muted-foreground">
						{#if hasVideo}
							Hardcoded on the picture — always visible like the preview
						{:else}
							Load a source video first
						{/if}
					</span>
				</span>
			</button>

			<button
				type="button"
				class="export-option {mode === 'videoSoftSubs' ? 'export-option-active' : ''}"
				disabled={busy || !hasVideo}
				onclick={() => (mode = 'videoSoftSubs')}
			>
				<span class="export-option-icon">
					<Clapperboard class="size-4" />
				</span>
				<span class="min-w-0 flex-1 text-left">
					<span class="block text-sm font-medium text-foreground">Video + soft subtitles</span>
					<span class="mt-0.5 block text-xs text-muted-foreground">
						{#if hasVideo}
							Separate track — turn on CC/Subtitles in VLC or similar
						{:else}
							Load a source video first
						{/if}
					</span>
				</span>
			</button>
		</div>

		{#if !isTauriRuntime() && needsVideo}
			<p class="text-xs text-amber-700 dark:text-amber-400">
				Video export needs the desktop app (bundled FFmpeg is included there).
			</p>
		{/if}

		{#if status}
			<p class="flex items-center gap-2 text-xs text-muted-foreground">
				<LoaderCircle class="size-3.5 animate-spin" />
				{status}
			</p>
		{/if}

		{#if error}
			<p
				class="rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-xs text-destructive whitespace-pre-wrap"
			>
				{error}
			</p>
		{/if}

		<Dialog.Footer class="gap-2 sm:justify-end">
			<Button variant="outline" size="sm" disabled={busy} onclick={() => (open = false)}>
				Cancel
			</Button>
			<Button
				size="sm"
				class="bg-emerald-500 text-white hover:bg-emerald-400 hover:text-emerald-950"
				disabled={!canExport}
				onclick={onConfirm}
			>
				{#if busy}
					<LoaderCircle class="size-3.5 animate-spin" />
					Exporting…
				{:else}
					Export
				{/if}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<style>
	.export-option {
		display: flex;
		align-items: flex-start;
		gap: 0.75rem;
		width: 100%;
		border-radius: 0.75rem;
		border: 1px solid color-mix(in oklab, var(--border) 90%, transparent);
		background: color-mix(in oklab, var(--card) 88%, transparent);
		padding: 0.75rem 0.85rem;
		text-align: left;
		transition:
			border-color 140ms ease,
			background-color 140ms ease,
			box-shadow 140ms ease;
	}

	.export-option:hover:not(:disabled) {
		border-color: color-mix(in oklab, var(--primary) 35%, var(--border));
		background: color-mix(in oklab, var(--card) 70%, var(--primary) 6%);
	}

	.export-option:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}

	.export-option-active {
		border-color: color-mix(in oklab, var(--primary) 55%, var(--border));
		background: color-mix(in oklab, var(--card) 65%, var(--primary) 10%);
		box-shadow: 0 0 0 1px color-mix(in oklab, var(--primary) 22%, transparent);
	}

	.export-option-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2rem;
		height: 2rem;
		flex-shrink: 0;
		border-radius: 0.55rem;
		background: color-mix(in oklab, var(--muted) 80%, transparent);
		color: var(--muted-foreground);
	}

	.export-option-active .export-option-icon {
		background: color-mix(in oklab, var(--primary) 18%, var(--muted));
		color: var(--primary);
	}
</style>
