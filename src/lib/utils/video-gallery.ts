/**
 * Curated Video Gallery shelves — seed URLs / searches that yt-dlp (or WeTV API) can resolve.
 * Verified locally against bundled yt-dlp 2026.07.04 + WeTV channel API.
 */

export type GallerySiteId = 'all' | 'wetv' | 'youtube' | 'dailymotion';

export type GalleryShelf = {
	id: string;
	label: string;
	description: string;
	site: Exclude<GallerySiteId, 'all'>;
	/** Passed to resolve_media_link (channel URL, playlist, or search text). */
	seed: string;
	/**
	 * Extra seeds merged when the user scrolls to the bottom / taps Load more.
	 * Used for WeTV (other channels) and Dailymotion fallbacks.
	 */
	moreSeeds?: string[];
	/** Page size for yt-dlp playlist / search pagination. */
	pageSize?: number;
	/** `search` = YouTube ytsearch text; `playlist` = channel/playlist URL; `catalog` = WeTV API. */
	mode?: 'search' | 'playlist' | 'catalog';
};

/** Site chips shown in the gallery filter bar. */
export const GALLERY_SITE_FILTERS: { id: GallerySiteId; label: string }[] = [
	{ id: 'all', label: 'All' },
	{ id: 'wetv', label: 'WeTV' },
	{ id: 'youtube', label: 'YouTube' },
	{ id: 'dailymotion', label: 'Dailymotion' }
];

const WETV_CH = {
	top: 'https://wetv.vip/en/channel/10262',
	popular: 'https://wetv.vip/en/channel/10002',
	romance: 'https://wetv.vip/en/channel/10003',
	fantasy: 'https://wetv.vip/en/channel/10100',
	more: 'https://wetv.vip/en/channel/10200'
} as const;

function wetvMore(...exclude: string[]): string[] {
	return Object.values(WETV_CH).filter((u) => !exclude.includes(u));
}

/**
 * Famous / trending drama catalogs. Opening the gallery loads a shelf — no paste required.
 */
export const GALLERY_SHELVES: GalleryShelf[] = [
	{
		id: 'wetv-top',
		label: 'Top Hits',
		description: 'Soul Land, Perfect World, and current WeTV hits',
		site: 'wetv',
		seed: WETV_CH.top,
		mode: 'catalog',
		moreSeeds: wetvMore(WETV_CH.top),
		pageSize: 40
	},
	{
		id: 'wetv-popular',
		label: 'Popular',
		description: 'Large WeTV catalog — open a title for episodes',
		site: 'wetv',
		seed: WETV_CH.popular,
		mode: 'catalog',
		moreSeeds: wetvMore(WETV_CH.popular),
		pageSize: 40
	},
	{
		id: 'wetv-romance',
		label: 'Romance',
		description: 'Romance and contemporary dramas',
		site: 'wetv',
		seed: WETV_CH.romance,
		mode: 'catalog',
		moreSeeds: wetvMore(WETV_CH.romance),
		pageSize: 40
	},
	{
		id: 'wetv-fantasy',
		label: 'Fantasy & Action',
		description: 'Cultivation, wuxia, and action series',
		site: 'wetv',
		seed: WETV_CH.fantasy,
		mode: 'catalog',
		moreSeeds: wetvMore(WETV_CH.fantasy),
		pageSize: 40
	},
	{
		id: 'wetv-more',
		label: 'More titles',
		description: 'Extra WeTV shelf for browsing',
		site: 'wetv',
		seed: WETV_CH.more,
		mode: 'catalog',
		moreSeeds: wetvMore(WETV_CH.more),
		pageSize: 40
	},
	{
		id: 'yt-cdrama-eps',
		label: 'C-drama episodes',
		description: 'Full Chinese drama episodes with English subs',
		site: 'youtube',
		seed: 'chinese drama full episode eng sub',
		mode: 'search',
		pageSize: 24
	},
	{
		id: 'yt-short-drama',
		label: 'Short drama',
		description: 'Vertical / short Chinese dramas (full)',
		site: 'youtube',
		seed: 'chinese short drama eng sub full',
		mode: 'search',
		pageSize: 24
	},
	{
		id: 'yt-cdrama-box',
		label: 'Cdrama BOX',
		description: 'Channel uploads (episode-style cuts)',
		site: 'youtube',
		seed: 'https://www.youtube.com/channel/UC1RMpjsUQcBuel6-GIeV9Cw/videos',
		mode: 'playlist',
		pageSize: 24
	},
	{
		id: 'yt-romantic',
		label: 'Romantic C-drama',
		description: 'Romance-focused episode search',
		site: 'youtube',
		seed: 'chinese romantic drama full episode eng sub',
		mode: 'search',
		pageSize: 24
	},
	{
		id: 'dm-drama',
		label: 'Drama search',
		description: 'Dailymotion search (may be empty by region)',
		site: 'dailymotion',
		seed: 'https://www.dailymotion.com/search/chinese%20drama/videos',
		mode: 'playlist',
		pageSize: 24,
		moreSeeds: [
			'https://www.dailymotion.com/search/c-drama/videos',
			'https://www.dailymotion.com/search/chinese%20series/videos'
		]
	}
];

export function galleryShelvesForSite(site: GallerySiteId): GalleryShelf[] {
	if (site === 'all') return GALLERY_SHELVES;
	return GALLERY_SHELVES.filter((s) => s.site === site);
}

export function galleryShelfById(id: string): GalleryShelf | undefined {
	return GALLERY_SHELVES.find((s) => s.id === id);
}

/** Build an explicit yt-dlp search query for pagination (`ytsearchN:…`). */
export function gallerySearchQuery(seed: string, count: number): string {
	const n = Math.max(1, Math.min(100, Math.round(count)));
	const trimmed = seed.trim();
	if (/^ytsearch\d*:/i.test(trimmed)) {
		return trimmed.replace(/^ytsearch\d*:/i, `ytsearch${n}:`);
	}
	return `ytsearch${n}:${trimmed}`;
}

export const DEFAULT_GALLERY_SHELF_ID = 'wetv-top';
