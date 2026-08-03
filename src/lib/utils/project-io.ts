import type {
	DubbingProject,
	DubbingTrack,
	MediaAsset,
	MediaKind,
	SubtitleCue
} from '$lib/types/project';

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
		videoAssetId: null,
		assets: [],
		tracks,
		cues: [],
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

	return {
		id: input.id ?? uid('cue'),
		index,
		startMs,
		endMs,
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
						: undefined
				}
			: null
	});
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
		videoAssetId: typeof raw.videoAssetId === 'string' ? raw.videoAssetId : null,
		assets,
		tracks: Array.isArray(raw.tracks) && raw.tracks.length ? (raw.tracks as DubbingTrack[]) : base.tracks,
		cues,
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
