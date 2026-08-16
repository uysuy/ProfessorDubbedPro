<script lang="ts">
	import { onDestroy } from 'svelte';
	import {
		Link2,
		LoaderCircle,
		Download,
		Clapperboard,
		ScanText,
		AlertTriangle
	} from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Progress } from '$lib/components/ui/progress/index.js';
	import { Checkbox } from '$lib/components/ui/checkbox/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { dndStore } from '$lib/stores/dnd.svelte';
	import { projectStore } from '$lib/stores/project.svelte';
	import { studioUi } from '$lib/stores/studio-ui.svelte';
	import { tempoStore } from '$lib/stores/tempo.svelte';
	import { isTauriRuntime } from '$lib/utils/platform';
	import {
		cancelLinkImport,
		downloadMediaLink,
		formatSecondsClock,
		getLinkImportToolsStatus,
		listenLinkImportProgress,
		parseClockToSeconds,
		resolveMediaLink,
		type MediaCandidate
	} from '$lib/utils/link-import';

	const open = $derived(studioUi.linkImportOpen);

	let query = $state('');
	let step = $state<'paste' | 'pick' | 'options' | 'working'>('paste');
	let busy = $state(false);
	let error = $state<string | null>(null);
	let status = $state<string | null>(null);
	let percent = $state(0);
	let siteLabel = $state('');
	let entries = $state<MediaCandidate[]>([]);
	let selected = $state<MediaCandidate | null>(null);
	let startClock = $state('');
	let endClock = $state('');
	let writeSubs = $state(true);
	let runOcr = $state(false);
	let ocrInterval = $state('1');
	let rightsOk = $state(false);
	let toolsHint = $state('');
	let ocrReady = $state(false);
	let unlisten: (() => void) | null = null;

	function onOpenChange(v: boolean) {
		if (!v && busy) return;
		studioUi.linkImportOpen = v;
		if (!v) resetSoft();
		else void refreshTools();
	}

	function resetSoft() {
		error = null;
		status = null;
		percent = 0;
		if (!busy) {
			step = 'paste';
			entries = [];
			selected = null;
		}
	}

	async function refreshTools() {
		if (!isTauriRuntime()) {
			toolsHint = 'Import from Link requires the desktop app (`pnpm tauri:dev`).';
			return;
		}
		try {
			const s = await getLinkImportToolsStatus();
			ocrReady = s.ocrReady;
			toolsHint = s.ytdlp
				? 'yt-dlp ready'
				: 'yt-dlp missing — run `pnpm ytdlp:download` and restart';
			if (runOcr && !ocrReady) {
				toolsHint += ' · OCR needs `pnpm ocr:setup`';
			}
		} catch (e) {
			toolsHint = e instanceof Error ? e.message : String(e);
		}
	}

	async function ensureProgressListener() {
		if (unlisten || !isTauriRuntime()) return;
		unlisten = await listenLinkImportProgress((p) => {
			percent = Math.max(0, Math.min(100, Math.round(p.percent)));
			status = p.message || p.stage;
		});
	}

	onDestroy(() => {
		unlisten?.();
		unlisten = null;
	});

	async function onLookup() {
		error = null;
		const raw = query.trim();
		if (!raw) {
			error = 'Paste a video URL, channel link, or search name.';
			return;
		}
		if (!isTauriRuntime()) {
			error = 'Import from Link requires the desktop app.';
			return;
		}
		busy = true;
		step = 'working';
		status = 'Resolving…';
		percent = 5;
		await ensureProgressListener();
		try {
			const result = await resolveMediaLink(raw);
			siteLabel = result.input.site;
			entries = result.entries;
			if (entries.length === 1) {
				selected = entries[0]!;
				step = 'options';
			} else {
				selected = entries[0] ?? null;
				step = 'pick';
			}
			status = null;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
			step = 'paste';
		} finally {
			busy = false;
			percent = 0;
		}
	}

	function chooseEntry(entry: MediaCandidate) {
		selected = entry;
		step = 'options';
		error = null;
	}

	async function onImport() {
		if (!selected) return;
		if (!rightsOk) {
			error = 'Confirm you have the right to download and dub this content.';
			return;
		}
		const startS = startClock.trim() ? parseClockToSeconds(startClock) : null;
		const endS = endClock.trim() ? parseClockToSeconds(endClock) : null;
		if (startClock.trim() && startS == null) {
			error = 'Start time must be MM:SS, HH:MM:SS, or seconds.';
			return;
		}
		if (endClock.trim() && endS == null) {
			error = 'End time must be MM:SS, HH:MM:SS, or seconds.';
			return;
		}
		if (startS != null && endS != null && endS <= startS) {
			error = 'End must be after start.';
			return;
		}

		busy = true;
		step = 'working';
		error = null;
		status = 'Downloading…';
		percent = 8;
		await ensureProgressListener();

		try {
			const result = await downloadMediaLink({
				url: selected.webpageUrl,
				title: selected.title,
				startS,
				endS,
				writeSubs,
				runOcr,
				ocrIntervalS: Number(ocrInterval) || 1
			});

			const ok = await projectStore.setVideoFromPath(result.videoPath);
			if (!ok) throw new Error('Downloaded, but could not open the video in the studio.');
			tempoStore.syncFromProject();

			if (result.subtitlePath) {
				try {
					const { readTextFile } = await import('@tauri-apps/plugin-fs');
					const raw = await readTextFile(result.subtitlePath);
					const { count } = projectStore.importSrtText(raw, {
						replace: true,
						fileName: result.subtitlePath.split(/[/\\]/).pop() || 'import.srt'
					});
					const src =
						result.subtitleSource === 'ocr'
							? 'OCR hardsubs'
							: result.subtitleSource === 'soft'
								? 'soft/auto subs'
								: 'subs';
					dndStore.flash(
						count > 0
							? `Imported “${result.title}” · ${count} cues from ${src}`
							: `Imported “${result.title}”`
					);
				} catch {
					dndStore.flash(`Imported “${result.title}” — subtitles skipped`);
				}
			} else {
				dndStore.flash(`Imported “${result.title}” — Extract Subs or Paste script next`);
			}

			studioUi.linkImportOpen = false;
			resetSoft();
			query = '';
			startClock = '';
			endClock = '';
			rightsOk = false;
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			if (/cancel/i.test(message)) {
				status = 'Cancelled';
				error = null;
			} else {
				error = message;
			}
			step = 'options';
		} finally {
			busy = false;
			percent = 0;
			status = null;
		}
	}

	async function onCancel() {
		await cancelLinkImport();
		busy = false;
		status = 'Cancelled';
		if (selected) step = 'options';
		else step = 'paste';
	}
</script>

<Dialog.Root open={open} onOpenChange={onOpenChange}>
	<Dialog.Content class="sm:max-w-lg" showCloseButton={!busy}>
		<Dialog.Header>
			<Dialog.Title class="flex items-center gap-2">
				<Link2 class="size-4 text-primary" />
				Import from Link
			</Dialog.Title>
			<Dialog.Description>
				Paste a video URL, channel link, or name. After import, edit on the same timeline —
				subtitles, arrangement, and Title Liver stay as usual.
			</Dialog.Description>
		</Dialog.Header>

		{#if toolsHint}
			<p class="rounded-md border border-border/60 bg-muted/20 px-2.5 py-1.5 text-[11px] text-muted-foreground">
				{toolsHint}
			</p>
		{/if}

		{#if step === 'paste' || (step === 'working' && !selected)}
			<div class="space-y-3 py-1">
				<div class="space-y-1.5">
					<Label for="link-query">URL or search</Label>
					<Input
						id="link-query"
						placeholder="https://… or channel / video name"
						bind:value={query}
						disabled={busy}
						onkeydown={(e) => {
							if (e.key === 'Enter') {
								e.preventDefault();
								void onLookup();
							}
						}}
					/>
				</div>
				<p class="text-[11px] leading-relaxed text-muted-foreground">
					Supported via yt-dlp (YouTube, Bilibili, and many others). Only import content you have
					the right to download and dub.
				</p>
			</div>
		{:else if step === 'pick'}
			<div class="space-y-2 py-1">
				<p class="text-[11px] text-muted-foreground">
					Site: <span class="font-medium text-foreground">{siteLabel || 'unknown'}</span>
					· pick a video
				</p>
				<div class="max-h-64 space-y-1 overflow-y-auto pr-1">
					{#each entries as entry (entry.id + entry.webpageUrl)}
						<button
							type="button"
							class="flex w-full flex-col gap-0.5 rounded-md border border-border/70 bg-muted/15 px-2.5 py-2 text-left transition-colors hover:border-primary/40 hover:bg-muted/35"
							onclick={() => chooseEntry(entry)}
						>
							<span class="line-clamp-2 text-[12px] font-medium text-foreground">{entry.title}</span>
							<span class="text-[10px] text-muted-foreground">
								{#if entry.uploader}{entry.uploader} · {/if}
								{#if entry.durationS != null}{formatSecondsClock(entry.durationS)} · {/if}
								{entry.site}
							</span>
						</button>
					{/each}
				</div>
			</div>
		{:else if step === 'options' || (step === 'working' && selected)}
			<div class="space-y-3 py-1">
				<div class="rounded-md border border-border/60 bg-muted/15 px-2.5 py-2">
					<p class="line-clamp-2 text-[12px] font-medium text-foreground">{selected?.title}</p>
					<p class="mt-0.5 text-[10px] text-muted-foreground">
						{selected?.site}
						{#if selected?.durationS != null}
							· {formatSecondsClock(selected.durationS)}
						{/if}
					</p>
				</div>

				<div class="grid grid-cols-2 gap-2">
					<div class="space-y-1">
						<Label for="link-start">Start (optional)</Label>
						<Input
							id="link-start"
							placeholder="0:00"
							bind:value={startClock}
							disabled={busy}
						/>
					</div>
					<div class="space-y-1">
						<Label for="link-end">End (optional)</Label>
						<Input id="link-end" placeholder="5:00" bind:value={endClock} disabled={busy} />
					</div>
				</div>
				<p class="text-[10px] text-muted-foreground">MM:SS or HH:MM:SS — leave blank for the full video.</p>

				<label class="flex items-start gap-2 text-[12px] text-foreground">
					<Checkbox bind:checked={writeSubs} disabled={busy} class="mt-0.5" />
					<span class="leading-snug">
						<span class="font-medium">Prefer soft / auto subtitles</span>
						<span class="block text-[10px] text-muted-foreground"
							>When the site provides them (best timing).</span
						>
					</span>
				</label>

				<label class="flex items-start gap-2 text-[12px] text-foreground">
					<Checkbox bind:checked={runOcr} disabled={busy} class="mt-0.5" />
					<span class="leading-snug">
						<span class="inline-flex items-center gap-1 font-medium"
							><ScanText class="size-3.5" /> OCR burned-in hardsubs</span
						>
						<span class="block text-[10px] text-muted-foreground">
							{#if ocrReady}
								Samples the bottom subtitle band (~every second).
							{:else}
								Needs <code class="text-[10px]">pnpm ocr:setup</code> first.
							{/if}
						</span>
					</span>
				</label>

				{#if runOcr}
					<div class="space-y-1 pl-6">
						<Label for="ocr-interval">OCR interval (seconds)</Label>
						<Input
							id="ocr-interval"
							class="max-w-24"
							bind:value={ocrInterval}
							disabled={busy}
						/>
					</div>
				{/if}

				<label class="flex items-start gap-2 rounded-md border border-amber-500/25 bg-amber-500/5 px-2.5 py-2 text-[11px] text-foreground">
					<Checkbox bind:checked={rightsOk} disabled={busy} class="mt-0.5" />
					<span class="leading-snug">
						<span class="inline-flex items-center gap-1 font-medium"
							><AlertTriangle class="size-3.5 text-amber-600 dark:text-amber-400" />
							I have the right to download and dub this media</span
						>
					</span>
				</label>
			</div>
		{/if}

		{#if busy || status}
			<div class="space-y-1.5">
				<div class="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
					<span class="truncate">{status || 'Working…'}</span>
					<span class="font-mono">{percent}%</span>
				</div>
				<Progress value={percent} class="h-1.5" />
			</div>
		{/if}

		{#if error}
			<p class="rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-[11px] text-destructive whitespace-pre-wrap">
				{error}
			</p>
		{/if}

		<Dialog.Footer class="gap-2 sm:justify-between">
			<div class="flex gap-2">
				{#if step === 'options' || step === 'pick'}
					<Button
						variant="ghost"
						size="sm"
						disabled={busy}
						onclick={() => {
							step = step === 'options' && entries.length > 1 ? 'pick' : 'paste';
							error = null;
						}}
					>
						Back
					</Button>
				{/if}
			</div>
			<div class="flex gap-2">
				{#if busy}
					<Button variant="outline" size="sm" onclick={() => void onCancel()}>Cancel</Button>
				{:else}
					<Button variant="outline" size="sm" onclick={() => onOpenChange(false)}>Close</Button>
				{/if}
				{#if step === 'paste'}
					<Button size="sm" disabled={busy || !query.trim()} onclick={() => void onLookup()}>
						{#if busy}
							<LoaderCircle class="size-3.5 animate-spin" />
						{:else}
							<Clapperboard class="size-3.5" />
						{/if}
						Look up
					</Button>
				{:else if step === 'options'}
					<Button size="sm" disabled={busy || !selected || !rightsOk} onclick={() => void onImport()}>
						{#if busy}
							<LoaderCircle class="size-3.5 animate-spin" />
						{:else}
							<Download class="size-3.5" />
						{/if}
						Download & open
					</Button>
				{/if}
			</div>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
