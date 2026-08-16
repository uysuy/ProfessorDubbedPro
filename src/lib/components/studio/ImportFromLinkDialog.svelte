<script lang="ts">
	import { onDestroy } from 'svelte';
	import {
		Link2,
		LoaderCircle,
		Download,
		Clapperboard,
		ScanText,
		AlertTriangle,
		Play,
		Pause,
		Film,
		ExternalLink
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
		getMediaPreview,
		listenLinkImportProgress,
		parseClockToSeconds,
		resolveMediaLink,
		type MediaCandidate,
		type MediaPreviewInfo
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
	let listFilter = $state('');
	let startClock = $state('');
	let endClock = $state('');
	let writeSubs = $state(true);
	let runOcr = $state(false);
	let ocrInterval = $state('1');
	let rightsOk = $state(false);
	let toolsHint = $state('');
	let ocrReady = $state(false);
	let unlisten: (() => void) | null = null;

	let preview = $state<MediaPreviewInfo | null>(null);
	let previewLoading = $state(false);
	let previewError = $state<string | null>(null);
	let previewToken = 0;
	let previewVideoEl: HTMLVideoElement | undefined = $state();
	let previewPlaying = $state(false);

	const filteredEntries = $derived.by(() => {
		const q = listFilter.trim().toLowerCase();
		if (!q) return entries;
		return entries.filter((e) => {
			const hay = `${e.title} ${e.uploader ?? ''} ${e.site}`.toLowerCase();
			return hay.includes(q);
		});
	});

	function onOpenChange(v: boolean) {
		if (!v && busy) return;
		studioUi.linkImportOpen = v;
		if (!v) {
			stopPreviewPlayback();
			resetSoft();
		} else void refreshTools();
	}

	function resetSoft() {
		error = null;
		status = null;
		percent = 0;
		previewError = null;
		if (!busy) {
			step = 'paste';
			entries = [];
			selected = null;
			preview = null;
			listFilter = '';
			previewPlaying = false;
		}
	}

	function stopPreviewPlayback() {
		previewToken += 1;
		if (previewVideoEl) {
			try {
				previewVideoEl.pause();
				previewVideoEl.removeAttribute('src');
				previewVideoEl.load();
			} catch {
				/* ignore */
			}
		}
		previewPlaying = false;
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
		stopPreviewPlayback();
		unlisten?.();
		unlisten = null;
	});

	async function loadPreview(entry: MediaCandidate) {
		stopPreviewPlayback();
		preview = null;
		previewError = null;
		previewLoading = true;
		const token = ++previewToken;
		try {
			const info = await getMediaPreview(entry.webpageUrl);
			if (token !== previewToken) return;
			// Prefer richer metadata from preview probe when list was flat.
			preview = {
				...info,
				title: info.title && info.title !== entry.id ? info.title : entry.title,
				durationS: info.durationS ?? entry.durationS,
				thumbnail: info.thumbnail ?? entry.thumbnail
			};
			if (selected && selected.id === entry.id) {
				selected = {
					...entry,
					title: preview.title || entry.title,
					durationS: preview.durationS ?? entry.durationS,
					thumbnail: preview.thumbnail ?? entry.thumbnail
				};
			}
		} catch (e) {
			if (token !== previewToken) return;
			previewError = e instanceof Error ? e.message : String(e);
			preview = {
				kind: 'none',
				url: null,
				thumbnail: entry.thumbnail,
				title: entry.title,
				durationS: entry.durationS,
				webpageUrl: entry.webpageUrl,
				site: entry.site
			};
		} finally {
			if (token === previewToken) previewLoading = false;
		}
	}

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
		stopPreviewPlayback();
		preview = null;
		await ensureProgressListener();
		try {
			const result = await resolveMediaLink(raw);
			siteLabel = result.input.site;
			entries = result.entries;
			// Always show the list so the user can browse + preview before import options.
			selected = entries[0] ?? null;
			step = 'pick';
			status = null;
			if (selected) void loadPreview(selected);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
			step = 'paste';
		} finally {
			busy = false;
			percent = 0;
		}
	}

	function focusEntry(entry: MediaCandidate) {
		selected = entry;
		error = null;
		void loadPreview(entry);
	}

	function confirmSelection() {
		if (!selected) return;
		step = 'options';
		error = null;
		stopPreviewPlayback();
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
		stopPreviewPlayback();
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
		if (selected && entries.length) step = 'pick';
		else step = 'paste';
	}

	function toggleStreamPlay() {
		const el = previewVideoEl;
		if (!el) return;
		if (el.paused) {
			void el.play().then(() => {
				previewPlaying = true;
			});
		} else {
			el.pause();
			previewPlaying = false;
		}
	}

	async function openInBrowser(url: string) {
		window.open(url, '_blank', 'noopener,noreferrer');
	}
</script>

<Dialog.Root open={open} onOpenChange={onOpenChange}>
	<Dialog.Content
		class={step === 'pick' || (step === 'working' && entries.length > 0)
			? 'sm:max-w-4xl'
			: 'sm:max-w-lg'}
		showCloseButton={!busy}
	>
		<Dialog.Header>
			<Dialog.Title class="flex items-center gap-2">
				<Link2 class="size-4 text-primary" />
				Import from Link
			</Dialog.Title>
			<Dialog.Description>
				Browse matching videos, preview playback, then download into the studio timeline.
			</Dialog.Description>
		</Dialog.Header>

		{#if toolsHint && step === 'paste'}
			<p class="rounded-md border border-border/60 bg-muted/20 px-2.5 py-1.5 text-[11px] text-muted-foreground">
				{toolsHint}
			</p>
		{/if}

		{#if step === 'paste' || (step === 'working' && !entries.length)}
			<div class="space-y-3 py-1">
				<div class="space-y-1.5">
					<Label for="link-query">URL or search</Label>
					<Input
						id="link-query"
						placeholder="https://… or channel / movie / video name"
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
					Search returns a list you can preview before importing. Only use content you have the
					right to download and dub.
				</p>
			</div>
		{:else if step === 'pick' || (step === 'working' && entries.length > 0 && !busy)}
			<div class="grid gap-3 py-1 md:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
				<!-- Movie / video list -->
				<div class="flex min-h-0 flex-col gap-2">
					<div class="flex items-center justify-between gap-2">
						<p class="text-[11px] text-muted-foreground">
							<span class="font-medium text-foreground">{filteredEntries.length}</span>
							of {entries.length} · {siteLabel || 'results'}
						</p>
						{#if entries.length > 6}
							<Input
								class="h-7 max-w-[10rem] text-[11px]"
								placeholder="Filter list…"
								bind:value={listFilter}
								disabled={busy}
							/>
						{/if}
					</div>
					<div
						class="max-h-[22rem] space-y-1 overflow-y-auto rounded-md border border-border/60 bg-muted/10 p-1.5 pr-1"
						role="listbox"
						aria-label="Video list"
					>
						{#each filteredEntries as entry (entry.id + entry.webpageUrl)}
							{@const active = selected?.webpageUrl === entry.webpageUrl}
							<button
								type="button"
								role="option"
								aria-selected={active}
								class="flex w-full gap-2.5 rounded-md border px-2 py-2 text-left transition-colors
									{active
									? 'border-primary/50 bg-primary/10'
									: 'border-transparent bg-transparent hover:border-border/70 hover:bg-muted/40'}"
								onclick={() => focusEntry(entry)}
							>
								<div
									class="relative h-14 w-[5.5rem] shrink-0 overflow-hidden rounded bg-muted/50 ring-1 ring-border/50"
								>
									{#if entry.thumbnail}
										<img
											src={entry.thumbnail}
											alt=""
											class="size-full object-cover"
											loading="lazy"
											referrerpolicy="no-referrer"
										/>
									{:else}
										<div class="grid size-full place-items-center text-muted-foreground">
											<Film class="size-4 opacity-60" />
										</div>
									{/if}
									{#if entry.durationS != null}
										<span
											class="absolute right-0.5 bottom-0.5 rounded bg-black/75 px-1 font-mono text-[9px] text-white"
										>
											{formatSecondsClock(entry.durationS)}
										</span>
									{/if}
								</div>
								<span class="min-w-0 flex-1">
									<span class="line-clamp-2 text-[12px] font-medium text-foreground"
										>{entry.title}</span
									>
									<span class="mt-0.5 block truncate text-[10px] text-muted-foreground">
										{#if entry.uploader}{entry.uploader} · {/if}{entry.site}
									</span>
								</span>
							</button>
						{:else}
							<p class="px-2 py-6 text-center text-[11px] text-muted-foreground">
								No videos match this filter.
							</p>
						{/each}
					</div>
				</div>

				<!-- Preview pane -->
				<div class="flex min-h-0 flex-col gap-2">
					<p class="text-[11px] font-medium text-foreground">Preview</p>
					<div
						class="relative aspect-video w-full overflow-hidden rounded-md border border-border/70 bg-black/90"
					>
						{#if previewLoading}
							<div class="absolute inset-0 grid place-items-center gap-2 text-muted-foreground">
								<LoaderCircle class="size-6 animate-spin text-primary" />
								<span class="text-[11px]">Loading preview…</span>
							</div>
						{:else if preview?.kind === 'embed' && preview.url}
							<iframe
								title="Video preview"
								src={preview.url}
								class="size-full border-0"
								allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
								allowfullscreen
								referrerpolicy="strict-origin-when-cross-origin"
							></iframe>
						{:else if preview?.kind === 'stream' && preview.url}
							<video
								bind:this={previewVideoEl}
								class="size-full object-contain"
								src={preview.url}
								controls
								playsinline
								preload="metadata"
								onplay={() => (previewPlaying = true)}
								onpause={() => (previewPlaying = false)}
							>
								<track kind="captions" />
							</video>
						{:else if preview?.thumbnail}
							<img
								src={preview.thumbnail}
								alt=""
								class="size-full object-contain opacity-90"
								referrerpolicy="no-referrer"
							/>
							<div
								class="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-3 py-2 text-[10px] text-white/90"
							>
								Live stream preview unavailable — thumbnail only. You can still import.
							</div>
						{:else}
							<div class="absolute inset-0 grid place-items-center text-[11px] text-muted-foreground">
								Select a video to preview
							</div>
						{/if}
					</div>

					{#if selected}
						<div class="space-y-1">
							<p class="line-clamp-2 text-[12px] font-medium text-foreground">
								{preview?.title || selected.title}
							</p>
							<p class="text-[10px] text-muted-foreground">
								{selected.uploader ? `${selected.uploader} · ` : ''}
								{preview?.site || selected.site}
								{#if (preview?.durationS ?? selected.durationS) != null}
									· {formatSecondsClock((preview?.durationS ?? selected.durationS)!)}
								{/if}
							</p>
							{#if previewError}
								<p class="text-[10px] text-amber-700 dark:text-amber-400">{previewError}</p>
							{/if}
						</div>
						<div class="flex flex-wrap gap-2">
							{#if preview?.kind === 'stream' && preview.url}
								<Button size="sm" variant="secondary" onclick={toggleStreamPlay}>
									{#if previewPlaying}
										<Pause class="size-3.5" /> Pause
									{:else}
										<Play class="size-3.5" /> Play
									{/if}
								</Button>
							{/if}
							<Button
								size="sm"
								variant="outline"
								onclick={() => {
									const url = selected?.webpageUrl;
									if (url) openInBrowser(url);
								}}
							>
								<ExternalLink class="size-3.5" /> Open page
							</Button>
							<Button size="sm" disabled={!selected} onclick={confirmSelection}>
								Use this video
							</Button>
						</div>
					{/if}
				</div>
			</div>
		{:else if step === 'options' || (step === 'working' && selected)}
			<div class="space-y-3 py-1">
				<div class="flex gap-3 rounded-md border border-border/60 bg-muted/15 px-2.5 py-2">
					{#if selected?.thumbnail || preview?.thumbnail}
						<img
							src={selected?.thumbnail || preview?.thumbnail || ''}
							alt=""
							class="h-14 w-[5.5rem] shrink-0 rounded object-cover ring-1 ring-border/50"
							referrerpolicy="no-referrer"
						/>
					{/if}
					<div class="min-w-0">
						<p class="line-clamp-2 text-[12px] font-medium text-foreground">{selected?.title}</p>
						<p class="mt-0.5 text-[10px] text-muted-foreground">
							{selected?.site}
							{#if selected?.durationS != null}
								· {formatSecondsClock(selected.durationS)}
							{/if}
						</p>
					</div>
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

				<label
					class="flex items-start gap-2 rounded-md border border-amber-500/25 bg-amber-500/5 px-2.5 py-2 text-[11px] text-foreground"
				>
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
			<p
				class="rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-[11px] text-destructive whitespace-pre-wrap"
			>
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
							if (step === 'options') {
								step = 'pick';
								if (selected) void loadPreview(selected);
							} else {
								step = 'paste';
								stopPreviewPlayback();
								entries = [];
								selected = null;
								preview = null;
							}
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
				{:else if step === 'pick'}
					<Button size="sm" disabled={!selected || busy} onclick={confirmSelection}>
						Use this video
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
