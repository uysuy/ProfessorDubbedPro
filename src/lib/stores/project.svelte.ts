import type { DubbingProject, SubtitleCue, VoiceProfile } from '$lib/types/project';
import { classifyMediaFile } from '$lib/utils/media';
import { extractWaveformFromFile, extractWaveformFromUrl } from '$lib/utils/audio-waveform';
import {
	clearProjectStorage,
	createEmptyProject,
	createMediaAsset,
	createSubtitleCue,
	loadProjectFromStorage,
	saveProjectToStorage,
	serializeProject,
	type NewCueInput
} from '$lib/utils/project-io';
import {
	buildRecoveryDocument,
	saveRecoveryToLocalStorage
} from '$lib/utils/project-file';
import { preferencesStore, languageLabel, normalizeDubLanguage } from '$lib/stores/preferences.svelte';
import { voicesStore } from '$lib/stores/voices.svelte';
import { setVisualPlayheadMs } from '$lib/stores/playback-clock';
import { getTtsEngine } from '$lib/tts';
import { TtsError } from '$lib/tts/types';
import { migrateVoiceId } from '$lib/tts/edge-voices';
import { peaksForClip } from '$lib/utils/timeline';
import { isTauriRuntime } from '$lib/utils/platform';
	import { cueAudioEndMs, computePlaybackFitRate, planTtsFit, resolveLipSyncEndMs } from '$lib/utils/tts-fit';

/** Live Edge-TTS Khmer voices (reactive via voicesStore). */
export function getVoices(): VoiceProfile[] {
	return voicesStore.voices;
}

/** @deprecated Use voicesStore.voices — re-exported for gradual migration. */
export const voices = new Proxy([] as VoiceProfile[], {
	get(_target, prop, receiver) {
		const list = voicesStore.voices;
		if (prop === 'length') return list.length;
		if (prop === Symbol.iterator) return list[Symbol.iterator].bind(list);
		if (typeof prop === 'string' && /^\d+$/.test(prop)) return list[Number(prop)];
		const value = Reflect.get(list, prop, receiver);
		return typeof value === 'function' ? value.bind(list) : value;
	}
});

function initialProject(): DubbingProject {
	return createEmptyProject(undefined, {
		sourceLanguage: 'en',
		targetLanguage: preferencesStore.defaultLanguage
	});
}

let project = $state<DubbingProject>(initialProject());
/** Runtime object URL for the loaded video file (not persisted). */
let videoUrl = $state<string | null>(null);
/** In-memory source file for export staging when no filesystem path is available. */
let videoFile = $state<File | null>(null);
/** Absolute filesystem path when opened via native dialog (preferred for FFmpeg). */
let videoPath = $state<string | null>(null);

/** Absolute filesystem path of the open .dubproj (not persisted in localStorage). */
let projectFilePath = $state<string | null>(null);
/** True when the in-memory project differs from the last save/load. */
let isDirty = $state(false);

const MAX_UNDO = 80;
let undoStack = $state<DubbingProject[]>([]);
let redoStack = $state<DubbingProject[]>([]);
let applyingHistory = false;

export type OriginalAudioStatus = 'idle' | 'loading' | 'ready' | 'error';

/** Runtime waveform for the Original Audio timeline track (not persisted). */
let originalAudio = $state<{
	status: OriginalAudioStatus;
	peaks: number[];
	durationMs: number;
	label: string;
}>({
	status: 'idle',
	peaks: [],
	durationMs: 0,
	label: ''
});
let originalAudioToken = 0;

/**
 * Playback clock — plain $state object so Svelte 5 reliably tracks
 * `playback.playheadMs` / `playback.isPlaying` across components
 * (plain-object getters were not updating the timeline playhead).
 */
export const playback = $state({
	playheadMs: 0,
	isPlaying: false,
	/**
	 * Cue started via subtitle-row / TTS-clip Play.
	 * Used for clear playing UI and auto-stop when the playhead leaves the cue.
	 */
	focusedCueId: null as string | null
});

let selectedCueIds = $state<string[]>([]);
let selectionAnchorId = $state<string | null>(null);
let leftCollapsed = $state(false);
let rightCollapsed = $state(false);
let activeVideoTool = $state('trim');
let activeDubTool = $state('translate');
let voiceId = $state(migrateVoiceId(preferencesStore.defaultVoiceId));
let pitch = $state(0);
let speed = $state(1);
let volume = $state(80);
let isGenerating = $state(false);
/** 0–100 while TTS generate is running. */
let generateProgress = $state(0);
/** Last generate error message (cleared on next successful start). */
let generateError = $state<string | null>(null);
/** Runtime waveform peaks for TTS clips (not persisted). */
let ttsWaveforms = $state<Record<string, number[]>>({});
let lastSavedAt = $state<string | null>(null);
let previewHeightPx = $state(360);
let didHydrate = false;

const PREVIEW_HEIGHT_KEY = 'pdp.previewHeight';
const PREVIEW_HEIGHT_MIN = 220;
const PREVIEW_HEIGHT_MAX = 720;

function revokeVideoUrl() {
	if (videoUrl) {
		// Only revoke blob: URLs we created — convertFileSrc paths are not object URLs.
		if (videoUrl.startsWith('blob:')) URL.revokeObjectURL(videoUrl);
		videoUrl = null;
	}
	videoFile = null;
	videoPath = null;
}

function resetOriginalAudio() {
	originalAudioToken += 1;
	originalAudio = {
		status: 'idle',
		peaks: [],
		durationMs: 0,
		label: ''
	};
}

async function extractOriginalAudioFromFile(file: File) {
	const token = ++originalAudioToken;
	originalAudio = {
		status: 'loading',
		peaks: [],
		durationMs: 0,
		label: file.name
	};
	try {
		const result = await extractWaveformFromFile(file, 2400);
		if (token !== originalAudioToken) return;
		originalAudio = {
			status: 'ready',
			peaks: result.peaks,
			durationMs: result.durationMs,
			label: file.name
		};
		// Prefer media duration from decoded audio when project duration is still a placeholder.
		if (result.durationMs > 1000 && Math.abs(result.durationMs - project.durationMs) > 500) {
			const videoId = project.videoAssetId;
			project = touch(
				{
					...project,
					durationMs: result.durationMs,
					assets: project.assets.map((a) =>
						a.id === videoId ? { ...a, durationMs: result.durationMs } : a
					)
				},
				{ recordHistory: false }
			);
		}
	} catch {
		if (token !== originalAudioToken) return;
		originalAudio = {
			status: 'error',
			peaks: [],
			durationMs: 0,
			label: file.name
		};
	}
}

/**
 * Fetch media from a convertFileSrc / blob URL and build the Original Audio waveform.
 * Used when the video was opened by filesystem path (Tauri dialog).
 */
async function extractOriginalAudioFromSrc(src: string, label: string) {
	const token = ++originalAudioToken;
	originalAudio = {
		status: 'loading',
		peaks: [],
		durationMs: 0,
		label
	};
	try {
		const res = await fetch(src);
		if (!res.ok) throw new Error(`Failed to read media (${res.status})`);
		const blob = await res.blob();
		const file = new File([blob], label, { type: blob.type || 'video/mp4' });
		if (token !== originalAudioToken) return;
		// Keep File for export staging fallback (path remains preferred for FFmpeg).
		videoFile = file;

		const result = await extractWaveformFromFile(file, 2400);
		if (token !== originalAudioToken) return;
		originalAudio = {
			status: 'ready',
			peaks: result.peaks,
			durationMs: result.durationMs,
			label
		};
		if (result.durationMs > 1000 && Math.abs(result.durationMs - project.durationMs) > 500) {
			const videoId = project.videoAssetId;
			project = touch(
				{
					...project,
					durationMs: result.durationMs,
					assets: project.assets.map((a) =>
						a.id === videoId ? { ...a, durationMs: result.durationMs } : a
					)
				},
				{ recordHistory: false }
			);
		}
	} catch {
		if (token !== originalAudioToken) return;
		originalAudio = {
			status: 'error',
			peaks: [],
			durationMs: 0,
			label
		};
	}
}

function clearHistory() {
	undoStack = [];
	redoStack = [];
}

function pushUndoSnapshot() {
	if (applyingHistory) return;
	undoStack = [...undoStack, serializeProject(project)].slice(-MAX_UNDO);
	redoStack = [];
}

function pruneSelectionToProject() {
	selectedCueIds = selectedCueIds.filter((id) => project.cues.some((c) => c.id === id));
	if (selectionAnchorId && !project.cues.some((c) => c.id === selectionAnchorId)) {
		selectionAnchorId = selectedCueIds[0] ?? project.cues[0]?.id ?? null;
	}
}

function touch(next: DubbingProject, opts?: { recordHistory?: boolean }): DubbingProject {
	if (opts?.recordHistory !== false) pushUndoSnapshot();
	isDirty = true;
	return { ...next, updatedAt: new Date().toISOString() };
}

function markClean(savedAt?: string) {
	isDirty = false;
	lastSavedAt = savedAt ?? new Date().toISOString();
}

function resetPlayback() {
	playback.isPlaying = false;
	playback.focusedCueId = null;
	playback.playheadMs = 0;
	selectedCueIds = [];
	selectionAnchorId = null;
}

function clampPreviewHeight(px: number) {
	return Math.max(PREVIEW_HEIGHT_MIN, Math.min(PREVIEW_HEIGHT_MAX, Math.round(px)));
}

/** Project title from a media filename (strip extension, tidy whitespace). */
function titleFromMediaFileName(fileName: string): string {
	const base = fileName.split(/[/\\]/).pop()?.trim() || '';
	const stem = base.replace(/\.[^.]+$/, '').trim();
	return stem || base || 'Untitled Dub Session';
}

export const projectStore = {
	get current() {
		return project;
	},
	get videoUrl() {
		return videoUrl;
	},
	get videoFile() {
		return videoFile;
	},
	get videoPath() {
		return videoPath;
	},
	get videoAsset() {
		if (!project.videoAssetId) return null;
		return project.assets.find((a) => a.id === project.videoAssetId) ?? null;
	},
	get originalAudio() {
		return originalAudio;
	},
	get playheadMs() {
		return playback.playheadMs;
	},
	get isPlaying() {
		return playback.isPlaying;
	},
	get previewHeightPx() {
		return previewHeightPx;
	},
	get selectedCueIds() {
		return selectedCueIds;
	},
	get leftCollapsed() {
		return leftCollapsed;
	},
	get rightCollapsed() {
		return rightCollapsed;
	},
	get activeVideoTool() {
		return activeVideoTool;
	},
	get activeDubTool() {
		return activeDubTool;
	},
	get voiceId() {
		return voiceId;
	},
	get pitch() {
		return pitch;
	},
	get speed() {
		return speed;
	},
	get volume() {
		return volume;
	},
	get isGenerating() {
		return isGenerating;
	},
	get generateProgress() {
		return generateProgress;
	},
	get generateError() {
		return generateError;
	},
	/** Waveform peaks for a TTS clip (real Edge audio when available). */
	ttsPeaksForCue(cueId: string, widthPx: number, barWidth = 2): number[] {
		const real = ttsWaveforms[cueId];
		if (real?.length) {
			const count = Math.max(8, Math.floor(widthPx / barWidth));
			if (real.length === count) return real;
			// Resample cached peaks to the requested bar count.
			const out = new Array<number>(count);
			for (let i = 0; i < count; i++) {
				const src = Math.min(real.length - 1, Math.floor((i / count) * real.length));
				out[i] = real[src] ?? 0.1;
			}
			return out;
		}
		return peaksForClip(`tts-${cueId}`, widthPx, barWidth);
	},
	get lastSavedAt() {
		return lastSavedAt;
	},
	get isDirty() {
		return isDirty;
	},
	get projectFilePath() {
		return projectFilePath;
	},
	get canUndo() {
		return undoStack.length > 0;
	},
	get canRedo() {
		return redoStack.length > 0;
	},
	get activeCueId() {
		const cue = project.cues.find(
			(item) =>
				playback.playheadMs >= item.startMs && playback.playheadMs < item.endMs
		);
		return cue?.id ?? null;
	},
	get activeCue() {
		const id = this.activeCueId;
		if (!id) return null;
		return project.cues.find((c) => c.id === id) ?? null;
	},

	/** Load saved project once on client startup. */
	hydrate() {
		if (didHydrate) return;
		didHydrate = true;
		if (typeof localStorage === 'undefined') return;
		try {
			const rawH = localStorage.getItem(PREVIEW_HEIGHT_KEY);
			if (rawH) previewHeightPx = clampPreviewHeight(Number(rawH));
		} catch {
			/* ignore */
		}
		const loaded = loadProjectFromStorage();
		if (!loaded) return;
		revokeVideoUrl();
		resetOriginalAudio();
		project = loaded;
		projectFilePath = null;
		clearHistory();
		resetPlayback();
		markClean(loaded.updatedAt);
	},

	/** Create a fresh empty project (clears video + cues). */
	createProject(name?: string) {
		revokeVideoUrl();
		resetOriginalAudio();
		project = createEmptyProject(name, {
			sourceLanguage: 'en',
			targetLanguage: preferencesStore.defaultLanguage
		});
		projectFilePath = null;
		voiceId = migrateVoiceId(preferencesStore.defaultVoiceId);
		clearHistory();
		resetPlayback();
		clearProjectStorage();
		isDirty = false;
		lastSavedAt = null;
		void this.clearAllRecovery();
	},

	/** Persist project metadata to localStorage (video file itself is not stored). */
	saveProject(): boolean {
		const ok = saveProjectToStorage(this.snapshotForSave());
		if (ok) {
			markClean();
			void this.clearAllRecovery();
		}
		return ok;
	},

	/** Project snapshot with absolute video path embedded in the active asset. */
	snapshotForSave(): DubbingProject {
		const base = serializeProject(project);
		if (!project.videoAssetId || !videoPath) return base;
		return {
			...base,
			assets: base.assets.map((a) =>
				a.id === project.videoAssetId ? { ...a, path: videoPath as string } : a
			)
		};
	},

	buildSessionState() {
		return {
			playheadMs: playback.playheadMs,
			voiceId,
			pitch,
			speed,
			volume
		};
	},

	/**
	 * Write project to a .dubproj/.json file (Tauri dialog + fs).
	 * Reuses the last path unless `saveAs` is true.
	 */
	async saveProjectToFile(options?: { saveAs?: boolean }): Promise<string> {
		const { buildProjectDocument, saveProjectFile } = await import('$lib/utils/project-file');
		const document = buildProjectDocument(this.snapshotForSave(), this.buildSessionState());
		const path = await saveProjectFile({
			document,
			filePath: projectFilePath,
			suggestedName: project.name,
			saveAs: options?.saveAs === true
		});
		projectFilePath = path;
		saveProjectToStorage(document.project);
		markClean(document.savedAt);
		await this.clearAllRecovery();
		return path;
	},

	/** Build the recovery envelope for the current in-memory session. */
	buildRecoveryPayload() {
		return buildRecoveryDocument({
			project: this.snapshotForSave(),
			session: this.buildSessionState(),
			dirty: isDirty,
			projectFilePath,
			videoPath
		});
	},

	/** Sync localStorage recovery write (safe during beforeunload). */
	writeRecoverySync(): boolean {
		try {
			return saveRecoveryToLocalStorage(this.buildRecoveryPayload());
		} catch {
			return false;
		}
	},

	/** Write recovery to localStorage + optional AppData file. */
	async writeRecovery(): Promise<boolean> {
		const { saveRecoveryToAppData } = await import('$lib/utils/project-file');
		const doc = this.buildRecoveryPayload();
		const okLocal = saveRecoveryToLocalStorage(doc);
		await saveRecoveryToAppData(doc);
		return okLocal;
	},

	/**
	 * Quiet autosave: always refresh recovery; overwrite .dubproj when a path exists.
	 * No dialogs. Returns what was written.
	 */
	async autoSaveQuiet(): Promise<'skipped' | 'recovery' | 'file'> {
		if (!isDirty) return 'skipped';

		// Keep localStorage project metadata in sync (does not clear dirty).
		saveProjectToStorage(this.snapshotForSave());
		await this.writeRecovery();

		if (!projectFilePath?.trim()) return 'recovery';

		const {
			buildProjectDocument,
			writeProjectFileQuiet,
			clearRecoveryLocalStorage,
			clearRecoveryAppData
		} = await import('$lib/utils/project-file');
		const document = buildProjectDocument(this.snapshotForSave(), this.buildSessionState());
		const ok = await writeProjectFileQuiet(projectFilePath, document);
		if (!ok) return 'recovery';

		saveProjectToStorage(document.project);
		markClean(document.savedAt);
		clearRecoveryLocalStorage();
		await clearRecoveryAppData();
		return 'file';
	},

	/**
	 * Best-effort flush on hide/close: sync recovery, then quiet file save when possible.
	 */
	async flushAutosave(_opts?: { reason?: 'hidden' | 'close' }): Promise<void> {
		this.writeRecoverySync();
		if (!isDirty) {
			await this.clearAllRecovery();
			return;
		}
		if (projectFilePath?.trim()) {
			try {
				await this.autoSaveQuiet();
			} catch {
				/* recovery already written */
			}
		} else {
			await this.writeRecovery();
		}
	},

	async peekRecovery() {
		const {
			loadRecoveryFromLocalStorage,
			loadRecoveryFromAppData
		} = await import('$lib/utils/project-file');
		const local = loadRecoveryFromLocalStorage();
		const disk = await loadRecoveryFromAppData();
		if (!local) return disk;
		if (!disk) return local;
		const localTs = Date.parse(local.savedAt) || 0;
		const diskTs = Date.parse(disk.savedAt) || 0;
		return diskTs > localTs ? disk : local;
	},

	async clearAllRecovery(): Promise<void> {
		const { clearRecoveryLocalStorage, clearRecoveryAppData } = await import(
			'$lib/utils/project-file'
		);
		clearRecoveryLocalStorage();
		await clearRecoveryAppData();
	},

	/**
	 * Apply recovery metadata when cues are already loaded (same updatedAt).
	 * Restores dirty flag + file/video paths without reloading the project body.
	 */
	async applyRecoveryMeta(doc: {
		dirty: boolean;
		projectFilePath: string | null;
		videoPath: string | null;
		savedAt: string;
	}): Promise<void> {
		if (doc.projectFilePath) projectFilePath = doc.projectFilePath;
		if (doc.dirty) {
			isDirty = true;
			lastSavedAt = doc.savedAt;
		}
		const pathHint = doc.videoPath?.trim() || '';
		if (pathHint && !videoUrl) {
			const { looksLikeAbsolutePath } = await import('$lib/utils/project-file');
			if (looksLikeAbsolutePath(pathHint)) {
				await this.setVideoFromPath(pathHint, { syncTitle: false });
			}
		}
		await this.clearAllRecovery();
	},

	/** Apply a recovery document into the live session (keeps dirty if recovery was dirty). */
	async restoreFromRecovery(doc: {
		project: import('$lib/types/project').DubbingProject;
		session?: {
			playheadMs?: number;
			voiceId?: string;
			pitch?: number;
			speed?: number;
			volume?: number;
		};
		dirty: boolean;
		projectFilePath: string | null;
		videoPath: string | null;
		savedAt: string;
	}): Promise<{ videoMissing: boolean }> {
		const { looksLikeAbsolutePath } = await import('$lib/utils/project-file');
		revokeVideoUrl();
		resetOriginalAudio();
		project = doc.project;
		projectFilePath = doc.projectFilePath;
		clearHistory();
		resetPlayback();

		if (doc.session) {
			if (typeof doc.session.voiceId === 'string') {
				voiceId = voicesStore.ensureVoicePresent(doc.session.voiceId);
			}
			if (typeof doc.session.pitch === 'number') pitch = doc.session.pitch;
			if (typeof doc.session.speed === 'number') speed = doc.session.speed;
			if (typeof doc.session.volume === 'number') volume = doc.session.volume;
		}

		let videoMissing = false;
		const restoredPlayhead =
			typeof doc.session?.playheadMs === 'number' ? doc.session.playheadMs : 0;
		const pathHint = doc.videoPath?.trim() || '';
		const videoAsset =
			(project.videoAssetId
				? project.assets.find((a) => a.id === project.videoAssetId)
				: null) ?? project.assets.find((a) => a.kind === 'video') ?? null;
		const mediaPath = pathHint || videoAsset?.path?.trim() || '';
		if (mediaPath && looksLikeAbsolutePath(mediaPath)) {
			const ok = await this.setVideoFromPath(mediaPath, { syncTitle: false });
			if (!ok) videoMissing = true;
		} else if (project.videoAssetId || project.assets.some((a) => a.kind === 'video')) {
			videoMissing = true;
		}

		playback.playheadMs = Math.max(
			0,
			Math.min(project.durationMs || restoredPlayhead, restoredPlayhead)
		);
		saveProjectToStorage(project);
		clearHistory();
		if (doc.dirty) {
			isDirty = true;
			lastSavedAt = doc.savedAt;
		} else {
			markClean(doc.savedAt);
		}
		await this.clearAllRecovery();
		return { videoMissing };
	},

	/**
	 * Open a .dubproj/.json from disk and restore cues + video (when path is valid).
	 */
	async openProjectFromFile(): Promise<{ path: string; videoMissing: boolean }> {
		const { openProjectFile, looksLikeAbsolutePath } = await import('$lib/utils/project-file');
		const { path, document } = await openProjectFile();

		revokeVideoUrl();
		resetOriginalAudio();
		project = document.project;
		projectFilePath = path;
		clearHistory();
		resetPlayback();

		if (document.session) {
			if (typeof document.session.voiceId === 'string') {
				voiceId = voicesStore.ensureVoicePresent(document.session.voiceId);
			}
			if (typeof document.session.pitch === 'number') pitch = document.session.pitch;
			if (typeof document.session.speed === 'number') speed = document.session.speed;
			if (typeof document.session.volume === 'number') volume = document.session.volume;
		}

		let videoMissing = false;
		const restoredPlayhead =
			typeof document.session?.playheadMs === 'number' ? document.session.playheadMs : 0;
		const videoAsset =
			(project.videoAssetId
				? project.assets.find((a) => a.id === project.videoAssetId)
				: null) ?? project.assets.find((a) => a.kind === 'video') ?? null;
		const mediaPath = videoAsset?.path?.trim() ?? '';
		if (mediaPath && looksLikeAbsolutePath(mediaPath)) {
			const ok = await this.setVideoFromPath(mediaPath, { syncTitle: false });
			if (!ok) videoMissing = true;
		} else if (project.videoAssetId || project.assets.some((a) => a.kind === 'video')) {
			videoMissing = true;
		}

		playback.playheadMs = Math.max(0, Math.min(project.durationMs || restoredPlayhead, restoredPlayhead));
		saveProjectToStorage(project);
		clearHistory();
		markClean(document.savedAt);
		await this.clearAllRecovery();
		return { path, videoMissing };
	},

	/** Load project metadata from localStorage. Video must be re-opened by the user. */
	loadProject(): boolean {
		const loaded = loadProjectFromStorage();
		if (!loaded) return false;
		revokeVideoUrl();
		resetOriginalAudio();
		project = loaded;
		projectFilePath = null;
		clearHistory();
		resetPlayback();
		markClean(loaded.updatedAt);
		return true;
	},

	/** Restore the previous project snapshot. */
	undo(): boolean {
		if (!undoStack.length) return false;
		applyingHistory = true;
		const prev = undoStack[undoStack.length - 1];
		undoStack = undoStack.slice(0, -1);
		redoStack = [...redoStack, serializeProject(project)].slice(-MAX_UNDO);
		project = prev;
		pruneSelectionToProject();
		isDirty = true;
		applyingHistory = false;
		return true;
	},

	/** Re-apply a snapshot undone by `undo`. */
	redo(): boolean {
		if (!redoStack.length) return false;
		applyingHistory = true;
		const next = redoStack[redoStack.length - 1];
		redoStack = redoStack.slice(0, -1);
		undoStack = [...undoStack, serializeProject(project)].slice(-MAX_UNDO);
		project = next;
		pruneSelectionToProject();
		isDirty = true;
		applyingHistory = false;
		return true;
	},

	setPlayhead(ms: number) {
		const safe = Number.isFinite(ms) ? ms : 0;
		// Prefer real timeline length; never clamp a running clock into a 1ms window.
		const max =
			project.durationMs > 1 ? project.durationMs : Math.max(safe, project.durationMs || 0);
		playback.playheadMs = Math.max(0, max > 0 ? Math.min(max, safe) : safe);
	},
	togglePlayback() {
		if (playback.isPlaying) {
			this.pausePlayback();
		} else {
			playback.focusedCueId = null;
			playback.isPlaying = true;
		}
	},
	/** Pause without moving the playhead (used when media ends). */
	pausePlayback() {
		playback.isPlaying = false;
		playback.focusedCueId = null;
	},
	stop() {
		playback.isPlaying = false;
		playback.focusedCueId = null;
		playback.playheadMs = 0;
	},

	setPreviewHeight(px: number) {
		previewHeightPx = clampPreviewHeight(px);
		try {
			localStorage.setItem(PREVIEW_HEIGHT_KEY, String(previewHeightPx));
		} catch {
			/* ignore */
		}
	},
	selectCue(id: string, additive = false) {
		this.selectCueAt(id, { toggle: additive });
	},
	selectCueAt(id: string, opts?: { toggle?: boolean; range?: boolean }) {
		if (opts?.range && selectionAnchorId) {
			const ids = project.cues.map((cue) => cue.id);
			const a = ids.indexOf(selectionAnchorId);
			const b = ids.indexOf(id);
			if (a >= 0 && b >= 0) {
				const lo = Math.min(a, b);
				const hi = Math.max(a, b);
				selectedCueIds = ids.slice(lo, hi + 1);
				return;
			}
		}
		if (opts?.toggle) {
			selectedCueIds = selectedCueIds.includes(id)
				? selectedCueIds.filter((x) => x !== id)
				: [...selectedCueIds, id];
			selectionAnchorId = id;
			return;
		}
		selectedCueIds = [id];
		selectionAnchorId = id;
	},
	toggleCueSelected(id: string) {
		selectedCueIds = selectedCueIds.includes(id)
			? selectedCueIds.filter((x) => x !== id)
			: [...selectedCueIds, id];
		selectionAnchorId = id;
	},
	setCueSelected(id: string, selected: boolean) {
		if (selected) {
			if (!selectedCueIds.includes(id)) selectedCueIds = [...selectedCueIds, id];
			selectionAnchorId = id;
			return;
		}
		selectedCueIds = selectedCueIds.filter((x) => x !== id);
	},
	selectAllCues(selected: boolean) {
		selectedCueIds = selected ? project.cues.map((cue) => cue.id) : [];
		selectionAnchorId = selected ? (project.cues[0]?.id ?? null) : null;
	},

	/**
	 * Replace all subtitle cues with Whisper transcript segments.
	 * Source text = original language; translation left empty for dubbing.
	 */
	applyTranscriptSegments(
		segments: { startMs?: number; endMs?: number; text?: string; start_ms?: number; end_ms?: number }[],
		opts?: { sourceLanguage?: string }
	): number {
		if (!segments.length) return 0;

		const detected = (opts?.sourceLanguage ?? '').trim().toLowerCase();
		const nextSource = detected.startsWith('km')
			? 'km'
			: detected.startsWith('en')
				? 'en'
				: detected.startsWith('zh') || detected === 'chinese' || detected === 'china'
					? 'zh'
					: project.sourceLanguage;

		const cues = segments
			.map((seg) => {
				const startMs = Math.max(0, Math.round(Number(seg.startMs ?? seg.start_ms ?? 0)));
				const endMs = Math.max(
					startMs + 120,
					Math.round(Number(seg.endMs ?? seg.end_ms ?? startMs + 2000))
				);
				const text = String(seg.text ?? '').trim();
				if (!text) return null;
				// Original speech stays in `source`. Khmer Text (`translation`) starts empty
				// so Translate can fill it without silently overwriting.
				return createSubtitleCue(
					0,
					{
						startMs,
						endMs,
						source: text,
						translation: '',
						status: 'ready',
						speaker: 'Speaker 1',
						voiceId
					},
					{ voiceId, speaker: 'Speaker 1' }
				);
			})
			.filter((c): c is NonNullable<typeof c> => c != null)
			.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
			.map((c, i) => ({ ...c, index: i + 1 }));

		if (!cues.length) return 0;

		const maxEnd = cues.reduce((m, c) => Math.max(m, c.endMs), 0);
		project = touch({
			...project,
			sourceLanguage: nextSource,
			cues,
			durationMs: Math.max(project.durationMs, maxEnd + 500),
			tracks: project.tracks.map((t) =>
				t.role === 'dialogue' ? { ...t, language: nextSource } : t
			)
		});
		ttsWaveforms = {};
		selectedCueIds = cues[0] ? [cues[0].id] : [];
		selectionAnchorId = cues[0]?.id ?? null;
		playback.playheadMs = cues[0]?.startMs ?? 0;
		return cues.length;
	},

	/** Append a new subtitle row. Returns the new cue id. */
	addCue(input: NewCueInput = {}): string {
		const last = project.cues[project.cues.length - 1];
		const startMs =
			input.startMs ??
			(last ? last.endMs : Math.min(playback.playheadMs, Math.max(0, project.durationMs - 2000)));
		const endMs = input.endMs ?? Math.min(project.durationMs, startMs + 2000);
		const cue = createSubtitleCue(
			project.cues.length + 1,
			{
				translation: 'New subtitle',
				...input,
				startMs,
				endMs
			},
			{ voiceId, speaker: 'Speaker 1' }
		);
		project = touch({
			...project,
			cues: [...project.cues, cue]
		});
		selectedCueIds = [cue.id];
		selectionAnchorId = cue.id;
		return cue.id;
	},

	/**
	 * Insert a row above/below an existing cue (translator-friendly).
	 * Returns the new cue id, or null if the anchor is missing.
	 */
	insertCueRelative(anchorId: string, where: 'above' | 'below'): string | null {
		const idx = project.cues.findIndex((c) => c.id === anchorId);
		if (idx < 0) return null;
		const anchor = project.cues[idx];
		const duration = 2000;
		let startMs: number;
		let endMs: number;
		if (where === 'above') {
			endMs = Math.max(duration, anchor.startMs);
			startMs = Math.max(0, endMs - duration);
			if (startMs === endMs) endMs = Math.min(project.durationMs, startMs + duration);
		} else {
			startMs = Math.min(project.durationMs - 200, anchor.endMs);
			endMs = Math.min(project.durationMs, startMs + duration);
			if (endMs <= startMs) {
				startMs = Math.max(0, project.durationMs - duration);
				endMs = project.durationMs;
			}
		}

		const cue = createSubtitleCue(
			idx + (where === 'below' ? 2 : 1),
			{ startMs, endMs, translation: 'New subtitle' },
			{ voiceId, speaker: anchor.speaker || 'Speaker 1' }
		);
		const cues = [...project.cues];
		cues.splice(where === 'above' ? idx : idx + 1, 0, cue);
		project = touch({
			...project,
			cues: cues.map((c, i) => ({ ...c, index: i + 1 }))
		});
		selectedCueIds = [cue.id];
		selectionAnchorId = cue.id;
		return cue.id;
	},

	deleteCues(ids: string[]) {
		if (!ids.length) return;
		const remove = new Set(ids);
		project = touch({
			...project,
			cues: project.cues
				.filter((cue) => !remove.has(cue.id))
				.map((cue, i) => ({ ...cue, index: i + 1 }))
		});
		selectedCueIds = selectedCueIds.filter((id) => !remove.has(id));
		if (selectionAnchorId && remove.has(selectionAnchorId)) {
			selectionAnchorId = selectedCueIds[0] ?? project.cues[0]?.id ?? null;
		}
	},

	/** Duplicate the primary selected cue right after it (no time overlap). Returns new id. */
	duplicateSelectedCue(): string | null {
		const id = selectedCueIds[0];
		if (!id) return null;
		const idx = project.cues.findIndex((c) => c.id === id);
		if (idx < 0) return null;
		const src = project.cues[idx];
		const duration = Math.max(200, src.endMs - src.startMs);
		const maxEnd = Math.max(project.durationMs, src.endMs + duration);
		let startMs = src.endMs;
		let endMs = startMs + duration;
		if (endMs > maxEnd) {
			endMs = maxEnd;
			startMs = Math.max(src.endMs, endMs - duration);
		}
		// Keep a tiny gap only if start would equal previous end and both collapse — prefer abutting.
		if (endMs <= startMs) {
			startMs = src.endMs;
			endMs = startMs + 200;
		}

		const clone = createSubtitleCue(
			idx + 2,
			{
				startMs,
				endMs,
				source: src.source,
				translation: src.translation,
				speaker: src.speaker,
				pitch: src.pitch,
				speed: src.speed,
				volume: src.volume,
				voiceId: src.voiceId,
				status: src.status === 'generated' ? 'ready' : src.status,
				assignedAudio: src.assignedAudio ? { ...src.assignedAudio } : null
			},
			{ voiceId: src.voiceId, speaker: src.speaker }
		);
		const cues = [...project.cues];
		cues.splice(idx + 1, 0, clone);
		project = touch({
			...project,
			durationMs: Math.max(project.durationMs, endMs),
			cues: cues.map((c, i) => ({ ...c, index: i + 1 }))
		});
		selectedCueIds = [clone.id];
		selectionAnchorId = clone.id;
		return clone.id;
	},

	/**
	 * Generate real TTS audio for cues via the active engine (Edge-TTS).
	 * Lip-sync (default): mild speed-up for listenability; extends the cue when Khmer
	 * is still longer than the Chinese window (avoids chipmunk speech).
	 * Preserve: milder rate change; may extend cues when speech is still longer.
	 */
	async generateCues(ids: string[]): Promise<number> {
		const unique = [...new Set(ids)].filter((id) => project.cues.some((c) => c.id === id));
		if (!unique.length || isGenerating) return 0;

		generateError = null;
		isGenerating = true;
		generateProgress = 2;

		const engine = getTtsEngine();
		const targetLang = normalizeDubLanguage(project.targetLanguage);
		const lipSync = preferencesStore.ttsLipSync;
		const fitMode = lipSync ? 'lipsync' : 'preserve';
		let completed = 0;
		const failures: string[] = [];

		const resolveAsset = async (filePath: string, cueKey: string) => {
			let url: string | null = null;
			let durationMs: number | undefined;
			let peaks: number[] | undefined;
			if (!isTauriRuntime() || !filePath) return { url, durationMs, peaks };
			try {
				const { convertFileSrc } = await import('@tauri-apps/api/core');
				url = convertFileSrc(filePath);
				try {
					const wave = await extractWaveformFromUrl(url, 120);
					peaks = wave.peaks;
					durationMs = wave.durationMs;
					ttsWaveforms = { ...ttsWaveforms, [cueKey]: wave.peaks };
				} catch {
					/* waveform optional — audio still plays */
				}
			} catch {
				/* convertFileSrc failed — mixer can resolve from filePath */
			}
			return { url, durationMs, peaks };
		};

		try {
			for (let i = 0; i < unique.length; i++) {
				const cueId = unique[i]!;
				const cue = project.cues.find((c) => c.id === cueId);
				if (!cue) continue;

				const text = (cue.translation?.trim() || cue.source?.trim() || '').trim();
				if (!text) {
					failures.push(`#${cue.index}: empty text`);
					generateProgress = Math.round(((i + 1) / unique.length) * 100);
					continue;
				}

				try {
					const usedVoiceId = migrateVoiceId(cue.voiceId || voiceId);
					const baseSpeed = Number.isFinite(cue.speed) ? cue.speed : speed;
					const basePitch = Number.isFinite(cue.pitch) ? cue.pitch : pitch;
					const baseVolume = Number.isFinite(cue.volume) ? cue.volume : volume;
					const windowStart = cue.startMs;
					const windowEnd = cue.endMs;
					const windowMs = Math.max(200, windowEnd - windowStart);

					// Pass 1 — full natural speech for the complete text.
					let result = await engine.synthesize({
						cueId: cue.id,
						text,
						voiceId: usedVoiceId,
						pitch: basePitch,
						speed: baseSpeed,
						volume: baseVolume,
						language: targetLang
					});

					let asset = await resolveAsset(result.filePath, cue.id);
					let appliedSpeed = baseSpeed;
					let fitPlaybackRate: number | undefined;
					let lipSyncEndMs = windowEnd;

					if (asset.durationMs && asset.durationMs > 0) {
						const plan = planTtsFit({
							startMs: windowStart,
							endMs: windowEnd,
							naturalDurationMs: asset.durationMs,
							baseSpeed,
							mode: fitMode
						});

						// Pass 2 — mild rate change when speech is longer than the video window.
						if (plan.needsResynth) {
							result = await engine.synthesize({
								cueId: cue.id,
								text,
								voiceId: usedVoiceId,
								pitch: basePitch,
								speed: plan.speed,
								volume: baseVolume,
								language: targetLang
							});
							asset = await resolveAsset(result.filePath, cue.id);
							appliedSpeed = plan.speed;
						}

						const finalDuration =
							asset.durationMs && asset.durationMs > 0
								? asset.durationMs
								: windowMs;

						if (lipSync) {
							// Soft Web Audio squeeze only — if still too long, extend the cue
							// instead of chipmunk-speed speech.
							fitPlaybackRate = computePlaybackFitRate(finalDuration, windowMs, 'lipsync');
							const resolved = resolveLipSyncEndMs({
								startMs: windowStart,
								windowEndMs: windowEnd,
								audioDurationMs: finalDuration,
								fitPlaybackRate
							});
							lipSyncEndMs = resolved.endMs;
							if (resolved.extendsCue && resolved.endMs > windowEnd + 40) {
								project = touch(
									{
										...project,
										durationMs: Math.max(project.durationMs, resolved.endMs + 200)
									},
									{ recordHistory: false }
								);
								this.trimCuePushNeighbors(
									cue.id,
									'end',
									windowStart,
									resolved.endMs,
									200
								);
							}
						} else {
							const fittedEnd = Math.max(windowEnd, windowStart + finalDuration);
							if (fittedEnd > windowEnd + 40) {
								project = touch(
									{
										...project,
										durationMs: Math.max(project.durationMs, fittedEnd + 200)
									},
									{ recordHistory: false }
								);
								this.trimCuePushNeighbors(cue.id, 'end', windowStart, fittedEnd, 200);
							}
						}
					} else if (lipSync) {
						fitPlaybackRate = 1;
					}

					const live = project.cues.find((c) => c.id === cue.id) ?? cue;
					const shortVoice =
						result.providerVoice.split('-').slice(-1)[0] ?? result.providerVoice;
					const label = `${engine.label} · ${voicesStore.find(usedVoiceId)?.name ?? shortVoice}`;

					project = touch({
						...project,
						cues: project.cues.map((c) => {
							if (c.id !== cue.id) return c;
							const endMs = lipSync
								? Math.max(lipSyncEndMs, live.endMs)
								: Math.max(
										c.endMs,
										c.startMs + (asset.durationMs ?? 0),
										live.endMs
									);
							return {
								...c,
								endMs,
								status: 'generated' as const,
								voiceId: usedVoiceId,
								pitch: basePitch,
								speed: appliedSpeed,
								volume: baseVolume,
								assignedAudio: {
									sourceCueId: c.id,
									label,
									generated: true,
									filePath: result.filePath,
									url: asset.url,
									durationMs: asset.durationMs,
									engine: result.engine,
									...(typeof fitPlaybackRate === 'number'
										? { fitPlaybackRate }
										: {})
								}
							};
						}),
						durationMs: Math.max(
							project.durationMs,
							(project.cues.find((c) => c.id === cue.id)?.endMs ?? windowEnd) + 200
						)
					});
					completed += 1;
				} catch (err) {
					const message =
						err instanceof TtsError
							? err.message
							: err instanceof Error
								? err.message
								: String(err);
					failures.push(`#${cue.index}: ${message}`);
					project = touch(
						{
							...project,
							cues: project.cues.map((c) =>
								c.id === cue.id ? { ...c, status: 'error' as const } : c
							)
						},
						{ recordHistory: false }
					);
				}

				generateProgress = Math.round(((i + 1) / unique.length) * 100);
			}

			if (failures.length && completed === 0) {
				generateError = failures[0] ?? 'TTS generation failed.';
			} else if (failures.length) {
				generateError = `${completed} generated, ${failures.length} failed. ${failures[0]}`;
			}

			return completed;
		} finally {
			isGenerating = false;
			if (generateProgress < 100 && completed > 0) generateProgress = 100;
			await new Promise((r) => setTimeout(r, 180));
			generateProgress = 0;
		}
	},

	/** Remove TTS audio from cues; keeps the subtitle rows. */
	clearTtsAudio(ids: string[]): number {
		const target = new Set(ids);
		let cleared = 0;
		const nextWaveforms = { ...ttsWaveforms };
		project = touch({
			...project,
			cues: project.cues.map((cue) => {
				if (!target.has(cue.id)) return cue;
				if (!cue.assignedAudio && cue.status !== 'generated' && cue.status !== 'error') {
					return cue;
				}
				cleared += 1;
				delete nextWaveforms[cue.id];
				return {
					...cue,
					status:
						cue.status === 'generated' || cue.status === 'error'
							? ('ready' as const)
							: cue.status,
					assignedAudio: null
				};
			})
		});
		ttsWaveforms = nextWaveforms;
		return cleared;
	},

	/** True when the cue should show a clip on the TTS Audio track. */
	cueHasTtsAudio(cue: { status: string; assignedAudio?: unknown }): boolean {
		return cue.status === 'generated' || cue.assignedAudio != null;
	},

	updateCue(id: string, patch: Partial<Omit<SubtitleCue, 'id' | 'index'>>) {
		project = touch({
			...project,
			cues: project.cues.map((cue) => {
				if (cue.id !== id) return cue;
				const next = { ...cue, ...patch };
				if (typeof patch.voiceId === 'string') {
					next.voiceId = migrateVoiceId(patch.voiceId);
				}
				if (next.endMs < next.startMs) next.endMs = next.startMs;
				return next;
			})
		});
	},

	/**
	 * Resize a subtitle cue and push overlapping neighbors so clips never stack.
	 * - Growing the end into the next cue moves that cue's start (and cascades).
	 * - Growing the start into the previous cue moves that cue's end (and cascades).
	 */
	trimCuePushNeighbors(
		id: string,
		edge: 'start' | 'end',
		startMs: number,
		endMs: number,
		minDurationMs = 200
	) {
		const minDur = Math.max(50, Math.round(minDurationMs));
		const timelineEnd = Math.max(project.durationMs, endMs, 1);
		let nextStart = Math.max(0, Math.round(startMs));
		let nextEnd = Math.max(nextStart + minDur, Math.round(endMs));
		if (nextEnd > timelineEnd) {
			nextEnd = timelineEnd;
			nextStart = Math.min(nextStart, Math.max(0, nextEnd - minDur));
		}

		const sorted = [...project.cues].sort((a, b) => a.startMs - b.startMs || a.index - b.index);
		const idx = sorted.findIndex((c) => c.id === id);
		if (idx < 0) return;

		const timing = new Map<string, { startMs: number; endMs: number }>();
		for (const c of sorted) {
			timing.set(c.id, { startMs: c.startMs, endMs: c.endMs });
		}
		timing.set(id, { startMs: nextStart, endMs: nextEnd });

		if (edge === 'end') {
			let boundary = nextEnd;
			for (let j = idx + 1; j < sorted.length; j++) {
				const c = sorted[j];
				const t = timing.get(c.id)!;
				if (t.startMs >= boundary) break;
				const dur = Math.max(minDur, t.endMs - t.startMs);
				const start = boundary;
				const end = Math.min(timelineEnd, Math.max(start + minDur, start + dur));
				timing.set(c.id, { startMs: start, endMs: end });
				boundary = end;
				if (boundary >= timelineEnd) {
					// Pack any remaining followers to the end with min duration.
					for (let k = j + 1; k < sorted.length; k++) {
						const rest = sorted[k];
						const rs = Math.max(0, timelineEnd - minDur);
						timing.set(rest.id, { startMs: rs, endMs: timelineEnd });
					}
					break;
				}
			}
		} else {
			let boundary = nextStart;
			for (let j = idx - 1; j >= 0; j--) {
				const c = sorted[j];
				const t = timing.get(c.id)!;
				if (t.endMs <= boundary) break;
				const dur = Math.max(minDur, t.endMs - t.startMs);
				const end = boundary;
				const start = Math.max(0, Math.min(end - minDur, end - dur));
				timing.set(c.id, { startMs: start, endMs: end });
				boundary = start;
				if (boundary <= 0) {
					for (let k = j - 1; k >= 0; k--) {
						timing.set(sorted[k].id, { startMs: 0, endMs: minDur });
					}
					break;
				}
			}
		}

		project = touch({
			...project,
			cues: project.cues.map((cue) => {
				const t = timing.get(cue.id);
				return t ? { ...cue, startMs: t.startMs, endMs: t.endMs } : cue;
			})
		});
	},

	moveCueTiming(id: string, startMs: number) {
		const cue = project.cues.find((c) => c.id === id);
		if (!cue) return;
		const duration = Math.max(0, cue.endMs - cue.startMs);
		const nextStart = Math.max(0, Math.min(project.durationMs - duration, Math.round(startMs)));
		project = touch({
			...project,
			cues: project.cues.map((c) =>
				c.id === id ? { ...c, startMs: nextStart, endMs: nextStart + duration } : c
			)
		});
	},

	/**
	 * Translator timing: set selected cue's start to the playhead.
	 * Keeps a minimum duration by pushing the end if needed.
	 */
	setCueStartAtPlayhead(id?: string): boolean {
		const cueId = id ?? selectedCueIds[0];
		if (!cueId) return false;
		const cue = project.cues.find((c) => c.id === cueId);
		if (!cue) return false;
		const minDur = 200;
		const ph = Math.max(0, Math.min(project.durationMs, Math.round(playback.playheadMs)));
		let startMs = ph;
		let endMs = cue.endMs;
		if (startMs > endMs - minDur) {
			endMs = Math.min(project.durationMs, startMs + minDur);
			if (endMs - startMs < minDur) startMs = Math.max(0, endMs - minDur);
		}
		project = touch({
			...project,
			cues: project.cues.map((c) => (c.id === cueId ? { ...c, startMs, endMs } : c))
		});
		return true;
	},

	/** Translator timing: set selected cue's end to the playhead. */
	setCueEndAtPlayhead(id?: string): boolean {
		const cueId = id ?? selectedCueIds[0];
		if (!cueId) return false;
		const cue = project.cues.find((c) => c.id === cueId);
		if (!cue) return false;
		const minDur = 200;
		const ph = Math.max(0, Math.min(project.durationMs, Math.round(playback.playheadMs)));
		let endMs = ph;
		let startMs = cue.startMs;
		if (endMs < startMs + minDur) {
			startMs = Math.max(0, endMs - minDur);
			if (endMs - startMs < minDur) endMs = Math.min(project.durationMs, startMs + minDur);
		}
		project = touch({
			...project,
			cues: project.cues.map((c) => (c.id === cueId ? { ...c, startMs, endMs } : c))
		});
		return true;
	},

	/**
	 * Split a cue at the playhead into two segments.
	 * Left keeps original text; right duplicates text (editable). Returns new cue id.
	 */
	splitCueAtPlayhead(id?: string): string | null {
		const cueId = id ?? selectedCueIds[0];
		if (!cueId) return null;
		const cue = project.cues.find((c) => c.id === cueId);
		if (!cue) return null;
		const minDur = 200;
		const ph = Math.round(playback.playheadMs);
		if (ph < cue.startMs + minDur || ph > cue.endMs - minDur) return null;

		const idx = project.cues.findIndex((c) => c.id === cueId);
		if (idx < 0) return null;

		const right = createSubtitleCue(
			cue.index + 1,
			{
				startMs: ph,
				endMs: cue.endMs,
				source: cue.source,
				translation: cue.translation,
				speaker: cue.speaker,
				pitch: cue.pitch,
				speed: cue.speed,
				volume: cue.volume,
				voiceId: cue.voiceId,
				status: 'draft'
			},
			{ voiceId, speaker: cue.speaker }
		);

		const cues = [...project.cues];
		cues[idx] = { ...cue, endMs: ph };
		cues.splice(idx + 1, 0, right);
		project = touch({
			...project,
			cues: cues.map((c, i) => ({ ...c, index: i + 1 }))
		});
		selectedCueIds = [cue.id, right.id];
		selectionAnchorId = right.id;
		return right.id;
	},

	/**
	 * Merge 2+ selected cues into one spanning earliest start → latest end.
	 * Text joined with spaces. Returns kept cue id.
	 */
	mergeSelectedCues(): string | null {
		if (selectedCueIds.length < 2) return null;
		const selected = project.cues
			.filter((c) => selectedCueIds.includes(c.id))
			.sort((a, b) => a.startMs - b.startMs || a.index - b.index);
		if (selected.length < 2) return null;

		const keep = selected[0];
		const startMs = Math.min(...selected.map((c) => c.startMs));
		const endMs = Math.max(...selected.map((c) => c.endMs));
		const translation = selected
			.map((c) => c.translation.trim())
			.filter(Boolean)
			.join(' ');
		const source = selected
			.map((c) => c.source.trim())
			.filter(Boolean)
			.join(' ');
		const remove = new Set(selected.slice(1).map((c) => c.id));

		project = touch({
			...project,
			cues: project.cues
				.filter((c) => !remove.has(c.id))
				.map((c) =>
					c.id === keep.id
						? {
								...c,
								startMs,
								endMs: Math.max(startMs + 200, endMs),
								translation: translation || c.translation,
								source: source || c.source,
								status: c.status === 'generated' ? ('ready' as const) : c.status
							}
						: c
				)
				.map((c, i) => ({ ...c, index: i + 1 }))
		});
		selectedCueIds = [keep.id];
		selectionAnchorId = keep.id;
		return keep.id;
	},

	/** Move selected cue so its start snaps to the playhead (duration preserved). */
	snapCueToPlayhead(id?: string): boolean {
		const cueId = id ?? selectedCueIds[0];
		if (!cueId) return false;
		if (!project.cues.some((c) => c.id === cueId)) return false;
		this.moveCueTiming(cueId, playback.playheadMs);
		return true;
	},

	reorderCues(fromId: string, toId: string, edge: 'before' | 'after' = 'before') {
		if (fromId === toId) return;
		const cues = [...project.cues];
		const fromIndex = cues.findIndex((c) => c.id === fromId);
		const toIndex = cues.findIndex((c) => c.id === toId);
		if (fromIndex < 0 || toIndex < 0) return;

		const [moved] = cues.splice(fromIndex, 1);
		let insertAt = cues.findIndex((c) => c.id === toId);
		if (insertAt < 0) return;
		if (edge === 'after') insertAt += 1;
		cues.splice(insertAt, 0, moved);

		project = touch({
			...project,
			cues: cues.map((cue, i) => ({ ...cue, index: i + 1 }))
		});
	},

	assignAudioToCue(targetCueId: string, sourceCueId: string) {
		const source = project.cues.find((c) => c.id === sourceCueId);
		if (!source) return;
		project = touch({
			...project,
			cues: project.cues.map((cue) => {
				if (cue.id !== targetCueId) return cue;
				return {
					...cue,
					voiceId: source.voiceId,
					pitch: source.pitch,
					speed: source.speed,
					volume: source.volume,
					status: cue.status === 'draft' ? ('ready' as const) : cue.status,
					assignedAudio: {
						sourceCueId: source.id,
						label: `TTS #${source.index}`
					}
				};
			})
		});
	},

	/**
	 * Load a local video file into the preview (object URL or convertFileSrc).
	 * Also extracts original audio waveform for the timeline track.
	 * Pass `filesystemPath` when opened via the native dialog so FFmpeg can read it directly.
	 * By default the project title follows the video file name.
	 */
	setVideoFromFile(
		file: File,
		filesystemPath?: string | null,
		options?: { syncTitle?: boolean }
	): boolean {
		if (classifyMediaFile(file) !== 'video') return false;

		revokeVideoUrl();
		resetOriginalAudio();
		videoFile = file;
		videoPath = filesystemPath?.trim() || null;
		videoUrl = URL.createObjectURL(file);

		const asset = createMediaAsset(file, 'video', project.durationMs);
		if (videoPath) asset.path = videoPath;
		const otherAssets = project.assets.filter((a) => a.id !== project.videoAssetId);
		const syncTitle = options?.syncTitle !== false;
		project = touch({
			...project,
			name: syncTitle ? titleFromMediaFileName(file.name) : project.name,
			videoAssetId: asset.id,
			assets: [asset, ...otherAssets]
		});
		playback.isPlaying = false;
		playback.focusedCueId = null;
		playback.playheadMs = 0;
		void extractOriginalAudioFromFile(file);
		return true;
	},

	/** Load video from an absolute path (Tauri native open dialog). */
	async setVideoFromPath(
		path: string,
		options?: { syncTitle?: boolean }
	): Promise<boolean> {
		const name = path.split(/[/\\]/).pop() || 'video.mp4';
		try {
			const { convertFileSrc } = await import('@tauri-apps/api/core');
			const src = convertFileSrc(path);

			revokeVideoUrl();
			resetOriginalAudio();
			videoPath = path;
			videoFile = null;
			videoUrl = src;

			const asset = createMediaAsset({ name }, 'video', project.durationMs);
			asset.path = path;
			const otherAssets = project.assets.filter((a) => a.id !== project.videoAssetId);
			const syncTitle = options?.syncTitle !== false;
			project = touch({
				...project,
				name: syncTitle ? titleFromMediaFileName(name) : project.name,
				videoAssetId: asset.id,
				assets: [asset, ...otherAssets]
			});
			playback.isPlaying = false;
			playback.focusedCueId = null;
			playback.playheadMs = 0;
			// Same Original Audio waveform path as File import.
			void extractOriginalAudioFromSrc(src, name);
			return true;
		} catch {
			return false;
		}
	},

	clearVideo() {
		revokeVideoUrl();
		resetOriginalAudio();
		const videoId = project.videoAssetId;
		project = touch({
			...project,
			videoAssetId: null,
			assets: videoId ? project.assets.filter((a) => a.id !== videoId) : project.assets
		});
		playback.isPlaying = false;
		playback.focusedCueId = null;
		playback.playheadMs = 0;
	},

	/** Called when `<video>` reports real duration. */
	setDurationMs(ms: number) {
		const durationMs = Math.max(1000, Math.round(ms));
		const videoId = project.videoAssetId;
		project = touch(
			{
				...project,
				durationMs,
				assets: project.assets.map((a) =>
					a.id === videoId ? { ...a, durationMs } : a
				)
			},
			{ recordHistory: false }
		);
		if (playback.playheadMs > durationMs) playback.playheadMs = durationMs;
	},

	importMediaFiles(files: File[]): number {
		let videoFile: File | null = null;
		const added: ReturnType<typeof createMediaAsset>[] = [];

		for (const file of files) {
			const kind = classifyMediaFile(file);
			if (!kind) continue;
			if (kind === 'video' && !videoFile) videoFile = file;
			added.push(createMediaAsset(file, kind, kind === 'subtitle' ? 0 : project.durationMs));
		}

		if (!added.length) return 0;

		if (videoFile) {
			this.setVideoFromFile(videoFile);
			const extras = added.filter((a) => a.kind !== 'video');
			if (extras.length) {
				project = touch({
					...project,
					assets: [...extras, ...project.assets]
				});
			}
			return added.length;
		}

		project = touch({
			...project,
			assets: [...added, ...project.assets]
		});
		return added.length;
	},

	/**
	 * Seek to a cue and start transport (video + TTS mixer).
	 * Prefer this for subtitle-row / TTS-clip Play so generated audio is heard in sync.
	 */
	playCue(id: string) {
		const cue = project.cues.find((item) => item.id === id);
		if (!cue) return;
		selectedCueIds = [id];
		selectionAnchorId = id;
		const start = Math.max(0, cue.startMs);
		setVisualPlayheadMs(start, { seekMedia: true });
		playback.playheadMs = start;
		playback.focusedCueId = id;
		playback.isPlaying = true;
	},

	/** Play/pause toggle for one cue (row Play button or TTS block). */
	toggleCuePlayback(id: string) {
		const cue = project.cues.find((item) => item.id === id);
		if (!cue) return;

		const end = cueAudioEndMs(cue);
		const inCue = playback.playheadMs >= cue.startMs && playback.playheadMs < end;
		const isThisPlaying =
			playback.isPlaying && (playback.focusedCueId === id || inCue);

		if (isThisPlaying) {
			this.pausePlayback();
			return;
		}

		this.playCue(id);
	},

	/** True when transport is playing this cue (for Play/Pause UI). */
	isCuePlaying(id: string): boolean {
		if (!playback.isPlaying) return false;
		if (playback.focusedCueId === id) return true;
		const cue = project.cues.find((item) => item.id === id);
		if (!cue) return false;
		const end = cueAudioEndMs(cue);
		return playback.playheadMs >= cue.startMs && playback.playheadMs < end;
	},

	/**
	 * When a cue-focused play runs past the (audio-aware) cue end, stop transport.
	 * Called from the video clock so TTS preview doesn't keep rolling the whole timeline.
	 */
	finishFocusedCueIfPast(playheadMs: number) {
		const id = playback.focusedCueId;
		if (!id || !playback.isPlaying) return;
		const cue = project.cues.find((item) => item.id === id);
		if (!cue) {
			playback.focusedCueId = null;
			return;
		}
		const end = cueAudioEndMs(cue);
		if (playheadMs >= end - 16) {
			playback.isPlaying = false;
			playback.focusedCueId = null;
			const stopAt = Math.max(0, end);
			setVisualPlayheadMs(stopAt, { seekMedia: true });
			playback.playheadMs = stopAt;
		}
	},

	renameProject(name: string) {
		const next = name.trim();
		if (!next || next === project.name) return;
		project = touch({ ...project, name: next });
	},

	toggleLeft() {
		leftCollapsed = !leftCollapsed;
	},
	toggleRight() {
		rightCollapsed = !rightCollapsed;
	},
	setLeftCollapsed(value: boolean) {
		leftCollapsed = value;
	},
	setRightCollapsed(value: boolean) {
		rightCollapsed = value;
	},
	setVideoTool(tool: string) {
		activeVideoTool = tool;
	},
	setDubTool(tool: string) {
		activeDubTool = tool;
	},
	setVoiceId(id: string) {
		const next = voicesStore.ensureVoicePresent(id);
		voiceId = next;
		// Remember last selected voice across sessions.
		preferencesStore.setDefaultVoiceId(next);
	},
	/** Update target dub language on the open project + dub track label. */
	setTargetLanguage(code: string) {
		const next = normalizeDubLanguage(code);
		if (next === project.targetLanguage) return;
		const label = languageLabel(next);
		project = touch({
			...project,
			targetLanguage: next,
			tracks: project.tracks.map((t) =>
				t.role === 'dub'
					? { ...t, language: next, name: `Dub · ${label}` }
					: t
			)
		});
	},
	setPitch(value: number) {
		pitch = value;
	},
	setSpeed(value: number) {
		speed = value;
	},
	setVolume(value: number) {
		volume = value;
	},
	async generateSelected() {
		const n = await this.generateCues(selectedCueIds);
		return n;
	}
};
