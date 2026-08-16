/**
 * Title Liver — lower thirds / title cards (separate from dialogue subtitles).
 */

import type {
	TitleLiverCategoryId,
	TitleLiverClip,
	TitleLiverTemplateId
} from '$lib/types/project';

/** Entrance motion used by live overlay + dialog template previews. */
export type TitleLiverAnim =
	| 'bar-reveal'
	| 'wipe-left'
	| 'chip-pop'
	| 'cinema-rise'
	| 'chapter-draw'
	| 'glass-slide'
	| 'stagger-up'
	| 'spotlight'
	| 'broadcast-snap'
	| 'luxe-fade'
	| 'player-roll'
	| 'split-reveal'
	| 'neon-pulse'
	| 'type-rise';

export type TitleLiverCategoryDef = {
	id: TitleLiverCategoryId;
	label: string;
	hint: string;
};

/** Left-rail categories (Filmora / CapCut–style). */
export const TITLE_LIVER_CATEGORIES: TitleLiverCategoryDef[] = [
	{ id: 'all', label: 'All', hint: 'Every template' },
	{ id: 'essentials', label: 'Essentials', hint: 'Simple lower thirds' },
	{ id: 'broadcast', label: 'Broadcast', hint: 'News & TV L3rds' },
	{ id: 'filmora', label: 'Filmora', hint: 'Soft creative titles' },
	{ id: 'capcut', label: 'CapCut', hint: 'Bold social styles' },
	{ id: 'football', label: 'Football', hint: 'Player roll & match' },
	{ id: 'cinema', label: 'Cinema', hint: 'Cards & bumpers' }
];

export type TitleLiverTemplateDef = {
	id: TitleLiverTemplateId;
	name: string;
	kind: 'lower-third' | 'title-card' | 'bumper';
	/** Gallery filter category (not "all"). */
	category: Exclude<TitleLiverCategoryId, 'all'>;
	hint: string;
	anim: TitleLiverAnim;
	/** Dialog preview accent. */
	previewAccent: string;
	defaultX: number;
	defaultY: number;
	/** Appear duration (ms) for scrub-synced playback. */
	animMs: number;
	/** Optional gallery sample lines (sports vs interview). */
	sampleLine1?: string;
	sampleLine2?: string;
	sampleLine3?: string;
};

export const TITLE_LIVER_TEMPLATES: TitleLiverTemplateDef[] = [
	{
		id: 'soft-bar',
		name: 'Soft Bar',
		kind: 'lower-third',
		category: 'essentials',
		hint: 'Accent bar reveals, then type fades in',
		anim: 'bar-reveal',
		previewAccent: '#8b5cf6',
		defaultX: 0.22,
		defaultY: 0.82,
		animMs: 700
	},
	{
		id: 'news-strip',
		name: 'News Strip',
		kind: 'lower-third',
		category: 'broadcast',
		hint: 'Broadcast wipe across the lower third',
		anim: 'wipe-left',
		previewAccent: '#e11d48',
		defaultX: 0.5,
		defaultY: 0.88,
		animMs: 650
	},
	{
		id: 'speaker-chip',
		name: 'Speaker Chip',
		kind: 'lower-third',
		category: 'essentials',
		hint: 'Soft spring pop — great for names',
		anim: 'chip-pop',
		previewAccent: '#06b6d4',
		defaultX: 0.2,
		defaultY: 0.8,
		animMs: 600
	},
	{
		id: 'glass-ribbon',
		name: 'Glass Ribbon',
		kind: 'lower-third',
		category: 'filmora',
		hint: 'Frosted glass slides in from the side',
		anim: 'glass-slide',
		previewAccent: '#a78bfa',
		defaultX: 0.28,
		defaultY: 0.84,
		animMs: 720
	},
	{
		id: 'dual-stack',
		name: 'Dual Stack',
		kind: 'lower-third',
		category: 'filmora',
		hint: 'Name then role — staggered rise',
		anim: 'stagger-up',
		previewAccent: '#f59e0b',
		defaultX: 0.24,
		defaultY: 0.8,
		animMs: 780
	},
	{
		id: 'ticker-edge',
		name: 'Ticker Edge',
		kind: 'lower-third',
		category: 'capcut',
		hint: 'Sharp newsroom snap with scrolling crawl',
		anim: 'broadcast-snap',
		previewAccent: '#ef4444',
		defaultX: 0.5,
		defaultY: 0.9,
		animMs: 520
	},
	{
		id: 'cinema-card',
		name: 'Cinema Card',
		kind: 'title-card',
		category: 'cinema',
		hint: 'Centered plate — slow cinematic rise',
		anim: 'cinema-rise',
		previewAccent: '#c4b5fd',
		defaultX: 0.5,
		defaultY: 0.45,
		animMs: 900
	},
	{
		id: 'spotlight',
		name: 'Spotlight',
		kind: 'title-card',
		category: 'cinema',
		hint: 'Soft radial title with orbiting light particles',
		anim: 'spotlight',
		previewAccent: '#fbbf24',
		defaultX: 0.5,
		defaultY: 0.48,
		animMs: 850
	},
	{
		id: 'luxe-serif',
		name: 'Luxe Line',
		kind: 'title-card',
		category: 'cinema',
		hint: 'Title fades in, then underline draws',
		anim: 'luxe-fade',
		previewAccent: '#e8d5a3',
		defaultX: 0.5,
		defaultY: 0.46,
		animMs: 950
	},
	{
		id: 'chapter-bump',
		name: 'Chapter Bumper',
		kind: 'bumper',
		category: 'cinema',
		hint: 'Accent rule draws, then chapter rises',
		anim: 'chapter-draw',
		previewAccent: '#34d399',
		defaultX: 0.5,
		defaultY: 0.42,
		animMs: 800
	},
	/* —— Titler Pro–style On-Air lower thirds —— */
	{
		id: 'cobalt-l3rd',
		name: 'Cobalt L3rd',
		kind: 'lower-third',
		category: 'broadcast',
		hint: 'Slanted gloss bar + scrolling secondary crawl',
		anim: 'wipe-left',
		previewAccent: '#1e6bb8',
		defaultX: 0.28,
		defaultY: 0.82,
		animMs: 720
	},
	{
		id: 'between-red',
		name: 'Between Red',
		kind: 'lower-third',
		category: 'broadcast',
		hint: 'Red slant name with crawling subtitle strip',
		anim: 'wipe-left',
		previewAccent: '#c62828',
		defaultX: 0.26,
		defaultY: 0.83,
		animMs: 680
	},
	{
		id: 'borealis-l3rd',
		name: 'Borealis L3rd',
		kind: 'lower-third',
		category: 'filmora',
		hint: 'Arrow tip + cool teal name plate',
		anim: 'bar-reveal',
		previewAccent: '#0d9488',
		defaultX: 0.24,
		defaultY: 0.81,
		animMs: 700
	},
	{
		id: 'sunset-l3rd',
		name: 'Sunset L3rd',
		kind: 'lower-third',
		category: 'capcut',
		hint: 'Warm plate with sunlight rays + sparkles',
		anim: 'glass-slide',
		previewAccent: '#ea580c',
		defaultX: 0.26,
		defaultY: 0.84,
		animMs: 740
	},
	{
		id: 'sapphire-l3rd',
		name: 'Sapphire L3rd',
		kind: 'lower-third',
		category: 'broadcast',
		hint: 'Deep blue gloss with light sweep + sparkles',
		anim: 'wipe-left',
		previewAccent: '#1d4ed8',
		defaultX: 0.25,
		defaultY: 0.82,
		animMs: 700
	},
	{
		id: 'stratosphere-l3rd',
		name: 'Stratosphere L3rd',
		kind: 'lower-third',
		category: 'filmora',
		hint: 'Frosted glass over accent secondary',
		anim: 'stagger-up',
		previewAccent: '#6366f1',
		defaultX: 0.24,
		defaultY: 0.8,
		animMs: 780
	},
	{
		id: 'zenith-l3rd',
		name: 'Zenith L3rd',
		kind: 'lower-third',
		category: 'capcut',
		hint: 'Clean light plate with accent rail',
		anim: 'bar-reveal',
		previewAccent: '#2563eb',
		defaultX: 0.24,
		defaultY: 0.82,
		animMs: 680
	},
	{
		id: 'aeronautic-l3rd',
		name: 'Aeronautic L3rd',
		kind: 'lower-third',
		category: 'filmora',
		hint: 'Chevron tip leads into name plate',
		anim: 'bar-reveal',
		previewAccent: '#0284c7',
		defaultX: 0.26,
		defaultY: 0.81,
		animMs: 720
	},
	{
		id: 'news-feed-l3rd',
		name: 'News Feed L3rd',
		kind: 'lower-third',
		category: 'broadcast',
		hint: 'LIVE badge + scrolling news crawl',
		anim: 'broadcast-snap',
		previewAccent: '#dc2626',
		defaultX: 0.42,
		defaultY: 0.88,
		animMs: 560
	},
	{
		id: 'enterprise-l3rd',
		name: 'Enterprise L3rd',
		kind: 'lower-third',
		category: 'essentials',
		hint: 'Corporate name plate + role strip',
		anim: 'stagger-up',
		previewAccent: '#1e3a5f',
		defaultX: 0.24,
		defaultY: 0.8,
		animMs: 760
	},
	/* —— Football / player roll —— */
	{
		id: 'fb-player-roll',
		name: 'Player Roll',
		kind: 'lower-third',
		category: 'football',
		hint: 'Big shirt number rolls in with name',
		anim: 'player-roll',
		previewAccent: '#16a34a',
		defaultX: 0.18,
		defaultY: 0.78,
		animMs: 820,
		sampleLine1: 'CHAN SOKHA',
		sampleLine2: '10 · Midfielder'
	},
	{
		id: 'fb-score-bug',
		name: 'Score Bug',
		kind: 'lower-third',
		category: 'football',
		hint: 'Compact match score plate',
		anim: 'broadcast-snap',
		previewAccent: '#0f172a',
		defaultX: 0.12,
		defaultY: 0.12,
		animMs: 520,
		sampleLine1: 'CAM 2–1 THA',
		sampleLine2: '67′ · AFF Cup'
	},
	{
		id: 'fb-lineup',
		name: 'Lineup Card',
		kind: 'title-card',
		category: 'football',
		hint: 'Starting XI style name plate',
		anim: 'stagger-up',
		previewAccent: '#15803d',
		defaultX: 0.22,
		defaultY: 0.55,
		animMs: 860,
		sampleLine1: 'STARTING XI',
		sampleLine2: 'Cambodia · Home'
	},
	{
		id: 'fb-goal-banner',
		name: 'Goal Banner',
		kind: 'bumper',
		category: 'football',
		hint: 'Bold GOAL flash with scorer',
		anim: 'chip-pop',
		previewAccent: '#facc15',
		defaultX: 0.5,
		defaultY: 0.28,
		animMs: 700,
		sampleLine1: 'GOAL!',
		sampleLine2: 'Chan Sokha · 67′'
	},
	{
		id: 'fb-sub-board',
		name: 'Sub Board',
		kind: 'lower-third',
		category: 'football',
		hint: 'Substitution in / out board',
		anim: 'wipe-left',
		previewAccent: '#dc2626',
		defaultX: 0.2,
		defaultY: 0.8,
		animMs: 680,
		sampleLine1: 'IN  ·  Vannak',
		sampleLine2: 'OUT · Rithy'
	},

	/* —— Essentials —— */
	{
		id: 'pill-badge',
		name: 'Pill Badge',
		kind: 'lower-third',
		category: 'essentials',
		hint: 'Rounded pill name tag',
		anim: 'chip-pop',
		previewAccent: '#7c3aed',
		defaultX: 0.2,
		defaultY: 0.82,
		animMs: 580
	},
	{
		id: 'minimal-rule',
		name: 'Minimal Rule',
		kind: 'lower-third',
		category: 'essentials',
		hint: 'Clean name with thin accent rule',
		anim: 'luxe-fade',
		previewAccent: '#94a3b8',
		defaultX: 0.22,
		defaultY: 0.84,
		animMs: 720
	},
	{
		id: 'podcast-tag',
		name: 'Podcast Tag',
		kind: 'lower-third',
		category: 'essentials',
		hint: 'Rounded host tag with accent dot',
		anim: 'chip-pop',
		previewAccent: '#f97316',
		defaultX: 0.18,
		defaultY: 0.8,
		animMs: 600,
		sampleLine1: 'Host',
		sampleLine2: 'Episode 42'
	},
	{
		id: 'location-pin',
		name: 'Location Pin',
		kind: 'lower-third',
		category: 'essentials',
		hint: 'Place marker lower third',
		anim: 'stagger-up',
		previewAccent: '#ef4444',
		defaultX: 0.2,
		defaultY: 0.82,
		animMs: 700,
		sampleLine1: 'Phnom Penh',
		sampleLine2: 'Cambodia'
	},
	{
		id: 'corner-bug',
		name: 'Corner Bug',
		kind: 'lower-third',
		category: 'essentials',
		hint: 'Compact channel / show bug',
		anim: 'broadcast-snap',
		previewAccent: '#0ea5e9',
		defaultX: 0.88,
		defaultY: 0.1,
		animMs: 480,
		sampleLine1: 'PDP',
		sampleLine2: 'LIVE'
	},

	/* —— Filmora-style creative —— */
	{
		id: 'split-duo',
		name: 'Split Duo',
		kind: 'lower-third',
		category: 'filmora',
		hint: 'Two-tone split plate reveal',
		anim: 'split-reveal',
		previewAccent: '#ec4899',
		defaultX: 0.24,
		defaultY: 0.82,
		animMs: 780
	},
	{
		id: 'ribbon-fold',
		name: 'Ribbon Fold',
		kind: 'lower-third',
		category: 'filmora',
		hint: 'Folded ribbon name banner',
		anim: 'glass-slide',
		previewAccent: '#d946ef',
		defaultX: 0.26,
		defaultY: 0.84,
		animMs: 740
	},
	{
		id: 'gradient-wash',
		name: 'Gradient Wash',
		kind: 'lower-third',
		category: 'filmora',
		hint: 'Soft gradient wash under type',
		anim: 'type-rise',
		previewAccent: '#8b5cf6',
		defaultX: 0.28,
		defaultY: 0.82,
		animMs: 800
	},
	{
		id: 'moire-band',
		name: 'Moire Band',
		kind: 'lower-third',
		category: 'filmora',
		hint: 'Wide band with subtle stripe texture',
		anim: 'wipe-left',
		previewAccent: '#6366f1',
		defaultX: 0.5,
		defaultY: 0.86,
		animMs: 700
	},

	/* —— CapCut / social —— */
	{
		id: 'outline-stroke',
		name: 'Outline Stroke',
		kind: 'lower-third',
		category: 'capcut',
		hint: 'Bold outline-only kinetic type',
		anim: 'type-rise',
		previewAccent: '#22d3ee',
		defaultX: 0.5,
		defaultY: 0.78,
		animMs: 680,
		sampleLine1: 'WATCH THIS',
		sampleLine2: 'New drop'
	},
	{
		id: 'neon-frame',
		name: 'Neon Frame',
		kind: 'lower-third',
		category: 'capcut',
		hint: 'Neon border glow around name',
		anim: 'neon-pulse',
		previewAccent: '#a855f7',
		defaultX: 0.22,
		defaultY: 0.8,
		animMs: 760
	},
	{
		id: 'social-handle',
		name: 'Social Handle',
		kind: 'lower-third',
		category: 'capcut',
		hint: '@handle style follow tag',
		anim: 'chip-pop',
		previewAccent: '#e11d48',
		defaultX: 0.18,
		defaultY: 0.86,
		animMs: 560,
		sampleLine1: '@professordubbed',
		sampleLine2: 'Follow for more'
	},
	{
		id: 'kinetic-stack',
		name: 'Kinetic Stack',
		kind: 'title-card',
		category: 'capcut',
		hint: 'Huge stacked kinetic title',
		anim: 'type-rise',
		previewAccent: '#f43f5e',
		defaultX: 0.5,
		defaultY: 0.42,
		animMs: 820,
		sampleLine1: 'NOW PLAYING',
		sampleLine2: 'Episode One'
	},
	{
		id: 'glitch-pop',
		name: 'Glitch Pop',
		kind: 'lower-third',
		category: 'capcut',
		hint: 'RGB split glitch name plate',
		anim: 'broadcast-snap',
		previewAccent: '#22c55e',
		defaultX: 0.24,
		defaultY: 0.8,
		animMs: 540
	},

	/* —— Broadcast / live —— */
	{
		id: 'breaking-slash',
		name: 'Breaking Slash',
		kind: 'lower-third',
		category: 'broadcast',
		hint: 'Diagonal breaking-news slash',
		anim: 'wipe-left',
		previewAccent: '#dc2626',
		defaultX: 0.28,
		defaultY: 0.84,
		animMs: 620,
		sampleLine1: 'BREAKING',
		sampleLine2: 'Developing story'
	},
	{
		id: 'anchor-desk',
		name: 'Anchor Desk',
		kind: 'lower-third',
		category: 'broadcast',
		hint: 'Classic dual-row news desk plate',
		anim: 'bar-reveal',
		previewAccent: '#1d4ed8',
		defaultX: 0.24,
		defaultY: 0.82,
		animMs: 720
	},
	{
		id: 'countdown-bug',
		name: 'Countdown Bug',
		kind: 'lower-third',
		category: 'broadcast',
		hint: 'Top-left time / location bug',
		anim: 'broadcast-snap',
		previewAccent: '#0f172a',
		defaultX: 0.12,
		defaultY: 0.1,
		animMs: 500,
		sampleLine1: '19:42',
		sampleLine2: 'PHNOM PENH'
	},
	{
		id: 'live-alert',
		name: 'Live Alert',
		kind: 'lower-third',
		category: 'broadcast',
		hint: 'Urgent alert banner with pulse',
		anim: 'neon-pulse',
		previewAccent: '#ef4444',
		defaultX: 0.5,
		defaultY: 0.14,
		animMs: 640,
		sampleLine1: 'ALERT',
		sampleLine2: 'Special coverage'
	},

	/* —— Cinema —— */
	{
		id: 'bracket-title',
		name: 'Bracket Title',
		kind: 'title-card',
		category: 'cinema',
		hint: 'Cinematic brackets frame the title',
		anim: 'chapter-draw',
		previewAccent: '#e2e8f0',
		defaultX: 0.5,
		defaultY: 0.48,
		animMs: 900,
		sampleLine1: 'PROLOGUE',
		sampleLine2: 'The beginning'
	},
	{
		id: 'quote-card',
		name: 'Quote Card',
		kind: 'title-card',
		category: 'cinema',
		hint: 'Pull-quote with oversized mark',
		anim: 'cinema-rise',
		previewAccent: '#fbbf24',
		defaultX: 0.5,
		defaultY: 0.45,
		animMs: 880,
		sampleLine1: 'Words matter.',
		sampleLine2: '— Guest'
	},
	{
		id: 'whisper-serif',
		name: 'Whisper Serif',
		kind: 'lower-third',
		category: 'cinema',
		hint: 'Soft serif name with hairline rule',
		anim: 'luxe-fade',
		previewAccent: '#d4c4a8',
		defaultX: 0.22,
		defaultY: 0.82,
		animMs: 920
	},
	{
		id: 'end-slate',
		name: 'End Slate',
		kind: 'bumper',
		category: 'cinema',
		hint: 'End-card slate with centered type',
		anim: 'spotlight',
		previewAccent: '#64748b',
		defaultX: 0.5,
		defaultY: 0.5,
		animMs: 1000,
		sampleLine1: 'THE END',
		sampleLine2: 'Thank you for watching'
	},

	/* —— Football extras —— */
	{
		id: 'fb-corner-clock',
		name: 'Match Clock',
		kind: 'lower-third',
		category: 'football',
		hint: 'Corner match minute clock',
		anim: 'broadcast-snap',
		previewAccent: '#14532d',
		defaultX: 0.1,
		defaultY: 0.1,
		animMs: 480,
		sampleLine1: "67'",
		sampleLine2: '2nd HALF'
	},
	{
		id: 'fb-possession',
		name: 'Possession',
		kind: 'lower-third',
		category: 'football',
		hint: 'Split possession-style name plate',
		anim: 'split-reveal',
		previewAccent: '#22c55e',
		defaultX: 0.5,
		defaultY: 0.88,
		animMs: 700,
		sampleLine1: 'CAM 58%',
		sampleLine2: 'THA 42%'
	},
	{
		id: 'fb-org-chart',
		name: 'Org Chart',
		kind: 'title-card',
		category: 'football',
		hint: 'Formation org chart — parses 4-3-3 from Line 2',
		anim: 'stagger-up',
		previewAccent: '#15803d',
		defaultX: 0.5,
		defaultY: 0.42,
		animMs: 900,
		sampleLine1: 'CAMBODIA',
		sampleLine2: '4-3-3 · Starting XI',
		sampleLine3: 'Sokha,Vannak,Rithy,Dara,Kim,Lee,Pon,Sothy,Boran,Chhaya,Vichea'
	}
];

/** Search templates by name / hint / id (category filter applied by caller). */
export function filterTitleLiverTemplates(
	templates: TitleLiverTemplateDef[],
	query: string
): TitleLiverTemplateDef[] {
	const q = query.trim().toLowerCase();
	if (!q) return templates;
	return templates.filter(
		(t) =>
			t.name.toLowerCase().includes(q) ||
			t.hint.toLowerCase().includes(q) ||
			t.id.toLowerCase().includes(q) ||
			t.category.toLowerCase().includes(q)
	);
}

/** One-click packs that drop several clips near the playhead. */
export type TitleLiverPresetId = 'news-pack' | 'football-pack' | 'cinema-pack';

export type TitleLiverPresetDef = {
	id: TitleLiverPresetId;
	label: string;
	hint: string;
	clips: Array<{
		templateId: TitleLiverTemplateId;
		offsetMs: number;
		durationMs: number;
		line1?: string;
		line2?: string;
		line3?: string;
	}>;
};

export const TITLE_LIVER_PRESETS: TitleLiverPresetDef[] = [
	{
		id: 'news-pack',
		label: 'News pack',
		hint: 'Breaking + desk + live bug',
		clips: [
			{
				templateId: 'breaking-slash',
				offsetMs: 0,
				durationMs: 3500,
				line1: 'BREAKING',
				line2: 'Developing story'
			},
			{
				templateId: 'anchor-desk',
				offsetMs: 3200,
				durationMs: 5000,
				line1: 'Sophea Chan',
				line2: 'News anchor'
			},
			{
				templateId: 'corner-bug',
				offsetMs: 0,
				durationMs: 12000,
				line1: 'PDP',
				line2: 'LIVE'
			}
		]
	},
	{
		id: 'football-pack',
		label: 'Football pack',
		hint: 'Score + player + org chart',
		clips: [
			{
				templateId: 'fb-score-bug',
				offsetMs: 0,
				durationMs: 8000,
				line1: 'CAM 2–1 THA',
				line2: "67′ · AFF Cup"
			},
			{
				templateId: 'fb-player-roll',
				offsetMs: 1500,
				durationMs: 4500,
				line1: 'CHAN SOKHA',
				line2: '10 · Midfielder'
			},
			{
				templateId: 'fb-org-chart',
				offsetMs: 5500,
				durationMs: 6000,
				line1: 'CAMBODIA',
				line2: '4-3-3 · Starting XI',
				line3: 'Sokha,Vannak,Rithy,Dara,Kim,Lee,Pon,Sothy,Boran,Chhaya,Vichea'
			}
		]
	},
	{
		id: 'cinema-pack',
		label: 'Cinema pack',
		hint: 'Chapter + title + end slate',
		clips: [
			{
				templateId: 'chapter-bump',
				offsetMs: 0,
				durationMs: 4000,
				line1: 'Chapter One',
				line2: 'Prologue'
			},
			{
				templateId: 'luxe-serif',
				offsetMs: 3800,
				durationMs: 4500,
				line1: 'Professor Dubbed',
				line2: 'A studio film'
			},
			{
				templateId: 'end-slate',
				offsetMs: 9000,
				durationMs: 5000,
				line1: 'THE END',
				line2: 'Thank you for watching'
			}
		]
	}
];

export function titleLiverTemplatesByCategory(
	category: TitleLiverCategoryId
): TitleLiverTemplateDef[] {
	if (category === 'all') return TITLE_LIVER_TEMPLATES;
	return TITLE_LIVER_TEMPLATES.filter((t) => t.category === category);
}

/** Fallback appear length when template unknown. */
export const TITLE_LIVER_ANIM_MS = 700;

export function titleLiverTemplate(id: string): TitleLiverTemplateDef {
	return TITLE_LIVER_TEMPLATES.find((t) => t.id === id) ?? TITLE_LIVER_TEMPLATES[0]!;
}

export function createTitleLiverClip(partial?: Partial<TitleLiverClip>): TitleLiverClip {
	const startMs = Math.max(0, Math.round(partial?.startMs ?? 0));
	const endMs = Math.max(startMs + 800, Math.round(partial?.endMs ?? startMs + 4000));
	const templateId = (partial?.templateId ?? 'soft-bar') as TitleLiverTemplateId;
	const safeId = TITLE_LIVER_TEMPLATES.some((t) => t.id === templateId) ? templateId : 'soft-bar';
	const tmpl = titleLiverTemplate(safeId);
	return {
		id: partial?.id ?? `tl-${crypto.randomUUID().slice(0, 8)}`,
		templateId: safeId,
		startMs,
		endMs,
		line1: partial?.line1 ?? tmpl.sampleLine1 ?? 'Speaker name',
		line2: partial?.line2 ?? tmpl.sampleLine2 ?? 'Role or title',
		line3: partial?.line3 ?? tmpl.sampleLine3 ?? '',
		accent: partial?.accent ?? tmpl.previewAccent,
		x:
			typeof partial?.x === 'number' && Number.isFinite(partial.x)
				? Math.max(0.02, Math.min(0.98, partial.x))
				: tmpl.defaultX,
		y:
			typeof partial?.y === 'number' && Number.isFinite(partial.y)
				? Math.max(0.02, Math.min(0.98, partial.y))
				: tmpl.defaultY,
		fontFamily: partial?.fontFamily?.trim() || 'Noto Sans Khmer',
		fontFile: partial?.fontFile ?? null,
		fontSizePx:
			typeof partial?.fontSizePx === 'number' && Number.isFinite(partial.fontSizePx)
				? Math.max(10, Math.min(96, Math.round(partial.fontSizePx)))
				: 22,
		outlineWidth:
			typeof partial?.outlineWidth === 'number' && Number.isFinite(partial.outlineWidth)
				? Math.max(0, Math.min(5, Number(partial.outlineWidth)))
				: 1.25,
		scale:
			typeof partial?.scale === 'number' && Number.isFinite(partial.scale)
				? Math.max(0.5, Math.min(2, Number(partial.scale)))
				: 1,
		maxWidthPct:
			typeof partial?.maxWidthPct === 'number' && Number.isFinite(partial.maxWidthPct)
				? Math.max(0.25, Math.min(0.98, Number(partial.maxWidthPct)))
				: 0.92
	};
}

/** Active Title Liver clip at playhead (latest start wins if overlap). */
export function titleLiverAtPlayhead(
	clips: TitleLiverClip[],
	playheadMs: number
): TitleLiverClip | null {
	const hits = clips.filter((c) => playheadMs >= c.startMs && playheadMs < c.endMs);
	if (!hits.length) return null;
	return [...hits].sort((a, b) => b.startMs - a.startMs)[0] ?? null;
}

function clamp01(n: number): number {
	return Math.max(0, Math.min(1, n));
}

function easeOutExpo(u: number): number {
	return u >= 1 ? 1 : 1 - Math.pow(2, -10 * u);
}

function easeOutBack(u: number): number {
	const c1 = 1.70158;
	const c3 = c1 + 1;
	const t = u - 1;
	return 1 + c3 * t * t * t + c1 * t * t;
}

function easeOutCubic(u: number): number {
	return 1 - Math.pow(1 - u, 3);
}

/** Map linear time `u` through window [a,b], then ease. */
function stage(u: number, a: number, b: number, ease: (t: number) => number = easeOutCubic): number {
	if (b <= a) return u >= b ? 1 : 0;
	return ease(clamp01((u - a) / (b - a)));
}

/** Scrub-synced channel set — shared by dialog preview + live overlay. */
export type TitleLiverMotion = {
	/** Whole graphic opacity. */
	opacity: number;
	tx: number;
	ty: number;
	sc: number;
	blur: number;
	clip: string;
	/** Accent bar / underline / edge scale (0–1). Staged separately from opacity. */
	bar: number;
	/** Primary line / copy fade-rise (0–1). */
	s1: number;
	/** Secondary line stagger (0–1). */
	s2: number;
	/** Spotlight glow scale. */
	glow: number;
	/** Extra letter-spacing in em (luxe). */
	letterEm: number;
	/** Edge flash brightness boost (ticker). */
	flash: number;
};

const REST: TitleLiverMotion = {
	opacity: 1,
	tx: 0,
	ty: 0,
	sc: 1,
	blur: 0,
	clip: 'none',
	bar: 1,
	s1: 1,
	s2: 1,
	glow: 1,
	letterEm: 0.04,
	flash: 0
};

/**
 * Sample entrance motion at linear time u ∈ [0,1] (0 = clip start, 1 = anim done).
 * Channel windows are staged so line-draw / stagger do not finish with the first fade.
 */
export function sampleTitleLiverMotion(anim: TitleLiverAnim, uRaw: number): TitleLiverMotion {
	const u = clamp01(uRaw);
	if (u >= 1) return { ...REST };

	switch (anim) {
		case 'bar-reveal': {
			/* Bar grows first, then copy fades up (matches Soft Bar hint). */
			const shell = stage(u, 0, 0.35);
			const bar = stage(u, 0, 0.42);
			const s1 = stage(u, 0.32, 0.92);
			return {
				...REST,
				opacity: shell,
				tx: (1 - shell) * -14,
				ty: (1 - shell) * 6,
				blur: (1 - shell) * 3,
				clip: 'none',
				bar,
				s1,
				s2: s1
			};
		}
		case 'wipe-left': {
			const a = stage(u, 0, 0.85, easeOutCubic);
			const inv = 1 - a;
			return {
				...REST,
				opacity: a,
				tx: inv * -10,
				clip: `inset(0 ${inv * 100}% 0 0)`,
				s1: a,
				s2: a
			};
		}
		case 'chip-pop': {
			const a = stage(u, 0, 0.9, easeOutBack);
			return {
				...REST,
				opacity: a,
				sc: 0.72 + a * 0.28,
				blur: (1 - a) * 4,
				s1: a,
				s2: a
			};
		}
		case 'glass-slide': {
			const a = stage(u, 0, 0.88);
			return {
				...REST,
				opacity: a,
				tx: (1 - a) * -34,
				blur: (1 - a) * 7,
				s1: a,
				s2: a
			};
		}
		case 'stagger-up': {
			const s1 = stage(u, 0, 0.55);
			const s2 = stage(u, 0.28, 0.92);
			return {
				...REST,
				opacity: 1,
				s1,
				s2
			};
		}
		case 'broadcast-snap': {
			const a = stage(u, 0, 0.75, easeOutBack);
			const flash = u < 0.2 ? 0 : u < 0.32 ? stage(u, 0.2, 0.28) * 1.2 : Math.max(0, 1 - stage(u, 0.28, 0.45));
			return {
				...REST,
				opacity: a,
				ty: (1 - a) * 28,
				bar: a,
				flash,
				s1: a,
				s2: a
			};
		}
		case 'cinema-rise': {
			const a = stage(u, 0, 0.9, easeOutExpo);
			return {
				...REST,
				opacity: a,
				ty: (1 - a) * 16,
				sc: 0.94 + a * 0.06,
				blur: (1 - a) * 5,
				s1: a,
				s2: a
			};
		}
		case 'spotlight': {
			const a = stage(u, 0, 0.72, easeOutExpo);
			const glow = stage(u, 0.08, 0.85, easeOutCubic);
			return {
				...REST,
				opacity: a,
				ty: (1 - a) * 10,
				sc: 0.9 + a * 0.1,
				blur: (1 - a) * 3,
				glow,
				bar: glow,
				s1: a,
				s2: a
			};
		}
		case 'luxe-fade': {
			/* Text settles first, then underline draws — not in lockstep. */
			const text = stage(u, 0, 0.52, easeOutExpo);
			const bar = stage(u, 0.42, 1, easeOutCubic);
			const s2 = stage(u, 0.55, 1, easeOutCubic);
			return {
				...REST,
				opacity: text,
				ty: (1 - text) * 6,
				blur: (1 - text) * 2,
				bar,
				s1: text,
				s2,
				letterEm: 0.04 + (1 - text) * 0.14
			};
		}
		case 'player-roll': {
			/* Number block rolls first, then name/role. */
			const bar = stage(u, 0, 0.4, easeOutBack);
			const s1 = stage(u, 0.28, 0.78);
			const s2 = stage(u, 0.45, 0.95);
			const shell = Math.max(bar, s1);
			return {
				...REST,
				opacity: shell,
				tx: (1 - shell) * -22,
				ty: (1 - bar) * 8,
				bar,
				s1,
				s2
			};
		}
		case 'split-reveal': {
			const a = stage(u, 0, 0.75, easeOutCubic);
			const s1 = stage(u, 0.15, 0.7);
			const s2 = stage(u, 0.35, 0.95);
			return {
				...REST,
				opacity: a,
				clip: `inset(0 ${(1 - a) * 50}% 0 ${(1 - a) * 50}%)`,
				bar: a,
				s1,
				s2
			};
		}
		case 'neon-pulse': {
			const a = stage(u, 0, 0.7, easeOutBack);
			const glow = stage(u, 0.2, 0.95, easeOutCubic);
			const flash = u < 0.15 ? stage(u, 0, 0.12) : Math.max(0, 1 - stage(u, 0.12, 0.35));
			return {
				...REST,
				opacity: a,
				sc: 0.92 + a * 0.08,
				glow,
				flash,
				bar: glow,
				s1: a,
				s2: stage(u, 0.25, 0.9)
			};
		}
		case 'type-rise': {
			const s1 = stage(u, 0, 0.55, easeOutExpo);
			const s2 = stage(u, 0.3, 0.92, easeOutCubic);
			const shell = Math.max(s1, s2 * 0.6);
			return {
				...REST,
				opacity: shell,
				ty: (1 - s1) * 22,
				letterEm: 0.02 + (1 - s1) * 0.18,
				s1,
				s2,
				bar: stage(u, 0.45, 1)
			};
		}
		case 'chapter-draw': {
			/* Rule draws first, then kicker + title rise (matches Chapter Bumper hint). */
			const bar = stage(u, 0, 0.38);
			const s1 = stage(u, 0.28, 0.78);
			const title = stage(u, 0.4, 0.95);
			return {
				...REST,
				opacity: Math.max(bar, s1, title) > 0 ? 1 : 0,
				ty: (1 - title) * 12,
				bar,
				s1,
				s2: title
			};
		}
		default:
			return { ...REST, opacity: stage(u, 0, 1) };
	}
}

/** Linear 0–1 clock from clip start (no easing — easing lives in sampleTitleLiverMotion). */
export function titleLiverLinearProgress(clip: TitleLiverClip, playheadMs: number): number {
	const tmpl = titleLiverTemplate(clip.templateId);
	const dur = tmpl.animMs || TITLE_LIVER_ANIM_MS;
	const t = playheadMs - clip.startMs;
	if (t <= 0) return 0;
	if (t >= dur) return 1;
	return t / dur;
}

/** Exit fade length (ms) near clip end. */
export const TITLE_LIVER_EXIT_MS = 420;

/**
 * Hold/exit multiplier (1 = full, 0 = faded out).
 * Appear uses sampleTitleLiverMotion; this fades the whole graphic before endMs.
 */
export function titleLiverExitFade(clip: TitleLiverClip, playheadMs: number): number {
	const exitMs = Math.min(TITLE_LIVER_EXIT_MS, Math.max(120, (clip.endMs - clip.startMs) * 0.22));
	const remain = clip.endMs - playheadMs;
	if (remain >= exitMs) return 1;
	if (remain <= 0) return 0;
	return clamp01(remain / exitMs);
}

/** @deprecated Prefer sampleTitleLiverMotion + titleLiverLinearProgress. */
export function titleLiverAppearProgress(clip: TitleLiverClip, playheadMs: number): number {
	return sampleTitleLiverMotion(
		titleLiverTemplate(clip.templateId).anim,
		titleLiverLinearProgress(clip, playheadMs)
	).opacity;
}

/**
 * Loop clock for dialog previews: entrance → hold → soft exit → pause.
 * Returns the same linear u that timeline uses during the entrance window.
 */
export function titleLiverPreviewLoopU(elapsedMs: number, animMs: number): number {
	const enter = Math.max(400, animMs);
	const hold = 1100;
	const exit = 420;
	const gap = 380;
	const cycle = enter + hold + exit + gap;
	const t = ((elapsedMs % cycle) + cycle) % cycle;
	if (t < enter) return t / enter;
	if (t < enter + hold) return 1;
	if (t < enter + hold + exit) {
		/* Exit is visual-only in preview CSS via opacity multiply — keep channels at rest. */
		return 1;
	}
	return 0;
}

/** Preview exit fade (1 = fully visible). */
export function titleLiverPreviewExitFade(elapsedMs: number, animMs: number): number {
	const enter = Math.max(400, animMs);
	const hold = 1100;
	const exit = 420;
	const gap = 380;
	const cycle = enter + hold + exit + gap;
	const t = ((elapsedMs % cycle) + cycle) % cycle;
	if (t < enter + hold) return 1;
	if (t < enter + hold + exit) return 1 - (t - enter - hold) / exit;
	return 0;
}
