<script lang="ts">
	import { onDestroy } from 'svelte';
	import {
		LayoutGrid,
		LoaderCircle,
		Download,
		Clapperboard,
		ScanText,
		AlertTriangle,
		Play,
		Pause,
		Film,
		ExternalLink,
		ChevronRight,
		Search
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
	import {
		DEFAULT_GALLERY_SHELF_ID,
		GALLERY_SITE_FILTERS,
		gallerySearchQuery,
		galleryShelfById,
		galleryShelvesForSite,
		type GalleryShelf,
		type GallerySiteId
	} from '$lib/utils/video-gallery';

	const open = $derived(studioUi.linkImportOpen);

	let query = $state('');
	/** `browse` = gallery + list + preview. `options` = download settings. */
	let step = $state<'browse' | 'options'>('browse');
	let busy = $state(false);
	let loadingMore = $state(false);
	let error = $state<string | null>(null);
	let status = $state<string | null>(null);
	let percent = $state(0);
	let siteLabel = $state('');
	let listLabel = $state('results');
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
	let siteFilter = $state<GallerySiteId>('all');
	let activeShelfId = $state(DEFAULT_GALLERY_SHELF_ID);
	let showCustomLookup = $state(false);
	let autoLoadToken = 0;
	/** Index into shelf.moreSeeds for catalog/DM pagination. */
	let moreSeedIndex = $state(0);
	/** Next 1-based playlist index for channel / episode pages. */
	let nextPlaylistStart = $state(1);
	let hasMore = $state(true);
	/** Seed used for the current list (series URL when drilling episodes). */
	let activeListSeed = $state('');
	let episodeMode = $state(false);

	/** Stack of previous lists so Back from episodes returns to movies. */
	let listStack = $state<{ entries: MediaCandidate[]; listLabel: string; siteLabel: string }[]>(
		[]
	);

	let preview = $state<MediaPreviewInfo | null>(null);
	let previewLoading = $state(false);
	let previewError = $state<string | null>(null);
	let previewToken = 0;
	let previewVideoEl: HTMLVideoElement | undefined = $state();
	let previewPlaying = $state(false);

	const visibleShelves = $derived(galleryShelvesForSite(siteFilter));
	const activeShelf = $derived(galleryShelfById(activeShelfId) ?? visibleShelves[0] ?? null);

	const filteredEntries = $derived.by(() => {
		const q = listFilter.trim().toLowerCase();
		if (!q) return entries;
		return entries.filter((e) => {
			const hay = `${e.title} ${e.uploader ?? ''} ${e.site}`.toLowerCase();
			return hay.includes(q);
		});
	});

	const selectedIsSeries = $derived((selected?.kind || 'video') === 'series');

	function onOpenChange(v: boolean) {
		if (!v && busy) return;
		studioUi.linkImportOpen = v;
		if (!v) {
			stopPreviewPlayback();
			resetSoft();
		} else {
			void refreshTools();
			void openDefaultShelf();
		}
	}

	function resetSoft() {
		error = null;
		status = null;
		percent = 0;
		previewError = null;
		if (!busy) {
			step = 'browse';
			entries = [];
			selected = null;
			preview = null;
			listFilter = '';
			previewPlaying = false;
			listStack = [];
			listLabel = 'results';
			siteLabel = '';
			showCustomLookup = false;
			moreSeedIndex = 0;
			nextPlaylistStart = 1;
			hasMore = true;
			activeListSeed = '';
			episodeMode = false;
			loadingMore = false;
		}
	}

	function resetPagingForShelf(shelf: GalleryShelf) {
		moreSeedIndex = 0;
		nextPlaylistStart = 1;
		hasMore = true;
		activeListSeed = shelf.seed;
		episodeMode = false;
		const mode = shelf.mode ?? 'catalog';
		if (mode === 'catalog') {
			hasMore = (shelf.moreSeeds?.length ?? 0) > 0;
		} else if (mode === 'search' || mode === 'playlist') {
			hasMore = true;
		}
	}

	async function openDefaultShelf() {
		const shelves = galleryShelvesForSite(siteFilter);
		const shelf =
			shelves.find((s) => s.id === activeShelfId) ??
			shelves.find((s) => s.id === DEFAULT_GALLERY_SHELF_ID) ??
			shelves[0];
		if (!shelf) return;
		await loadShelf(shelf, false);
	}

	async function loadShelf(shelf: GalleryShelf, clearEpisodeStack = true) {
		activeShelfId = shelf.id;
		if (clearEpisodeStack) listStack = [];
		resetPagingForShelf(shelf);
		const token = ++autoLoadToken;
		const pageSize = shelf.pageSize ?? 24;
		const mode = shelf.mode ?? 'catalog';
		if (mode === 'search') {
			await runResolve(gallerySearchQuery(shelf.seed, pageSize), false, {
				replace: true
			});
			nextPlaylistStart = pageSize + 1;
		} else if (mode === 'playlist') {
			await runResolve(shelf.seed, false, {
				replace: true,
				playlistStart: 1,
				playlistEnd: pageSize
			});
			nextPlaylistStart = pageSize + 1;
		} else {
			await runResolve(shelf.seed, false, { replace: true });
		}
		if (token !== autoLoadToken) return;
	}

	function onSiteFilter(id: GallerySiteId) {
		siteFilter = id;
		const shelves = galleryShelvesForSite(id);
		const next =
			shelves.find((s) => s.id === activeShelfId) ??
			shelves.find((s) => s.id === DEFAULT_GALLERY_SHELF_ID) ??
			shelves[0];
		if (next) void loadShelf(next, true);
	}

	function mergeEntries(incoming: MediaCandidate[]): number {
		const seen = new Set(entries.map((e) => e.id + '|' + e.webpageUrl));
		const added: MediaCandidate[] = [];
		for (const e of incoming) {
			const key = e.id + '|' + e.webpageUrl;
			if (seen.has(key)) continue;
			seen.add(key);
			added.push({ ...e, kind: e.kind || 'video' });
		}
		if (added.length) entries = [...entries, ...added];
		return added.length;
	}

	async function loadMore() {
		if (!hasMore || loadingMore || busy) return;
		const shelf = activeShelf;
		if (!shelf && !episodeMode) return;

		loadingMore = true;
		error = null;
		try {
			if (episodeMode && activeListSeed) {
				const pageSize = 40;
				const start = Math.max(1, nextPlaylistStart);
				const end = start + pageSize - 1;
				const result = await resolveMediaLink(activeListSeed, {
					playlistStart: start,
					playlistEnd: end
				});
				const n = mergeEntries(result.entries);
				nextPlaylistStart = end + 1;
				if (n === 0 || result.entries.length < pageSize / 2) hasMore = false;
				return;
			}

			if (!shelf) return;
			const mode = shelf.mode ?? 'catalog';
			const pageSize = shelf.pageSize ?? 24;

			if (mode === 'catalog') {
				const seeds = shelf.moreSeeds ?? [];
				if (moreSeedIndex >= seeds.length) {
					hasMore = false;
					return;
				}
				const seed = seeds[moreSeedIndex]!;
				moreSeedIndex += 1;
				const result = await resolveMediaLink(seed);
				mergeEntries(result.entries);
				if (moreSeedIndex >= seeds.length) hasMore = false;
				return;
			}

			if (mode === 'search') {
				const total = nextPlaylistStart + pageSize - 1;
				const result = await resolveMediaLink(gallerySearchQuery(shelf.seed, total));
				const fresh = result.entries.slice(nextPlaylistStart - 1);
				const n = mergeEntries(fresh);
				nextPlaylistStart = total + 1;
				if (n === 0 || fresh.length < pageSize / 2) hasMore = false;
				return;
			}

			if (mode === 'playlist') {
				const start = Math.max(1, nextPlaylistStart);
				const end = start + pageSize - 1;
				const result = await resolveMediaLink(shelf.seed, {
					playlistStart: start,
					playlistEnd: end
				});
				const n = mergeEntries(result.entries);
				nextPlaylistStart = end + 1;
				if (n === 0 || result.entries.length < pageSize / 2) {
					// Try moreSeeds if playlist exhausted
					const seeds = shelf.moreSeeds ?? [];
					if (moreSeedIndex < seeds.length) {
						const seed = seeds[moreSeedIndex]!;
						moreSeedIndex += 1;
						const extra = await resolveMediaLink(seed, {
							playlistStart: 1,
							playlistEnd: pageSize
						});
						mergeEntries(extra.entries);
						nextPlaylistStart = pageSize + 1;
						activeListSeed = seed;
					} else {
						hasMore = false;
					}
				}
			}
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
			hasMore = false;
		} finally {
			loadingMore = false;
		}
	}

	function onListScroll(e: Event & { currentTarget: HTMLDivElement }) {
		const el = e.currentTarget;
		if (el.scrollTop + el.clientHeight >= el.scrollHeight - 48) {
			void loadMore();
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
			toolsHint = 'Video Gallery requires the desktop app (`pnpm tauri:dev`).';
			return;
		}
		try {
			const s = await getLinkImportToolsStatus();
			ocrReady = s.ocrReady;
			toolsHint = s.ytdlp
				? 'yt-dlp ready · gallery streams skip site ads when possible'
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
		previewError = null;

		// Instant poster from list row — never block the UI waiting on yt-dlp first.
		preview = {
			kind: 'none',
			url: null,
			thumbnail: entry.thumbnail,
			title: entry.title,
			durationS: entry.durationS,
			webpageUrl: entry.webpageUrl,
			site: entry.site
		};

		if ((entry.kind || 'video') === 'series') {
			previewLoading = false;
			return;
		}

		const token = ++previewToken;
		previewLoading = true;
		// Debounce so rapid list clicks don't queue many yt-dlp jobs.
		const isFastEmbed =
			/youtube\.com|youtu\.be|bilibili\.com|b23\.tv/i.test(entry.webpageUrl) ||
			/youtube|bilibili/i.test(entry.site);
		await new Promise((r) => setTimeout(r, isFastEmbed ? 120 : 400));
		if (token !== previewToken) return;

		try {
			const info = await getMediaPreview(entry.webpageUrl);
			if (token !== previewToken) return;
			preview = {
				...info,
				title:
					info.title && info.title !== entry.id && info.title !== 'Preview'
						? info.title
						: entry.title,
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

	async function runResolve(
		raw: string,
		pushStack: boolean,
		opts?: {
			replace?: boolean;
			playlistStart?: number;
			playlistEnd?: number;
		}
	) {
		error = null;
		if (!isTauriRuntime()) {
			error = 'Video Gallery requires the desktop app.';
			return;
		}
		// Cancel any in-flight yt-dlp so shelf/episode switches stay responsive.
		await cancelLinkImport().catch(() => undefined);
		busy = true;
		status = 'Loading gallery…';
		percent = 5;
		stopPreviewPlayback();
		await ensureProgressListener();
		try {
			const result = await resolveMediaLink(raw, {
				playlistStart: opts?.playlistStart,
				playlistEnd: opts?.playlistEnd
			});
			if (pushStack && entries.length) {
				listStack = [
					...listStack,
					{ entries: [...entries], listLabel, siteLabel }
				];
			}
			siteLabel = result.input.site;
			listLabel = result.listLabel || (result.entries.length > 1 ? 'results' : 'video');
			const mapped = result.entries.map((e) => ({
				...e,
				kind: e.kind || 'video'
			}));
			if (opts?.replace === false) {
				mergeEntries(mapped);
			} else {
				entries = mapped;
			}
			selected = entries[0] ?? null;
			step = 'browse';
			status = null;
			listFilter = '';
			// Poster only at first — stream preview resolves after debounce (non-blocking).
			if (selected) void loadPreview(selected);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
			if (opts?.replace !== false) {
				entries = [];
				selected = null;
				preview = null;
			}
		} finally {
			busy = false;
			percent = 0;
		}
	}

	async function onLookup() {
		const raw = query.trim();
		if (!raw) {
			error = 'Enter a search name or paste a supported URL.';
			return;
		}
		listStack = [];
		episodeMode = false;
		moreSeedIndex = 0;
		nextPlaylistStart = 1;
		hasMore = true;
		activeListSeed = raw;
		await runResolve(raw, false, { replace: true });
	}

	function focusEntry(entry: MediaCandidate) {
		selected = entry;
		error = null;
		void loadPreview(entry);
	}

	async function openSeriesOrConfirm() {
		if (!selected) return;
		if ((selected.kind || 'video') === 'series') {
			activeListSeed = selected.webpageUrl;
			episodeMode = true;
			nextPlaylistStart = 1;
			hasMore = true;
			moreSeedIndex = 0;
			await runResolve(selected.webpageUrl, true, {
				replace: true,
				playlistStart: 1,
				playlistEnd: 24
			});
			nextPlaylistStart = 25;
			return;
		}
		step = 'options';
		error = null;
		stopPreviewPlayback();
	}

	function popListStack() {
		const prev = listStack[listStack.length - 1];
		if (!prev) return false;
		listStack = listStack.slice(0, -1);
		entries = prev.entries;
		listLabel = prev.listLabel;
		siteLabel = prev.siteLabel;
		episodeMode = false;
		const shelf = activeShelf;
		if (shelf) resetPagingForShelf(shelf);
		selected = entries[0] ?? null;
		if (selected) void loadPreview(selected);
		else {
			preview = null;
		}
		return true;
	}

	async function onImport() {
		if (!selected || (selected.kind || 'video') === 'series') return;
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
		step = 'browse';
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

	function openInBrowser(url: string) {
		window.open(url, '_blank', 'noopener,noreferrer');
	}
</script>

<Dialog.Root open={open} onOpenChange={onOpenChange}>
	<Dialog.Content
		class="flex max-h-[min(90vh,880px)] w-full max-w-[min(64rem,calc(100%-2rem))] flex-col gap-3 overflow-hidden p-4 sm:max-w-[min(64rem,calc(100%-2rem))]"
		showCloseButton={!busy}
	>
		<Dialog.Header class="shrink-0 pr-8 text-left">
			<Dialog.Title class="flex items-center gap-2">
				<LayoutGrid class="size-4 text-primary" />
				Video Gallery
			</Dialog.Title>
			<Dialog.Description>
				Browse WeTV & YouTube drama shelves. Preview with yt-dlp streams, open episodes, then use a
				video.
			</Dialog.Description>
		</Dialog.Header>

		{#if toolsHint}
			<p
				class="shrink-0 rounded-md border border-border/60 bg-muted/20 px-2.5 py-1.5 text-[11px] text-muted-foreground"
			>
				{toolsHint}
			</p>
		{/if}

		<div class="gallery-body min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto">
		{#if step === 'browse'}
			<div class="min-w-0 space-y-3 py-1">
				<!-- Site filter + list filter -->
				<div class="flex min-w-0 flex-wrap items-center gap-2">
					<div
						class="inline-flex max-w-full flex-wrap gap-0.5 rounded-lg border border-border/60 bg-muted/20 p-0.5"
						role="tablist"
						aria-label="Gallery source"
					>
						{#each GALLERY_SITE_FILTERS as chip (chip.id)}
							<button
								type="button"
								role="tab"
								aria-selected={siteFilter === chip.id}
								class="rounded-md px-3 py-1.5 text-[11px] transition-colors
									{siteFilter === chip.id
									? 'bg-background font-medium text-foreground shadow-sm'
									: 'text-muted-foreground hover:text-foreground'}"
								disabled={busy}
								onclick={() => onSiteFilter(chip.id)}
							>
								{chip.label}
							</button>
						{/each}
					</div>
					<div class="min-w-0 flex-1 basis-[10rem]">
						<Input
							class="h-8 w-full min-w-0 text-[11px]"
							placeholder="Filter titles…"
							bind:value={listFilter}
							disabled={busy || !entries.length}
						/>
					</div>
				</div>

				<!-- Shelves: compact single-line chips -->
				<div class="gallery-shelves flex min-w-0 max-w-full gap-2 overflow-x-auto pb-1">
					{#each visibleShelves as shelf (shelf.id)}
						<button
							type="button"
							class="shrink-0 rounded-full border px-3.5 py-1.5 text-[11px] whitespace-nowrap transition-colors
								{activeShelfId === shelf.id && !episodeMode
								? 'border-primary/60 bg-primary/15 font-medium text-foreground'
								: 'border-border/50 bg-background text-muted-foreground hover:border-border hover:text-foreground'}"
							disabled={busy}
							title={shelf.description}
							onclick={() => void loadShelf(shelf, true)}
						>
							<span class="text-[10px] opacity-70">{shelf.site === 'wetv' ? 'WeTV' : shelf.site === 'youtube' ? 'YT' : 'DM'}</span>
							· {shelf.label}
						</button>
					{/each}
				</div>

				<div class="flex min-w-0 flex-wrap items-center justify-between gap-2">
					<p class="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
						{#if episodeMode}
							<span class="font-medium text-foreground">Episodes</span>
							· Back returns to series
						{:else if activeShelf}
							<span class="font-medium text-foreground"
								>{activeShelf.site === 'wetv' ? 'WeTV' : activeShelf.site === 'youtube' ? 'YouTube' : 'Dailymotion'}
								· {activeShelf.label}</span
							>
						{/if}
						{#if entries.length}
							· <span class="font-medium text-foreground">{filteredEntries.length}</span>
							{#if filteredEntries.length !== entries.length}
								/ {entries.length}
							{/if}
							{listLabel}
						{/if}
					</p>
					<button
						type="button"
						class="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
						onclick={() => (showCustomLookup = !showCustomLookup)}
					>
						<Search class="size-3" />
						{showCustomLookup ? 'Hide search' : 'Custom search'}
					</button>
				</div>

				{#if showCustomLookup}
					<div class="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
						<Input
							id="link-query"
							class="h-8 min-w-0 flex-1 text-[12px]"
							placeholder="Paste URL or type a search name"
							bind:value={query}
							disabled={busy}
							onkeydown={(e) => {
								if (e.key === 'Enter') {
									e.preventDefault();
									void onLookup();
								}
							}}
						/>
						<Button
							size="sm"
							class="shrink-0"
							disabled={busy || !query.trim()}
							onclick={() => void onLookup()}
						>
							{#if busy && !entries.length}
								<LoaderCircle class="size-3.5 animate-spin" />
							{:else}
								<Clapperboard class="size-3.5" />
							{/if}
							Look up
						</Button>
					</div>
				{/if}

				<!-- List + preview -->
				<div class="grid min-w-0 gap-3 md:grid-cols-2">
					<div class="flex min-h-0 min-w-0 flex-col gap-2">
						<div
							class="max-h-[min(24rem,42vh)] min-h-[12rem] space-y-1 overflow-y-auto rounded-lg border border-border/60 bg-muted/10 p-2"
							role="listbox"
							aria-label="Video gallery list"
							onscroll={onListScroll}
						>
							{#if busy && !entries.length}
								<div class="grid place-items-center gap-2 px-2 py-10 text-muted-foreground">
									<LoaderCircle class="size-5 animate-spin text-primary" />
									<span class="text-[11px]">Loading shelf…</span>
								</div>
							{:else if filteredEntries.length}
								{#each filteredEntries as entry (entry.id + entry.webpageUrl)}
									{@const active = selected?.webpageUrl === entry.webpageUrl}
									{@const isSeries = (entry.kind || 'video') === 'series'}
									<button
										type="button"
										role="option"
										aria-selected={active}
										class="flex w-full gap-2.5 rounded-md border px-2.5 py-2 text-left transition-colors
											{active
											? 'border-primary/50 bg-primary/10'
											: 'border-transparent bg-transparent hover:border-border/70 hover:bg-muted/40'}"
										onclick={() => focusEntry(entry)}
										ondblclick={() => {
											focusEntry(entry);
											void openSeriesOrConfirm();
										}}
									>
										<div
											class="relative h-14 w-[5.5rem] shrink-0 overflow-hidden rounded-md bg-muted/50 ring-1 ring-border/50"
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
											{:else if isSeries}
												<span
													class="absolute right-0.5 bottom-0.5 rounded bg-black/75 px-1 text-[9px] text-white"
												>
													Series
												</span>
											{/if}
										</div>
										<span class="min-w-0 flex-1">
											<span class="line-clamp-2 text-[12px] font-medium text-foreground"
												>{entry.title}</span
											>
											<span class="mt-0.5 flex items-center gap-1 truncate text-[10px] text-muted-foreground">
												{#if entry.uploader && entry.uploader !== entry.title}
													<span class="truncate">{entry.uploader}</span>
												{:else}
													<span class="truncate opacity-70">{entry.site}</span>
												{/if}
												{#if isSeries}
													<span class="inline-flex items-center gap-0.5 text-primary"
														>Episodes <ChevronRight class="size-3" /></span
													>
												{/if}
											</span>
										</span>
									</button>
								{/each}
								<div class="px-1 py-2 text-center">
									{#if loadingMore}
										<span class="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
											<LoaderCircle class="size-3.5 animate-spin" /> Loading more…
										</span>
									{:else if hasMore}
										<Button
											variant="outline"
											size="sm"
											class="h-7 text-[11px]"
											disabled={busy}
											onclick={() => void loadMore()}
										>
											Load more
										</Button>
									{:else}
										<span class="text-[10px] text-muted-foreground">End of list</span>
									{/if}
								</div>
							{:else}
								<div class="space-y-2 px-3 py-8 text-center text-[11px] text-muted-foreground">
									<p class="font-medium text-foreground/80">No titles on this shelf</p>
									<p>
										Try another shelf, or use Custom search. Dailymotion can be empty by region.
									</p>
								</div>
							{/if}
						</div>
					</div>

					<div class="flex min-h-0 min-w-0 flex-col gap-2">
						<p class="text-[11px] font-medium text-foreground">Preview</p>
						<div
							class="relative aspect-video w-full max-w-full overflow-hidden rounded-md border border-border/70 bg-black/90"
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
							{:else if preview?.thumbnail || selected?.thumbnail}
								<img
									src={preview?.thumbnail || selected?.thumbnail || ''}
									alt=""
									class="size-full object-contain opacity-90"
									referrerpolicy="no-referrer"
								/>
								{#if selectedIsSeries}
									<div
										class="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-3 py-2 text-[10px] text-white/90"
									>
										Series selected — open episodes to pick a video to download.
									</div>
								{:else if preview?.kind === 'none'}
									<div
										class="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-3 py-2 text-[10px] text-white/90"
									>
										Live preview unavailable — thumbnail only. You can still use the video.
									</div>
								{/if}
							{:else}
								<div class="absolute inset-0 grid place-items-center px-4 text-center text-[11px] text-muted-foreground">
									Pick a title from a shelf to preview
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
									<span class="self-center text-[10px] text-muted-foreground"
										>Ad-light stream (yt-dlp)</span
									>
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
								<Button
									size="sm"
									disabled={!selected || busy}
									onclick={() => void openSeriesOrConfirm()}
								>
									{#if selectedIsSeries}
										Open episodes
									{:else}
										Use this video
									{/if}
								</Button>
							</div>
						{/if}
					</div>
				</div>
			</div>
		{:else}
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
						<Input id="link-start" placeholder="0:00" bind:value={startClock} disabled={busy} />
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
						<Input id="ocr-interval" class="max-w-24" bind:value={ocrInterval} disabled={busy} />
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
		</div>

		{#if busy || status}
			<div class="shrink-0 space-y-1.5">
				<div class="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
					<span class="truncate">{status || 'Working…'}</span>
					<span class="font-mono">{percent}%</span>
				</div>
				<Progress value={percent} class="h-1.5" />
			</div>
		{/if}

		{#if error}
			<p
				class="max-h-28 shrink-0 overflow-y-auto rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-[11px] text-destructive whitespace-pre-wrap"
			>
				{error}
			</p>
		{/if}

		<Dialog.Footer class="shrink-0 gap-2 sm:justify-between">
			<div class="flex gap-2">
				{#if step === 'options' || listStack.length > 0}
					<Button
						variant="ghost"
						size="sm"
						disabled={busy}
						onclick={() => {
							if (step === 'options') {
								step = 'browse';
								if (selected) void loadPreview(selected);
								error = null;
								return;
							}
							if (popListStack()) {
								error = null;
								return;
							}
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
				{#if step === 'browse'}
					<Button
						size="sm"
						disabled={!selected || busy}
						onclick={() => void openSeriesOrConfirm()}
					>
						{#if selectedIsSeries}
							Open episodes
						{:else}
							Use this video
						{/if}
					</Button>
				{:else}
					<Button
						size="sm"
						disabled={busy || !selected || !rightsOk || selectedIsSeries}
						onclick={() => void onImport()}
					>
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

<style>
	.gallery-body {
		min-width: 0;
	}
	.gallery-shelves {
		scrollbar-width: thin;
		max-width: 100%;
	}
	.gallery-shelves::-webkit-scrollbar {
		height: 6px;
	}
	.gallery-shelves::-webkit-scrollbar-thumb {
		background: color-mix(in oklab, var(--muted-foreground) 35%, transparent);
		border-radius: 999px;
	}
</style>
