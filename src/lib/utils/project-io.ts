import type {
	DubbingProject,
	DubbingTrack,
	MediaAsset,
	MediaKind,
	SpeakerVoiceProfile,
	SubtitleCue,
	SubtitleStyle,
	TitleLiverClip,
	TitleLiverTemplateId
} from '$lib/types/project';
import { DEFAULT_SUBTITLE_STYLE } from '$lib/types/project';
import { createTitleLiverClip } from '$lib/utils/title-liver';
import { DEFAULT_EDGE_VOICE_ID } from '$lib/tts/edge-voices';
import { voiceIdForEngineGender } from '$lib/tts/voice-engine';
import type { TtsEngineId } from '$lib/tts/types';

export const PROJECT_STORAGE_KEY = 'pdp.currentProject';

const DEFAULT_TRACKS: DubbingTrack[] = [
	{
		id: 'trk-picture',
		name: 'Picture',
		role: 'picture',
		language: '—',
		muted: false,
		solo: false,
		locked: true,
		volumeDb: 0
	},
	{
		id: 'trk-dialogue',
		name: 'Original Dialogue',
		role: 'dialogue',
		language: 'en',
		muted: false,
		solo: false,
		locked: false,
		volumeDb: -2
	},
	{
		id: 'trk-dub',
		name: 'Dub · Khmer',
		role: 'dub',
		language: 'km',
		muted: false,
		solo: false,
		locked: false,
		volumeDb: 0
	},
	{
		id: 'trk-music',
		name: 'Original Audio',
		role: 'music',
		language: '—',
		muted: false,
		solo: false,
		locked: false,
		volumeDb: -2
	}
];

function uid(prefix: string): string {
	return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

/** Create a blank dubbing project (no video, no cues). */
export function createEmptyProject(
	name = 'Untitled Dub Session',
	opts?: { sourceLanguage?: string; targetLanguage?: string }
): DubbingProject {
	const sourceLanguage = opts?.sourceLanguage ?? 'en';
	const targetLanguage = opts?.targetLanguage ?? 'km';
	const dubLabel =
		targetLanguage === 'km' ? 'Khmer' : targetLanguage === 'en' ? 'English' : targetLanguage.toUpperCase();

	const tracks = DEFAULT_TRACKS.map((t) => {
		if (t.role === 'dialogue') return { ...t, language: sourceLanguage };
		if (t.role === 'dub') {
			return { ...t, language: targetLanguage, name: `Dub · ${dubLabel}` };
		}
		return { ...t };
	});

	return {
		id: uid('proj'),
		name,
		sourceLanguage,
		targetLanguage,
		fps: 24,
		durationMs: 60_000,
		mediaTempoFromSource: 1,
		videoAssetId: null,
		assets: [],
		tracks,
		cues: [],
		subtitleStyle: { ...DEFAULT_SUBTITLE_STYLE },
		speakerBank: [],
		titleLiverClips: [],
		updatedAt: new Date().toISOString()
	};
}

export type NewCueInput = Partial<
	Omit<SubtitleCue, 'id' | 'index'> & { id?: string; index?: number }
>;

/** Create a subtitle segment with sensible defaults. */
export function createSubtitleCue(
	index: number,
	input: NewCueInput = {},
	defaults?: { voiceId?: string; speaker?: string }
): SubtitleCue {
	const startMs = Math.max(0, Math.round(input.startMs ?? 0));
	const endMs = Math.max(startMs + 200, Math.round(input.endMs ?? startMs + 2000));
	const pictureStartMs =
		typeof input.pictureStartMs === 'number' && Number.isFinite(input.pictureStartMs)
			? Math.max(0, Math.round(input.pictureStartMs))
			: startMs;
	const pictureEndMs =
		typeof input.pictureEndMs === 'number' && Number.isFinite(input.pictureEndMs)
			? Math.max(pictureStartMs + 120, Math.round(input.pictureEndMs))
			: endMs;

	return {
		id: input.id ?? uid('cue'),
		index,
		startMs,
		endMs,
		pictureStartMs,
		pictureEndMs,
		source: input.source ?? '',
		translation: input.translation ?? '',
		speaker: input.speaker ?? defaults?.speaker ?? 'Speaker 1',
		pitch: input.pitch ?? 0,
		speed: input.speed ?? 1,
		volume: input.volume ?? 80,
		voiceId: input.voiceId ?? defaults?.voiceId ?? 'km-KH-SreymomNeural',
		status: input.status ?? 'draft',
		assignedAudio: input.assignedAudio ?? null
	};
}

export function createMediaAsset(
	file: Pick<File, 'name'>,
	kind: MediaAsset['kind'],
	durationMs = 0
): MediaAsset {
	return {
		id: uid('asset'),
		name: file.name,
		kind,
		path: file.name,
		durationMs,
		createdAt: new Date().toISOString()
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value != null && !Array.isArray(value);
}

function normalizeCue(raw: unknown, index: number): SubtitleCue | null {
	if (!isRecord(raw)) return null;
	const id = typeof raw.id === 'string' ? raw.id : uid('cue');
	const startMs = Number(raw.startMs);
	const endMs = Number(raw.endMs);
	if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;

	return createSubtitleCue(index, {
		id,
		startMs,
		endMs,
		pictureStartMs: Number.isFinite(Number(raw.pictureStartMs))
			? Number(raw.pictureStartMs)
			: startMs,
		pictureEndMs: Number.isFinite(Number(raw.pictureEndMs))
			? Number(raw.pictureEndMs)
			: endMs,
		source: typeof raw.source === 'string' ? raw.source : '',
		translation: typeof raw.translation === 'string' ? raw.translation : '',
		speaker: typeof raw.speaker === 'string' ? raw.speaker : 'Speaker 1',
		pitch: Number.isFinite(Number(raw.pitch)) ? Number(raw.pitch) : 0,
		speed: Number.isFinite(Number(raw.speed)) ? Number(raw.speed) : 1,
		volume: Number.isFinite(Number(raw.volume)) ? Number(raw.volume) : 80,
		voiceId: typeof raw.voiceId === 'string' ? raw.voiceId : 'km-KH-SreymomNeural',
		status:
			raw.status === 'ready' || raw.status === 'generated' || raw.status === 'error'
				? raw.status
				: 'draft',
		assignedAudio: isRecord(raw.assignedAudio)
			? {
					sourceCueId: String(raw.assignedAudio.sourceCueId ?? ''),
					label: String(raw.assignedAudio.label ?? ''),
					generated: raw.assignedAudio.generated === true,
					filePath:
						typeof raw.assignedAudio.filePath === 'string' ? raw.assignedAudio.filePath : null,
					url: typeof raw.assignedAudio.url === 'string' ? raw.assignedAudio.url : null,
					durationMs: Number.isFinite(Number(raw.assignedAudio.durationMs))
						? Number(raw.assignedAudio.durationMs)
						: undefined,
					engine: typeof raw.assignedAudio.engine === 'string' ? raw.assignedAudio.engine : undefined,
					fitPlaybackRate: Number.isFinite(Number(raw.assignedAudio.fitPlaybackRate))
						? Math.max(0.5, Math.min(2.5, Number(raw.assignedAudio.fitPlaybackRate)))
						: undefined,
					sourceText:
						typeof raw.assignedAudio.sourceText === 'string'
							? raw.assignedAudio.sourceText
							: undefined
				}
			: null
	});
}

function normalizeSubtitleStyle(raw: unknown): SubtitleStyle {
	if (!isRecord(raw)) return { ...DEFAULT_SUBTITLE_STYLE };
	const fontFamily =
		typeof raw.fontFamily === 'string' && raw.fontFamily.trim()
			? raw.fontFamily.trim()
			: DEFAULT_SUBTITLE_STYLE.fontFamily;
	const fontFile =
		typeof raw.fontFile === 'string' && raw.fontFile.trim()
			? raw.fontFile.trim()
			: raw.fontFile === null
				? null
				: DEFAULT_SUBTITLE_STYLE.fontFile ?? null;
	const fontSizePx = Number.isFinite(Number(raw.fontSizePx))
		? Math.max(12, Math.min(72, Math.round(Number(raw.fontSizePx))))
		: DEFAULT_SUBTITLE_STYLE.fontSizePx;
	const x = Number.isFinite(Number(raw.x))
		? Math.max(0.05, Math.min(0.95, Number(raw.x)))
		: DEFAULT_SUBTITLE_STYLE.x;
	let y = Number.isFinite(Number(raw.y))
		? Math.max(0.03, Math.min(0.97, Number(raw.y)))
		: DEFAULT_SUBTITLE_STYLE.y;
	// Legacy coords → sit under EN hardsubs, clear of bottom player chrome.
	if (y >= 0.9 || Math.abs(y - 0.78) < 0.001 || Math.abs(y - 0.88) < 0.001) y = 0.84;
	const look: SubtitleStyle['look'] =
		raw.look === 'box' || raw.look === 'outline' ? raw.look : DEFAULT_SUBTITLE_STYLE.look;
	let maxWidthPct = Number.isFinite(Number(raw.maxWidthPct))
		? Math.max(0.2, Math.min(0.98, Number(raw.maxWidthPct)))
		: DEFAULT_SUBTITLE_STYLE.maxWidthPct;
	// Legacy defaults wrapped Khmer too early (box was narrow + export over-counted em width).
	if (Math.abs(maxWidthPct - 0.86) < 0.001 || Math.abs(maxWidthPct - 0.92) < 0.001) {
		maxWidthPct = DEFAULT_SUBTITLE_STYLE.maxWidthPct;
	}
	const outlineWidth = Number.isFinite(Number(raw.outlineWidth))
		? Math.max(0, Math.min(5, Number(raw.outlineWidth)))
		: DEFAULT_SUBTITLE_STYLE.outlineWidth;
	return { fontFamily, fontFile, fontSizePx, x, y, look, maxWidthPct, outlineWidth };
}

/** Default voice for a speaker gender on the active TTS engine. */
export function voiceIdForSpeakerGender(
	gender: string,
	engine: TtsEngineId | string = 'edge-tts'
): string {
	const eng: TtsEngineId = engine === 'voxcpm' ? 'voxcpm' : 'edge-tts';
	return voiceIdForEngineGender(eng, gender) || DEFAULT_EDGE_VOICE_ID;
}

function normalizeTitleLiverClips(raw: unknown): TitleLiverClip[] {
	if (!Array.isArray(raw)) return [];
	const out: TitleLiverClip[] = [];
	const valid: TitleLiverTemplateId[] = [
		'soft-bar',
		'news-strip',
		'speaker-chip',
		'glass-ribbon',
		'dual-stack',
		'ticker-edge',
		'cinema-card',
		'spotlight',
		'luxe-serif',
		'chapter-bump',
		'cobalt-l3rd',
		'between-red',
		'borealis-l3rd',
		'sunset-l3rd',
		'sapphire-l3rd',
		'stratosphere-l3rd',
		'zenith-l3rd',
		'aeronautic-l3rd',
		'news-feed-l3rd',
		'enterprise-l3rd',
		'fb-player-roll',
		'fb-score-bug',
		'fb-lineup',
		'fb-goal-banner',
		'fb-sub-board',
		'pill-badge',
		'minimal-rule',
		'podcast-tag',
		'location-pin',
		'outline-stroke',
		'split-duo',
		'ribbon-fold',
		'gradient-wash',
		'moire-band',
		'neon-frame',
		'social-handle',
		'kinetic-stack',
		'glitch-pop',
		'breaking-slash',
		'anchor-desk',
		'countdown-bug',
		'bracket-title',
		'quote-card',
		'whisper-serif',
		'end-slate',
		'fb-corner-clock',
		'fb-possession',
		'fb-org-chart',
		'live-alert',
		'corner-bug'
	];
	for (const item of raw) {
		if (!item || typeof item !== 'object') continue;
		const o = item as Record<string, unknown>;
		const id = typeof o.id === 'string' ? o.id.trim() : '';
		if (!id) continue;
		const templateRaw = typeof o.templateId === 'string' ? o.templateId : 'soft-bar';
		const templateId = (valid.includes(templateRaw as TitleLiverTemplateId)
			? templateRaw
			: 'soft-bar') as TitleLiverTemplateId;
		const startMs = Number.isFinite(Number(o.startMs)) ? Math.max(0, Math.round(Number(o.startMs))) : 0;
		const endMs = Number.isFinite(Number(o.endMs))
			? Math.max(startMs + 400, Math.round(Number(o.endMs)))
			: startMs + 4000;
		out.push(
			createTitleLiverClip({
				id,
				templateId,
				startMs,
				endMs,
				line1: typeof o.line1 === 'string' ? o.line1 : 'Speaker name',
				line2: typeof o.line2 === 'string' ? o.line2 : 'Role or title',
				line3: typeof o.line3 === 'string' ? o.line3 : '',
				accent: typeof o.accent === 'string' && o.accent.trim() ? o.accent.trim() : '#7c3aed',
				x: Number.isFinite(Number(o.x)) ? Number(o.x) : undefined,
				y: Number.isFinite(Number(o.y)) ? Number(o.y) : undefined,
				fontFamily: typeof o.fontFamily === 'string' ? o.fontFamily : undefined,
				fontFile: typeof o.fontFile === 'string' ? o.fontFile : o.fontFile === null ? null : undefined,
				fontSizePx: Number.isFinite(Number(o.fontSizePx)) ? Number(o.fontSizePx) : undefined,
				outlineWidth: Number.isFinite(Number(o.outlineWidth)) ? Number(o.outlineWidth) : undefined,
				scale: Number.isFinite(Number(o.scale)) ? Number(o.scale) : undefined,
				maxWidthPct: Number.isFinite(Number(o.maxWidthPct)) ? Number(o.maxWidthPct) : undefined
			})
		);
	}
	return out;
}

function normalizeSpeakerBank(raw: unknown): SpeakerVoiceProfile[] {
	if (!Array.isArray(raw)) return [];
	const out: SpeakerVoiceProfile[] = [];
	for (const item of raw) {
		if (!isRecord(item)) continue;
		const id = typeof item.id === 'string' ? item.id.trim() : '';
		if (!id) continue;
		const genderRaw = typeof item.gender === 'string' ? item.gender.toLowerCase() : 'neutral';
		const gender: SpeakerVoiceProfile['gender'] =
			genderRaw === 'male' || genderRaw === 'female' ? genderRaw : 'neutral';
		const refWavPath = typeof item.refWavPath === 'string' ? item.refWavPath : '';
		const videoRefWavPath =
			typeof item.videoRefWavPath === 'string' && item.videoRefWavPath.trim()
				? item.videoRefWavPath.trim()
				: undefined;
		const cueCount = Number.isFinite(Number(item.cueCount)) ? Number(item.cueCount) : 0;
		const voiceId =
			typeof item.voiceId === 'string' && item.voiceId
				? item.voiceId
				: voiceIdForSpeakerGender(gender);
		// Legacy: video detect wrote refWavPath without locked — do not treat as preset lock.
		const locked =
			item.locked === true && typeof refWavPath === 'string' && refWavPath.trim().length > 0;
		out.push({
			id,
			gender,
			refWavPath: locked ? refWavPath : '',
			locked,
			cueCount,
			voiceId,
			...(videoRefWavPath
				? { videoRefWavPath }
				: !locked && refWavPath
					? { videoRefWavPath: refWavPath }
					: {})
		});
	}
	return out;
}

/** Validate / normalize a persisted project payload. */
export function parseProject(raw: unknown): DubbingProject | null {
	if (!isRecord(raw)) return null;
	if (typeof raw.id !== 'string' || typeof raw.name !== 'string') return null;

	const cuesRaw = Array.isArray(raw.cues) ? raw.cues : [];
	const cues = cuesRaw
		.map((c, i) => normalizeCue(c, i + 1))
		.filter((c): c is SubtitleCue => c != null)
		.map((c, i) => ({ ...c, index: i + 1 }));

	const assets: MediaAsset[] = Array.isArray(raw.assets)
		? raw.assets
				.filter(isRecord)
				.map((a) => {
					const kind: MediaKind =
						a.kind === 'audio' || a.kind === 'subtitle' || a.kind === 'video'
							? a.kind
							: 'video';
					return {
						id: typeof a.id === 'string' ? a.id : uid('asset'),
						name: typeof a.name === 'string' ? a.name : 'Media',
						kind,
						path: typeof a.path === 'string' ? a.path : '',
						durationMs: Number.isFinite(Number(a.durationMs)) ? Number(a.durationMs) : 0,
						createdAt: typeof a.createdAt === 'string' ? a.createdAt : new Date().toISOString()
					};
				})
		: [];

	const base = createEmptyProject(raw.name);
	return {
		...base,
		id: raw.id,
		name: raw.name,
		sourceLanguage: typeof raw.sourceLanguage === 'string' ? raw.sourceLanguage : base.sourceLanguage,
		targetLanguage: typeof raw.targetLanguage === 'string' ? raw.targetLanguage : base.targetLanguage,
		fps: Number.isFinite(Number(raw.fps)) ? Number(raw.fps) : base.fps,
		durationMs: Number.isFinite(Number(raw.durationMs))
			? Math.max(1000, Number(raw.durationMs))
			: base.durationMs,
		mediaTempoFromSource: Number.isFinite(Number(raw.mediaTempoFromSource))
			? Math.max(0.25, Math.min(2, Number(raw.mediaTempoFromSource)))
			: 1,
		videoAssetId: typeof raw.videoAssetId === 'string' ? raw.videoAssetId : null,
		assets,
		tracks: Array.isArray(raw.tracks) && raw.tracks.length ? (raw.tracks as DubbingTrack[]) : base.tracks,
		cues,
		subtitleStyle: normalizeSubtitleStyle(raw.subtitleStyle),
		speakerBank: normalizeSpeakerBank(raw.speakerBank),
		titleLiverClips: normalizeTitleLiverClips(raw.titleLiverClips),
		updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString()
	};
}

/** Clone project data safe for JSON persistence (no runtime URLs).
 * Uses JSON round-trip — `structuredClone` cannot clone Svelte 5 `$state` proxies.
 */
export function serializeProject(project: DubbingProject): DubbingProject {
	const plain: DubbingProject = {
		...project,
		assets: [...project.assets],
		tracks: [...project.tracks],
		cues: project.cues.map((c) => ({ ...c })),
		subtitleStyle: { ...project.subtitleStyle },
		speakerBank: (project.speakerBank ?? []).map((s) => ({ ...s })),
		titleLiverClips: (project.titleLiverClips ?? []).map((c) => ({ ...c })),
		updatedAt: new Date().toISOString()
	};
	return JSON.parse(JSON.stringify(plain)) as DubbingProject;
}

export function saveProjectToStorage(project: DubbingProject): boolean {
	try {
		localStorage.setItem(PROJECT_STORAGE_KEY, JSON.stringify(serializeProject(project)));
		return true;
	} catch {
		return false;
	}
}

export function loadProjectFromStorage(): DubbingProject | null {
	try {
		const raw = localStorage.getItem(PROJECT_STORAGE_KEY);
		if (!raw) return null;
		return parseProject(JSON.parse(raw));
	} catch {
		return null;
	}
}

export function clearProjectStorage(): void {
	try {
		localStorage.removeItem(PROJECT_STORAGE_KEY);
	} catch {
		/* ignore */
	}
}
