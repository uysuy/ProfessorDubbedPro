import type { DubbingProject, SpeakerVoiceProfile, SubtitleCue, SubtitleStyle, TitleLiverClip, TitleLiverTemplateId, VoiceProfile } from '$lib/types/project';
import { DEFAULT_SUBTITLE_STYLE } from '$lib/types/project';
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
	voiceIdForSpeakerGender,
	type NewCueInput
} from '$lib/utils/project-io';
import {
	clearSpeakerLockInVault,
	loadSpeakerVault,
	mergeBankWithVault,
	persistSpeakerBankToVault,
	renameSpeakerInVault,
	speakerBankFromVault
} from '$lib/utils/speaker-vault';
import { upsertSavedVoice, loadSavedVoices, deleteSavedVoice, getSavedVoice } from '$lib/utils/voice-library';
import type { SavedVoice } from '$lib/utils/voice-library';
import { createTitleLiverClip, TITLE_LIVER_PRESETS } from '$lib/utils/title-liver';
import {
	buildRecoveryDocument,
	saveRecoveryToLocalStorage
} from '$lib/utils/project-file';
import { preferencesStore, languageLabel, normalizeDubLanguage } from '$lib/stores/preferences.svelte';
import { voicesStore } from '$lib/stores/voices.svelte';
import { setVisualPlayheadMs } from '$lib/stores/playback-clock';
import { getTtsEngine, getTtsEngineId } from '$lib/tts';
import { TtsError } from '$lib/tts/types';
import type { TtsEngineId } from '$lib/tts/types';
import { migrateVoiceId } from '$lib/tts/edge-voices';
import { resolveEdgeVoice } from '$lib/tts/edge-tts';
import { textContainsKhmer } from '$lib/tts/edge-tts-script';
import {
	mapVoiceIdToEngine,
	voiceIdForEngineGender,
	voiceMatchesEngine
} from '$lib/tts/voice-engine';
import { matchVoxcpmVoiceToGender, resolveVoxcpmVoiceId } from '$lib/tts/voxcpm-voices';
import { peaksForClip } from '$lib/utils/timeline';
import { isTauriRuntime } from '$lib/utils/platform';
import { cueAudioEndMs, cuePreviewEndMs } from '$lib/utils/tts-fit';
import { sliceAudioFile } from '$lib/utils/audio-slice';
import { planTightenedCueGaps, estimateEdgeMp3DurationMs, ALIGN_BREATH_MS, ALIGN_HANG_PAD_MS, type TightenGapsOptions } from '$lib/utils/cue-gaps';
import {
	scaleCueTimesForTempo,
	ALIGN_MAX_TTS_RATE,
	ALIGN_FORCE_FIT_MAX_TTS_RATE,
	ALIGN_FALLBACK_TTS_RATE
} from '$lib/utils/video-tempo';
import {
	planPictureLockPatches,
	withPictureAnchors,
	pictureAnchorStart,
	pictureAnchorEnd
} from '$lib/utils/cue-picture-lock';
import type { SmartAlignPatch } from '$lib/utils/cue-smart-align';
import { parseSrt } from '$lib/utils/srt';
import { packLinesIntoCueSlots, splitKhmerSentences, estimateKhmerSpeechMs, planCuesFromScriptLines } from '$lib/utils/script-paste';

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
/**
 * Original user media (never overwritten by pitch-safe remasters).
 * Manual Apply tempo is absolute vs this source; 1.00× restores it.
 */
let sourceVideoPath = $state<string | null>(null);
let sourceVideoFile = $state<File | null>(null);
/** Picture length of the original source (ms), when known. */
let sourceDurationMs = $state(0);

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
/** Selected Title Liver clip (timeline + panel stay in sync). */
let selectedTitleLiverId = $state<string | null>(null);
let leftCollapsed = $state(false);
let rightCollapsed = $state(false);
let activeVideoTool = $state('tempo');
let activeDubTool = $state('translate');
let voiceId = $state(migrateVoiceId(preferencesStore.defaultVoiceId));
let pitch = $state(0);
let speed = $state(1);
let volume = $state(80);
/** Original Audio track fader (0–1). Applied to preview `<video>` volume. */
let originalAudioGain = $state(1);
let originalAudioMuted = $state(false);
let isGenerating = $state(false);
/** 0–100 while TTS generate is running. */
let generateProgress = $state(0);
/** Last generate error message (cleared on next successful start). */
let generateError = $state<string | null>(null);
let speakersDetecting = $state(false);
let speakersError = $state<string | null>(null);
let speakersLockingId = $state<string | null>(null);
/** Bump so UI re-reads the saved-voices library after Lock / delete. */
let savedVoicesTick = $state(0);
/** Runtime waveform peaks for TTS clips (not persisted). */
let ttsWaveforms = $state<Record<string, number[]>>({});
/** VideoPreview registers the mixer invalidate hook here. */
let ttsInvalidateHandler: ((cueId: string | null) => void) | null = null;
let lastSavedAt = $state<string | null>(null);
let previewHeightPx = $state(360);
let didHydrate = false;

const PREVIEW_HEIGHT_KEY = 'pdp.previewHeight';
const PREVIEW_HEIGHT_MIN = 220;
const PREVIEW_HEIGHT_MAX = 720;

/** Current speakable text for a cue (what TTS would synthesize). */
function cueSpeakText(cue: { translation?: string; source?: string }): string {
	return (cue.translation?.trim() || cue.source?.trim() || '').trim();
}

/** True when assigned clip was built for this cue’s current text. */
function cueTtsMatchesText(cue: {
	translation?: string;
	source?: string;
	assignedAudio?: { sourceText?: string; filePath?: string | null; url?: string | null } | null;
}): boolean {
	const audio = cue.assignedAudio;
	if (!audio) return false;
	if (!(audio.filePath || audio.url)) return false;
	const text = cueSpeakText(cue);
	if (!text) return false;
	// Legacy clips without sourceText stay trusted until the user edits text.
	if (typeof audio.sourceText !== 'string') return true;
	return audio.sourceText === text;
}

function notifyTtsInvalidate(cueId: string | null) {
	try {
		ttsInvalidateHandler?.(cueId);
	} catch {
		/* mixer optional */
	}
}

function dropTtsWaveforms(ids: Iterable<string>) {
	const next = { ...ttsWaveforms };
	let changed = false;
	for (const id of ids) {
		if (id in next) {
			delete next[id];
			changed = true;
		}
		notifyTtsInvalidate(id);
	}
	if (changed) ttsWaveforms = next;
}

/** Drop clips whose sourceText no longer matches the cue (after load / paste). */
function scrubMismatchedTts(cues: SubtitleCue[]): {
	cues: SubtitleCue[];
	clearedIds: string[];
} {
	const clearedIds: string[] = [];
	const next = cues.map((cue) => {
		const audio = cue.assignedAudio;
		if (!audio) return cue;
		if (typeof audio.sourceText !== 'string') return cue;
		if (audio.sourceText === cueSpeakText(cue)) return cue;
		clearedIds.push(cue.id);
		return {
			...cue,
			assignedAudio: null,
			status:
				cue.status === 'generated' || cue.status === 'error'
					? ('ready' as const)
					: cue.status
		};
	});
	return { cues: next, clearedIds };
}

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
		// Always stamp true picture length onto the video asset (Fit math depends on it).
		// Timeline duration may still grow with Khmer TTS past the picture.
		if (result.durationMs > 1000) {
			const videoId = project.videoAssetId;
			let contentFloor = 0;
			for (const cue of project.cues) {
				contentFloor = Math.max(contentFloor, cueAudioEndMs(cue), cue.endMs);
			}
			const mediaMs = Math.round(result.durationMs);
			const durationMs = Math.max(mediaMs, contentFloor + 200);
			const assetNeedsUpdate =
				!videoId ||
				(project.assets.find((a) => a.id === videoId)?.durationMs ?? 0) !== mediaMs;
			const timelineNeedsUpdate = Math.abs(durationMs - project.durationMs) > 500;
			if (assetNeedsUpdate || timelineNeedsUpdate) {
				project = touch(
					{
						...project,
						durationMs: timelineNeedsUpdate ? durationMs : project.durationMs,
						assets: project.assets.map((a) =>
							a.id === videoId ? { ...a, durationMs: mediaMs } : a
						)
					},
					{ recordHistory: false }
				);
			}
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
		if (result.durationMs > 1000) {
			const videoId = project.videoAssetId;
			let contentFloor = 0;
			for (const cue of project.cues) {
				contentFloor = Math.max(contentFloor, cueAudioEndMs(cue), cue.endMs);
			}
			const mediaMs = Math.round(result.durationMs);
			const durationMs = Math.max(mediaMs, contentFloor + 200);
			const assetNeedsUpdate =
				!videoId ||
				(project.assets.find((a) => a.id === videoId)?.durationMs ?? 0) !== mediaMs;
			const timelineNeedsUpdate = Math.abs(durationMs - project.durationMs) > 500;
			if (assetNeedsUpdate || timelineNeedsUpdate) {
				project = touch(
					{
						...project,
						durationMs: timelineNeedsUpdate ? durationMs : project.durationMs,
						assets: project.assets.map((a) =>
							a.id === videoId ? { ...a, durationMs: mediaMs } : a
						)
					},
					{ recordHistory: false }
				);
			}
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
	selectedTitleLiverId = null;
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
	get sourceVideoPath() {
		return sourceVideoPath;
	},
	get sourceVideoFile() {
		return sourceVideoFile;
	},
	get sourceDurationMs() {
		return sourceDurationMs;
	},
	/**
	 * If the user opened media before source tracking existed, treat the current
	 * file as the original while still at 1.00×.
	 */
	captureSourceFromCurrentIfNeeded() {
		if (sourceVideoPath || sourceVideoFile) return;
		const tempo = Number.isFinite(project.mediaTempoFromSource)
			? project.mediaTempoFromSource!
			: 1;
		if (Math.abs(tempo - 1) >= 0.001) return;
		if (videoPath) sourceVideoPath = videoPath;
		else if (videoFile) sourceVideoFile = videoFile;
		if (sourceDurationMs < 1000) {
			const asset = project.videoAssetId
				? project.assets.find((a) => a.id === project.videoAssetId)
				: null;
			const mediaMs = asset?.durationMs || project.durationMs;
			if (mediaMs > 1000) sourceDurationMs = Math.round(mediaMs);
		}
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
	get selectedTitleLiverId() {
		return selectedTitleLiverId;
	},
	get titleLiverClips(): TitleLiverClip[] {
		return project.titleLiverClips ?? [];
	},
	get selectedTitleLiver(): TitleLiverClip | null {
		const id = selectedTitleLiverId;
		if (!id) return null;
		return (project.titleLiverClips ?? []).find((c) => c.id === id) ?? null;
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
	get originalAudioGain() {
		return originalAudioGain;
	},
	get originalAudioMuted() {
		return originalAudioMuted;
	},
	/** Effective source gain for preview (0 when muted). */
	get originalAudioEffectiveGain() {
		return originalAudioMuted ? 0 : originalAudioGain;
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
	get speakersDetecting() {
		return speakersDetecting;
	},
	get speakersError() {
		return speakersError;
	},
	get speakersLockingId() {
		return speakersLockingId;
	},
	get speakerBank() {
		return project.speakerBank ?? [];
	},
	/** Loved voices saved to the app library (pick anytime). */
	get savedVoices(): SavedVoice[] {
		void savedVoicesTick;
		return loadSavedVoices();
	},
	/**
	 * Names available in the subtitle Speaker column: current bank + vault +
	 * saved-voice templates (Hong_Kong_TVB_*, etc.).
	 */
	get speakerTemplateOptions(): string[] {
		void savedVoicesTick;
		const ids = new Set<string>();
		for (const s of project.speakerBank ?? []) {
			const id = s.id.trim();
			if (id) ids.add(id);
		}
		for (const e of loadSpeakerVault()) {
			if (e.id.trim()) ids.add(e.id.trim());
		}
		for (const v of loadSavedVoices()) {
			const name = v.name.trim();
			if (name) ids.add(name);
		}
		for (const c of project.cues) {
			const sp = (c.speaker || '').trim();
			if (sp) ids.add(sp);
		}
		if (ids.size === 0) ids.add('Speaker 1');
		return [...ids].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
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
		const scrubbed = scrubMismatchedTts(loaded.cues);
		let next = scrubbed.clearedIds.length
			? { ...loaded, cues: scrubbed.cues }
			: loaded;
		const bank = next.speakerBank?.length
			? mergeBankWithVault(next.speakerBank)
			: speakerBankFromVault();
		next = { ...next, speakerBank: bank };
		project = next;
		if (scrubbed.clearedIds.length) dropTtsWaveforms(scrubbed.clearedIds);
		persistSpeakerBankToVault(bank);
		projectFilePath = null;
		clearHistory();
		resetPlayback();
		markClean(loaded.updatedAt);
	},

	/** Create a fresh empty project (clears video + cues). Keeps locked speakers from vault. */
	createProject(name?: string) {
		revokeVideoUrl();
		resetOriginalAudio();
		sourceVideoPath = null;
		sourceVideoFile = null;
		sourceDurationMs = 0;
		const vaultBank = speakerBankFromVault();
		project = {
			...createEmptyProject(name, {
				sourceLanguage: 'en',
				targetLanguage: preferencesStore.defaultLanguage
			}),
			speakerBank: vaultBank
		};
		projectFilePath = null;
		voiceId = migrateVoiceId(preferencesStore.defaultVoiceId);
		originalAudioGain = 1;
		originalAudioMuted = false;
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
			volume,
			originalAudioGain,
			originalAudioMuted
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
			originalAudioGain?: number;
			originalAudioMuted?: boolean;
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
			if (typeof doc.session.originalAudioGain === 'number') {
				originalAudioGain = Math.max(0, Math.min(1, doc.session.originalAudioGain));
			}
			if (typeof doc.session.originalAudioMuted === 'boolean') {
				originalAudioMuted = doc.session.originalAudioMuted;
			}
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
		const scrubbedOpen = scrubMismatchedTts(document.project.cues);
		project = scrubbedOpen.clearedIds.length
			? { ...document.project, cues: scrubbedOpen.cues }
			: document.project;
		if (scrubbedOpen.clearedIds.length) dropTtsWaveforms(scrubbedOpen.clearedIds);
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
			if (typeof document.session.originalAudioGain === 'number') {
				originalAudioGain = Math.max(0, Math.min(1, document.session.originalAudioGain));
			}
			if (typeof document.session.originalAudioMuted === 'boolean') {
				originalAudioMuted = document.session.originalAudioMuted;
			}
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
		const scrubbed = scrubMismatchedTts(loaded.cues);
		let next = scrubbed.clearedIds.length
			? { ...loaded, cues: scrubbed.cues }
			: loaded;
		const bank = next.speakerBank?.length
			? mergeBankWithVault(next.speakerBank)
			: speakerBankFromVault();
		next = { ...next, speakerBank: bank };
		project = next;
		if (scrubbed.clearedIds.length) dropTtsWaveforms(scrubbed.clearedIds);
		persistSpeakerBankToVault(bank);
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
			void import('$lib/tts/voice-preview')
				.then((m) => m.stopVoicePreview())
				.catch(() => undefined);
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
			// Range by timeline order (startMs), not raw array index — matches Shift+click in NLEs.
			const sorted = [...project.cues].sort(
				(a, b) => a.startMs - b.startMs || a.index - b.index
			);
			const ids = sorted.map((c) => c.id);
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
						pictureStartMs: startMs,
						pictureEndMs: endMs,
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
			mediaTempoFromSource: 1,
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

	/**
	 * Replace cues from a raw SRT document.
	 * Khmer text → `translation` (ready for Generate). Other languages → `source`
	 * (same as Extract), leaving translation empty for Paste/Translate.
	 */
	importSrtText(
		raw: string,
		opts?: { replace?: boolean; fileName?: string }
	): { count: number; khmer: boolean } {
		const parsed = parseSrt(raw);
		if (!parsed.length) return { count: 0, khmer: false };

		const khmer = parsed.some((c) => textContainsKhmer(c.text));
		const replace = opts?.replace !== false;

		const mapped = parsed.map((seg) => {
			const startMs = seg.startMs;
			const endMs = seg.endMs;
			const text = seg.text.trim();
			return createSubtitleCue(
				0,
				{
					startMs,
					endMs,
					pictureStartMs: startMs,
					pictureEndMs: endMs,
					source: khmer ? '' : text,
					translation: khmer ? text : '',
					status: 'ready',
					speaker: 'Speaker 1',
					voiceId
				},
				{ voiceId, speaker: 'Speaker 1' }
			);
		});

		const cues = mapped
			.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
			.map((c, i) => ({ ...c, index: i + 1 }));

		const maxEnd = cues.reduce((m, c) => Math.max(m, c.endMs), 0);
		const asset =
			opts?.fileName != null
				? createMediaAsset({ name: opts.fileName }, 'subtitle', maxEnd)
				: null;

		const nextCues = replace
			? cues
			: [...project.cues, ...cues].map((c, i) => ({ ...c, index: i + 1 }));

		project = touch({
			...project,
			targetLanguage: khmer ? 'km' : project.targetLanguage,
			cues: nextCues,
			mediaTempoFromSource: 1,
			durationMs: Math.max(project.durationMs, maxEnd + 500),
			assets: asset ? [asset, ...project.assets.filter((a) => a.kind !== 'subtitle' || a.name !== opts?.fileName)] : project.assets,
			tracks: project.tracks.map((t) =>
				t.role === 'dub' && khmer ? { ...t, language: 'km' } : t
			)
		});
		ttsWaveforms = {};
		selectedCueIds = nextCues[0] ? [nextCues[0].id] : [];
		selectionAnchorId = nextCues[0]?.id ?? null;
		playback.playheadMs = nextCues[0]?.startMs ?? 0;
		// Keep SRT times exactly as authored (video-matched). Do not auto-inject
		// 1.5–2s gaps — that accumulates and makes the dub lag the picture.
		return { count: cues.length, khmer };
	},

	/** Read a File and import as SRT cues (UTF-8 / UTF-16). */
	async importSrtFile(
		file: File,
		opts?: { replace?: boolean }
	): Promise<{ count: number; khmer: boolean }> {
		const buf = await file.arrayBuffer();
		const bytes = new Uint8Array(buf);
		let raw = '';
		if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
			raw = new TextDecoder('utf-16le').decode(bytes);
		} else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
			raw = new TextDecoder('utf-16be').decode(bytes);
		} else {
			raw = new TextDecoder('utf-8').decode(bytes);
		}
		return this.importSrtText(raw, { replace: opts?.replace, fileName: file.name });
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
				status: 'ready' as const,
				assignedAudio: null
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

				// Drop stale peaks so the timeline never shows the previous line’s waveform.
				dropTtsWaveforms([cueId]);

				try {
					const engineId = engine.id;
					const bank = (project.speakerBank ?? []).find(
						(s) => s.id === (cue.speaker || '').trim()
					);
					let usedVoiceId = migrateVoiceId(cue.voiceId || voiceId);
					if (engineId === 'voxcpm') {
						const preferred = bank?.voiceId || cue.voiceId || voiceId;
						usedVoiceId = resolveVoxcpmVoiceId(preferred, voiceId);
						if (bank && (bank.gender === 'male' || bank.gender === 'female')) {
							usedVoiceId = matchVoxcpmVoiceToGender(usedVoiceId, bank.gender);
						}
					}

					const resolvedVoice =
						engineId === 'voxcpm'
							? usedVoiceId
							: resolveEdgeVoice(usedVoiceId, targetLang, text);

					// Khmer voice + Chinese/empty translation → blank audio. Fail clearly.
					const needsKhmer =
						engineId === 'voxcpm' ||
						resolvedVoice.toLowerCase().startsWith('km') ||
						resolvedVoice.toLowerCase().includes('-km-');
					if (needsKhmer && !textContainsKhmer(text)) {
						failures.push(
							`#${cue.index}: no Khmer text (paste script or Translate first)`
						);
						generateProgress = Math.round(((i + 1) / unique.length) * 100);
						continue;
					}

					// Session Prosody for a balanced voice across all cues.
					// Do NOT bake lip-sync speed-ups into cue.speed (that made pitch/tempo uneven).
					const baseSpeed = speed;
					const basePitch = pitch;
					const baseVolume = volume;
					const referenceWavPath =
						engineId === 'voxcpm' && bank?.locked && bank.refWavPath
							? bank.refWavPath
							: undefined;

					// Single pass at the user's Prosody — consistent pitch & rate.
					const result = await engine.synthesize({
						cueId: cue.id,
						text,
						voiceId: usedVoiceId,
						pitch: basePitch,
						speed: baseSpeed,
						volume: baseVolume,
						language: targetLang,
						referenceWavPath
					});

					const asset = await resolveAsset(result.filePath, cue.id);
					if (
						(!asset.durationMs || asset.durationMs < 80) &&
						result.byteLength < 1500
					) {
						throw new TtsError(
							`#${cue.index}: blank/near-silent audio — check Khmer text & voice`,
							'empty'
						);
					}

					// Prefer measured duration (Rust / waveform / byte estimate).
					// NEVER fall back to the Chinese ASR window — that made short lines
					// (e.g. Hahaha) draw a long TTS clip that visually ate into the next cue.
					const naturalMs = Math.max(
						200,
						asset.durationMs && asset.durationMs > 80
							? Math.round(asset.durationMs)
							: typeof result.durationMs === 'number' && result.durationMs > 80
								? Math.round(result.durationMs)
								: estimateEdgeMp3DurationMs(result.byteLength) || 2_000
					);

					// Guard: another cue must never receive this same file.
					const pathTaken = project.cues.some(
						(c) =>
							c.id !== cue.id &&
							c.assignedAudio?.filePath &&
							c.assignedAudio.filePath === result.filePath
					);
					if (pathTaken) {
						throw new TtsError(
							`#${cue.index}: TTS file collision — regenerate this cue`,
							'failed'
						);
					}

					const shortVoice =
						result.providerVoice.split('-').slice(-1)[0] ?? result.providerVoice;
					const label = `${engine.label} · ${voicesStore.find(usedVoiceId)?.name ?? shortVoice}`;
					// Keep cue timing + picture anchors frozen. Spoken length lives on
					// assignedAudio (TTS track draws via cuePreviewEndMs). Expanding
					// endMs/pictureEndMs and pushing neighbors broke Title Liver /
					// subtitle alignment whenever Khmer speech was longer than the window.
					project = touch({
						...project,
						cues: project.cues.map((c) => {
							if (c.id !== cue.id) return c;
							return {
								...c,
								status: 'generated' as const,
								voiceId: usedVoiceId,
								pitch: basePitch,
								speed: baseSpeed,
								volume: baseVolume,
								assignedAudio: {
									sourceCueId: c.id,
									label,
									generated: true,
									filePath: result.filePath,
									url: asset.url,
									durationMs: naturalMs,
									engine: result.engine,
									fitPlaybackRate: 1,
									sourceText: text
								}
							};
						})
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

			// After Generate: timing stays on picture; TTS may overhang until Align.
			if (completed > 0) {
				this.syncTimelineDuration();
			}

			return completed;
		} finally {
			isGenerating = false;
			if (generateProgress < 100 && completed > 0) generateProgress = 100;
			await new Promise((r) => setTimeout(r, 180));
			generateProgress = 0;
		}
	},

	/**
	 * Pull long silences between cues down to a short breath gap, and shrink
	 * subtitle windows to TTS length so preview/export don’t linger on empty air.
	 */
	tightenCueGaps(opts?: TightenGapsOptions): { pulledMs: number; changed: number } {
		const { patches, pulledMs } = planTightenedCueGaps(project.cues, opts);
		if (!patches.length) return { pulledMs: 0, changed: 0 };

		const byId = new Map(patches.map((p) => [p.id, p]));
		let changed = 0;
		const nextCues = project.cues.map((cue) => {
			const p = byId.get(cue.id);
			if (!p) return cue;
			if (p.startMs === cue.startMs && p.endMs === cue.endMs) return cue;
			changed += 1;
			return { ...cue, startMs: p.startMs, endMs: p.endMs };
		});
		if (!changed) return { pulledMs: 0, changed: 0 };

		project = touch({
			...project,
			cues: nextCues
		});
		this.syncTimelineDuration();
		return { pulledMs, changed };
	},

	/**
	 * Stamp ASR/hardsub windows when missing — does NOT move cue start/end.
	 */
	stampPictureAnchorsOnly(): { changed: number } {
		const next = withPictureAnchors(project.cues);
		let changed = 0;
		for (let i = 0; i < next.length; i++) {
			const a = project.cues[i];
			const b = next[i];
			if (!a || !b) continue;
			if (a.pictureStartMs !== b.pictureStartMs || a.pictureEndMs !== b.pictureEndMs) {
				changed += 1;
			}
		}
		if (!changed) return { changed: 0 };
		project = touch({ ...project, cues: next });
		return { changed };
	},

	/**
	 * Stamp ASR/hardsub windows when missing, then lock Khmer starts/ends to them.
	 * Short holds (Hahaha) keep the subtitle until picture end; next line waits
	 * for its hardsub start — never breath-pack the next cue early.
	 */
	applyPictureLockTiming(opts?: {
		maxRate?: number;
		mediaTempoFromSource?: number;
		mediaDurationMs?: number;
	}): { changed: number } {
		const beforeMissing = project.cues.some(
			(c) => typeof c.pictureStartMs !== 'number' || typeof c.pictureEndMs !== 'number'
		);
		const anchored = withPictureAnchors(project.cues);
		const tempo =
			opts?.mediaTempoFromSource ??
			(Number.isFinite(project.mediaTempoFromSource) ? project.mediaTempoFromSource! : 1);
		const mediaDurationMs =
			opts?.mediaDurationMs ??
			(originalAudio.durationMs > 1000
				? originalAudio.durationMs
				: project.videoAssetId
					? (project.assets.find((a) => a.id === project.videoAssetId)?.durationMs ?? 0)
					: 0);
		const patches = planPictureLockPatches(anchored, {
			maxRate: opts?.maxRate ?? ALIGN_MAX_TTS_RATE,
			mediaTempoFromSource: tempo,
			mediaDurationMs: mediaDurationMs > 500 ? mediaDurationMs : undefined
		});
		const byId = new Map(patches.map((p) => [p.id, p]));
		let changed = 0;
		const nextCues = anchored.map((cue) => {
			const p = byId.get(cue.id);
			if (!p) return cue;
			const audio = cue.assignedAudio;
			const nextRate = p.fitPlaybackRate;
			const prevRate = audio?.fitPlaybackRate ?? 1;
			if (
				p.startMs === cue.startMs &&
				p.endMs === cue.endMs &&
				Math.abs(prevRate - nextRate) < 0.001 &&
				!beforeMissing
			) {
				return cue;
			}
			changed += 1;
			return {
				...cue,
				startMs: p.startMs,
				endMs: p.endMs,
				pictureStartMs: cue.pictureStartMs ?? pictureAnchorStart(cue),
				pictureEndMs: cue.pictureEndMs ?? pictureAnchorEnd(cue),
				assignedAudio: audio ? { ...audio, fitPlaybackRate: nextRate } : audio
			};
		});

		if (!changed && !beforeMissing) return { changed: 0 };

		project = touch({ ...project, cues: nextCues });
		this.syncTimelineDuration();
		return { changed: Math.max(changed, beforeMissing ? 1 : 0) };
	},

	/**
	 * Apply Smart Align timing patches (start/end).
	 * Always resets fitPlaybackRate to 1 — Align must not auto-speed/pitch TTS.
	 * Prosody pitch/speed stay under manual user control.
	 */
	applySmartAlignPatches(patches: SmartAlignPatch[]): { changed: number } {
		const byId = new Map(patches.map((p) => [p.id, p]));
		let changed = 0;
		const nextCues = withPictureAnchors(project.cues).map((cue) => {
			const p = byId.get(cue.id);
			const audio = cue.assignedAudio;
			const prevRate = audio?.fitPlaybackRate ?? 1;
			const needsRateReset = Boolean(audio) && Math.abs(prevRate - 1) >= 0.001;

			if (!p) {
				if (!needsRateReset) return cue;
				changed += 1;
				return {
					...cue,
					assignedAudio: audio ? { ...audio, fitPlaybackRate: 1 } : audio
				};
			}

			if (
				p.startMs === cue.startMs &&
				p.endMs === cue.endMs &&
				!needsRateReset
			) {
				return cue;
			}
			changed += 1;
			return {
				...cue,
				startMs: p.startMs,
				endMs: p.endMs,
				assignedAudio: audio ? { ...audio, fitPlaybackRate: 1 } : audio
			};
		});
		if (!changed) return { changed: 0 };
		project = touch({ ...project, cues: nextCues });
		this.syncTimelineDuration();
		return { changed };
	},

	/**
	 * Speed TTS in place so speech fits each cue's existing window.
	 * Does not change startMs / endMs.
	 */
	applyTtsRateOnlyToFitVideo(videoMs: number): { changed: number; maxRate: number } {
		const mediaEnd = Math.max(500, Math.round(videoMs));
		let changed = 0;
		let maxRate = 1;
		const nextCues = project.cues.map((cue) => {
			const audio = cue.assignedAudio;
			const natural = audio?.durationMs;
			if (!audio || typeof natural !== 'number' || natural < 80) return cue;

			const windowEnd = Math.min(cue.endMs, mediaEnd - 20);
			const avail = Math.max(200, windowEnd - cue.startMs);
			const nextRate =
				Math.round(Math.min(ALIGN_MAX_TTS_RATE, Math.max(1, natural / avail)) * 1000) /
				1000;
			maxRate = Math.max(maxRate, nextRate);
			const prevRate = audio.fitPlaybackRate ?? 1;
			if (Math.abs(prevRate - nextRate) < 0.001) return cue;
			changed += 1;
			return {
				...cue,
				assignedAudio: { ...audio, fitPlaybackRate: nextRate }
			};
		});
		if (changed) project = touch({ ...project, cues: nextCues });
		return { changed, maxRate };
	},

	/**
	 * Set project.durationMs from content end and real media length.
	 * May shrink after Align packs a long dub back into the picture.
	 */
	syncTimelineDuration(): number {
		const assetMs =
			(project.videoAssetId
				? project.assets.find((a) => a.id === project.videoAssetId)?.durationMs
				: undefined) ?? 0;
		const mediaMs = Math.max(
			originalAudio.durationMs > 1000 ? originalAudio.durationMs : 0,
			assetMs > 1000 ? assetMs : 0
		);
		let contentEnd = 0;
		for (const cue of project.cues) {
			contentEnd = Math.max(contentEnd, cueAudioEndMs(cue), cue.endMs);
		}
		const next = Math.max(mediaMs, contentEnd + 200, 1000);
		if (next !== project.durationMs) {
			project = touch({ ...project, durationMs: next });
		}
		return next;
	},

	/**
	 * Apply a uniform speech playback rate (≥1) to generated TTS clips, shrink
	 * cue windows to play-through length, then pack gaps. Used by Fit video to dub
	 * so detailed scripts share squeeze with pitch-safe video tempo.
	 */
	applySpeechAlignRate(rate: number): { changed: number; rate: number } {
		// Cap — Align prefers natural speech; mild bump only when video hits 0.50× floor.
		const r = Math.round(Math.max(1, Math.min(ALIGN_FALLBACK_TTS_RATE, rate)) * 1000) / 1000;
		if (r <= 1.001) {
			// Reset rates to 1 and re-pack to natural lengths.
			let changed = 0;
			const nextCues = project.cues.map((cue) => {
				const audio = cue.assignedAudio;
				if (!audio?.durationMs || audio.durationMs < 80) return cue;
				const natural = Math.round(audio.durationMs);
				const prevRate = audio.fitPlaybackRate ?? 1;
				if (Math.abs(prevRate - 1) < 0.001 && cue.endMs - cue.startMs === natural) {
					return cue;
				}
				changed += 1;
				return {
					...cue,
					endMs: cue.startMs + Math.max(200, natural),
					assignedAudio: { ...audio, fitPlaybackRate: 1 }
				};
			});
			if (changed) {
				project = touch({ ...project, cues: nextCues });
				this.tightenCueGaps({ maxGapMs: ALIGN_BREATH_MS, hangPadMs: ALIGN_HANG_PAD_MS });
			}
			return { changed, rate: 1 };
		}

		let changed = 0;
		const nextCues = project.cues.map((cue) => {
			const audio = cue.assignedAudio;
			if (!audio?.durationMs || audio.durationMs < 80) return cue;
			const natural = Math.round(audio.durationMs);
			const playMs = Math.max(200, Math.ceil(natural / r));
			changed += 1;
			return {
				...cue,
				endMs: cue.startMs + playMs,
				assignedAudio: { ...audio, fitPlaybackRate: r }
			};
		});
		if (!changed) return { changed: 0, rate: r };
		project = touch({ ...project, cues: nextCues });
		this.tightenCueGaps({ maxGapMs: ALIGN_BREATH_MS, hangPadMs: ALIGN_HANG_PAD_MS });
		return { changed, rate: r };
	},

	/**
	 * Pack all cues into [0, mediaMs] using speech rate + gap tighten.
	 * Used when Align still leaves TTS past the picture.
	 * Does not delete script text.
	 *
	 * `allowForceFit` defaults false — Align must not chipmunk speech into a short
	 * picture; force-fit is only for explicit last-resort callers.
	 */
	packCuesIntoMedia(
		mediaMs: number,
		maxRate = ALIGN_MAX_TTS_RATE,
		opts?: { allowForceFit?: boolean }
	): { rate: number; endMs: number } {
		const target = Math.max(1000, Math.round(mediaMs) - 200);
		if (target < 500 || !project.cues.length) {
			return { rate: 1, endMs: this.syncTimelineDuration() };
		}

		// Natural packed length (ignore prior rates), including breath gaps.
		const sorted = [...project.cues].sort(
			(a, b) => a.startMs - b.startMs || a.index - b.index
		);
		const breath = ALIGN_BREATH_MS;
		let natural = 0;
		for (let i = 0; i < sorted.length; i++) {
			const cue = sorted[i]!;
			const dur = cue.assignedAudio?.durationMs;
			natural +=
				typeof dur === 'number' && dur > 80
					? Math.round(dur)
					: Math.max(200, cue.endMs - cue.startMs);
			if (i < sorted.length - 1) natural += breath;
		}

		const need = natural / target;
		// Mild squeeze only (Align default max ≈ 1.05).
		const rate =
			Math.round(Math.min(Math.max(1, need), Math.min(ALIGN_MAX_TTS_RATE, maxRate)) * 1000) /
			1000;
		if (rate > 1.001) {
			this.applySpeechAlignRate(rate);
		} else {
			this.tightenCueGaps({ maxGapMs: ALIGN_BREATH_MS, hangPadMs: ALIGN_HANG_PAD_MS });
		}

		let endMs = 0;
		for (const cue of project.cues) {
			endMs = Math.max(endMs, cueAudioEndMs(cue), cue.endMs);
		}

		// Force-fit is gated — default Align never chipmunks into a short video.
		if (endMs > mediaMs + 400 && endMs > 0 && opts?.allowForceFit) {
			const forced = this.forceFitCuesIntoMedia(mediaMs);
			return { rate: Math.max(rate, forced.rate), endMs: forced.endMs };
		}

		this.syncTimelineDuration();
		return { rate, endMs };
	},

	/**
	 * Last resort: pack every cue into [0, mediaMs] with a uniform rate (and
	 * shorter breath if needed). Guarantees content ends at/before the picture
	 * without re-running tightenCueGaps (which would grow the timeline again).
	 */
	forceFitCuesIntoMedia(mediaMs: number): { rate: number; endMs: number } {
		const target = Math.max(1000, Math.round(mediaMs) - 200);
		const sorted = [...project.cues].sort(
			(a, b) => a.startMs - b.startMs || a.index - b.index
		);
		if (!sorted.length || target < 500) {
			return { rate: 1, endMs: this.syncTimelineDuration() };
		}

		const naturals = sorted.map((cue) => {
			const dur = cue.assignedAudio?.durationMs;
			return typeof dur === 'number' && dur > 80
				? Math.round(dur)
				: Math.max(200, cue.endMs - cue.startMs);
		});
		const speechSum = Math.max(
			1,
			naturals.reduce((a, b) => a + b, 0)
		);
		const n = sorted.length;
		const gapCount = Math.max(0, n - 1);
		const minBreath = 120;

		// Shrink breath until speech fits at ≤ force-fit rate.
		let breath = ALIGN_BREATH_MS;
		while (breath > minBreath) {
			const speechBudget = target - gapCount * breath;
			if (speechBudget >= n * 120 && speechSum / speechBudget <= ALIGN_FORCE_FIT_MAX_TTS_RATE) {
				break;
			}
			breath = Math.max(minBreath, Math.round(breath * 0.8));
		}

		const speechBudget = Math.max(n * 120, target - gapCount * breath);
		let rate = Math.min(
			ALIGN_FORCE_FIT_MAX_TTS_RATE,
			Math.max(1, speechSum / speechBudget)
		);
		rate = Math.round(rate * 1000) / 1000;

		const byId = new Map<
			string,
			{ startMs: number; endMs: number; fitPlaybackRate: number }
		>();
		let t = 0;
		for (let i = 0; i < sorted.length; i++) {
			const cue = sorted[i]!;
			const natural = naturals[i]!;
			const playMs = Math.max(120, Math.ceil(natural / rate));
			byId.set(cue.id, {
				startMs: t,
				endMs: t + playMs,
				fitPlaybackRate: rate
			});
			t += playMs;
			if (i < sorted.length - 1) t += breath;
		}

		// Still over (extreme script): proportional slots inside target; rate matches slot.
		if (t > target + 40) {
			breath = minBreath;
			const available = Math.max(n * 120, target - gapCount * breath);
			t = 0;
			for (let i = 0; i < sorted.length; i++) {
				const cue = sorted[i]!;
				const natural = naturals[i]!;
				const share = Math.max(
					120,
					Math.round((available * natural) / speechSum)
				);
				const slotRate = Math.min(
					ALIGN_FORCE_FIT_MAX_TTS_RATE,
					Math.max(1, natural / share)
				);
				// Keep audio end = subtitle end inside the share.
				const playMs = Math.min(share, Math.max(120, Math.ceil(natural / slotRate)));
				const fitPlaybackRate = Math.min(
					ALIGN_FORCE_FIT_MAX_TTS_RATE,
					Math.max(1, natural / playMs)
				);
				byId.set(cue.id, {
					startMs: t,
					endMs: t + playMs,
					fitPlaybackRate: Math.round(fitPlaybackRate * 1000) / 1000
				});
				t += playMs;
				if (i < sorted.length - 1) t += breath;
			}
			// Hard scale if rounding still overshoots.
			if (t > target + 40) {
				const scale = target / t;
				let cursor = 0;
				for (let i = 0; i < sorted.length; i++) {
					const cue = sorted[i]!;
					const slot = byId.get(cue.id)!;
					const playMs = Math.max(120, Math.round((slot.endMs - slot.startMs) * scale));
					const natural = naturals[i]!;
					const fitPlaybackRate = Math.min(
						ALIGN_FORCE_FIT_MAX_TTS_RATE,
						Math.max(1, natural / playMs)
					);
					byId.set(cue.id, {
						startMs: cursor,
						endMs: cursor + playMs,
						fitPlaybackRate: Math.round(fitPlaybackRate * 1000) / 1000
					});
					cursor += playMs;
					if (i < sorted.length - 1) {
						cursor += Math.max(40, Math.round(breath * scale));
					}
				}
			}
		}

		const nextCues = project.cues.map((cue) => {
			const slot = byId.get(cue.id);
			if (!slot) return cue;
			const audio = cue.assignedAudio;
			return {
				...cue,
				startMs: slot.startMs,
				endMs: slot.endMs,
				assignedAudio: audio
					? { ...audio, fitPlaybackRate: slot.fitPlaybackRate }
					: audio
			};
		});
		project = touch({ ...project, cues: nextCues });

		let endMs = 0;
		for (const cue of project.cues) {
			endMs = Math.max(endMs, cueAudioEndMs(cue), cue.endMs);
		}
		this.syncTimelineDuration();
		return { rate, endMs };
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
				notifyTtsInvalidate(cue.id);
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

	/** True when the cue has a playable TTS clip that matches its current text. */
	cueHasTtsAudio(cue: {
		status: string;
		translation?: string;
		source?: string;
		assignedAudio?: {
			filePath?: string | null;
			url?: string | null;
			sourceText?: string;
		} | null;
	}): boolean {
		return cueTtsMatchesText(cue);
	},

	/** Register mixer invalidate (VideoPreview). Pass null to clear. */
	setTtsInvalidateHandler(handler: ((cueId: string | null) => void) | null) {
		ttsInvalidateHandler = handler;
	},

	updateCue(id: string, patch: Partial<Omit<SubtitleCue, 'id' | 'index'>>) {
		const speechKeys = [
			'translation',
			'source',
			'voiceId',
			'pitch',
			'speed',
			'volume',
			'speaker'
		] as const;
		if (typeof patch.speaker === 'string' && patch.speaker.trim()) {
			this.ensureSpeakerFromTemplate(patch.speaker.trim());
		}
		project = touch({
			...project,
			cues: project.cues.map((cue) => {
				if (cue.id !== id) return cue;
				const next = { ...cue, ...patch };
				if (typeof patch.voiceId === 'string') {
					next.voiceId = migrateVoiceId(patch.voiceId);
				}
				if (typeof patch.speaker === 'string') {
					const bank = (project.speakerBank ?? []).find(
						(s) => s.id === patch.speaker!.trim()
					);
					if (bank?.voiceId) next.voiceId = bank.voiceId;
				}
				if (next.endMs < next.startMs) next.endMs = next.startMs;

				const speechChanged = speechKeys.some((key) => {
					if (!(key in patch)) return false;
					return (patch as Record<string, unknown>)[key] !== cue[key];
				});
				if (speechChanged && cue.assignedAudio) {
					next.assignedAudio = null;
					if (next.status === 'generated' || next.status === 'error') {
						next.status = 'ready';
					}
					dropTtsWaveforms([cue.id]);
				}
				return next;
			})
		});
	},

	/**
	 * Assign pasted Khmer script.
	 * Default (`fitToExtractSpan`): rebuild cues so 1 script line = 1 cue inside the
	 * Extract speech span (FunASR blobs are only a timeline; lines match hardsubs).
	 * Opt-in `mergeExtraLines`: pack into existing ASR cue count (old glue).
	 * Clears TTS so Generate uses the new text.
	 */
	applyScriptTranslations(
		script: string,
		opts?: {
			createExtraCues?: boolean;
			mergeExtraLines?: boolean;
			/** Default true — carve N line windows from Extract span. */
			fitToExtractSpan?: boolean;
		}
	): {
		applied: number;
		lineCount: number;
		sentenceCount: number;
		cueCount: number;
		createdCues: number;
		unfilledCues: number;
		mergedExtraLines: number;
		estimatedSpeechMs: number;
		fittedToSpan: boolean;
		extractCueCount: number;
	} {
		const lines = splitKhmerSentences(script);
		const cues = [...project.cues].sort((a, b) => a.index - b.index || a.startMs - b.startMs);
		const cueCount = cues.length;
		const lineCount = lines.length;
		const estimatedSpeechMs = lines.reduce((sum, s) => sum + estimateKhmerSpeechMs(s), 0);
		const mergeExtra =
			opts?.mergeExtraLines === true || opts?.createExtraCues === false;
		const fitToSpan = !mergeExtra && opts?.fitToExtractSpan !== false;

		const empty = {
			applied: 0,
			lineCount: 0,
			sentenceCount: 0,
			cueCount,
			createdCues: 0,
			unfilledCues: cueCount,
			mergedExtraLines: 0,
			estimatedSpeechMs: 0,
			fittedToSpan: false,
			extractCueCount: cueCount
		};

		if (lineCount === 0) return empty;

		// No Extract / Import yet — create cues from the script so you can arrange on the timeline.
		if (cueCount === 0) {
			const startAt = Math.max(0, Math.round(playback.playheadMs));
			const breath = 200;
			const weights = lines.map((l) => Math.max(900, estimateKhmerSpeechMs(l)));
			const span =
				weights.reduce((s, w) => s + w, 0) + breath * Math.max(0, lineCount - 1);
			const planned = planCuesFromScriptLines(
				lines,
				[{ startMs: startAt, endMs: startAt + Math.max(span, lineCount * 900), source: '' }],
				{ breathMs: breath, minCueMs: 900 }
			);
			const nextCues = planned.cues.map((p, i) =>
				createSubtitleCue(
					i + 1,
					{
						startMs: p.startMs,
						endMs: p.endMs,
						pictureStartMs: p.startMs,
						pictureEndMs: p.endMs,
						source: '',
						translation: p.translation,
						status: 'ready',
						speaker: 'Speaker 1',
						voiceId,
						pitch,
						speed,
						volume,
						assignedAudio: null
					},
					{ voiceId, speaker: 'Speaker 1' }
				)
			);
			dropTtsWaveforms([]);
			project = touch({ ...project, cues: nextCues });
			this.syncTimelineDuration();
			return {
				applied: nextCues.length,
				lineCount,
				sentenceCount: lineCount,
				cueCount: nextCues.length,
				createdCues: nextCues.length,
				unfilledCues: 0,
				mergedExtraLines: 0,
				estimatedSpeechMs,
				fittedToSpan: false,
				extractCueCount: 0
			};
		}

		// Default: fit script lines into Extract speech span (1 line → 1 cue).
		if (fitToSpan && cueCount > 0) {
			const planned = planCuesFromScriptLines(lines, cues);
			const template = cues[0]!;
			const nextCues = planned.cues.map((p, i) =>
				createSubtitleCue(
					i + 1,
					{
						startMs: p.startMs,
						endMs: p.endMs,
						pictureStartMs: p.startMs,
						pictureEndMs: p.endMs,
						source: p.source,
						translation: p.translation,
						status: 'ready',
						speaker: template.speaker ?? 'Speaker 1',
						voiceId: template.voiceId ?? voiceId,
						pitch: template.pitch ?? pitch,
						speed: template.speed ?? speed,
						volume: template.volume ?? volume,
						assignedAudio: null
					},
					{ voiceId, speaker: template.speaker ?? 'Speaker 1' }
				)
			);

			dropTtsWaveforms(project.cues.map((c) => c.id));
			project = touch({ ...project, cues: nextCues });
			this.syncTimelineDuration();

			return {
				applied: nextCues.length,
				lineCount,
				sentenceCount: lineCount,
				cueCount: nextCues.length,
				createdCues: Math.max(0, nextCues.length - cueCount),
				unfilledCues: 0,
				mergedExtraLines: 0,
				estimatedSpeechMs,
				fittedToSpan: true,
				extractCueCount: planned.extractCueCount
			};
		}

		const byId = new Map<string, string>();
		let mergedExtraLines = 0;
		const created: SubtitleCue[] = [];

		if (mergeExtra && lineCount > cueCount) {
			const slots = packLinesIntoCueSlots(lines, cueCount);
			mergedExtraLines = Math.max(0, lineCount - cueCount);
			for (let i = 0; i < cueCount; i++) {
				const text = slots[i] ?? '';
				if (!text) continue;
				byId.set(cues[i]!.id, text);
			}
		} else if (lineCount <= cueCount) {
			for (let i = 0; i < lineCount; i++) {
				byId.set(cues[i]!.id, lines[i]!);
			}
		} else {
			for (let i = 0; i < cueCount; i++) {
				byId.set(cues[i]!.id, lines[i]!);
			}
			const last = cues[cues.length - 1];
			let cursor = last ? last.endMs : 0;
			for (let i = cueCount; i < lineCount; i++) {
				const text = lines[i]!;
				const dur = estimateKhmerSpeechMs(text);
				const startMs = cursor;
				const endMs = startMs + dur;
				created.push(
					createSubtitleCue(
						cueCount + created.length + 1,
						{
							startMs,
							endMs,
							source: '',
							translation: text,
							status: 'ready',
							speaker: last?.speaker ?? 'Speaker 1',
							voiceId: last?.voiceId ?? voiceId,
							pitch: last?.pitch ?? pitch,
							speed: last?.speed ?? speed,
							volume: last?.volume ?? volume
						},
						{ voiceId, speaker: last?.speaker ?? 'Speaker 1' }
					)
				);
				cursor = endMs + 80;
			}
		}

		const updatedExisting = project.cues.map((cue) => {
			const text = byId.get(cue.id);
			if (text == null) return cue;
			return {
				...cue,
				translation: text,
				status:
					cue.status === 'draft'
						? ('ready' as const)
						: cue.status === 'generated'
							? ('ready' as const)
							: cue.status,
				assignedAudio: null
			};
		});

		const nextCues = [...updatedExisting, ...created]
			.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
			.map((c, i) => ({ ...c, index: i + 1 }));

		dropTtsWaveforms([...byId.keys()]);

		project = touch({
			...project,
			cues: nextCues
		});
		this.syncTimelineDuration();

		const applied = byId.size + created.length;
		return {
			applied,
			lineCount,
			sentenceCount: lineCount,
			cueCount: nextCues.length,
			createdCues: created.length,
			unfilledCues: Math.max(0, cueCount - byId.size),
			mergedExtraLines,
			estimatedSpeechMs,
			fittedToSpan: false,
			extractCueCount: cueCount
		};
	},

	/**
	 * Resize a subtitle cue and push overlapping neighbors so clips never stack.
	 * - Growing the end into the next cue moves that cue's start (and cascades).
	 * - Growing the start into the previous cue moves that cue's end (and cascades).
	 * - Growing past the picture **extends the timeline** (never crush later cues into
	 *   the last 200 ms — that chopped Khmer TTS / “video finished before subs”).
	 */
	trimCuePushNeighbors(
		id: string,
		edge: 'start' | 'end',
		startMs: number,
		endMs: number,
		minDurationMs = 200
	) {
		const minDur = Math.max(50, Math.round(minDurationMs));
		let nextStart = Math.max(0, Math.round(startMs));
		let nextEnd = Math.max(nextStart + minDur, Math.round(endMs));

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
				const c = sorted[j]!;
				const t = timing.get(c.id)!;
				if (t.startMs >= boundary) break;
				// Keep each follower’s window length; slide it forward (grow timeline).
				const dur = Math.max(minDur, t.endMs - t.startMs);
				const start = boundary;
				const end = start + dur;
				timing.set(c.id, { startMs: start, endMs: end });
				boundary = end;
			}
		} else {
			let boundary = nextStart;
			for (let j = idx - 1; j >= 0; j--) {
				const c = sorted[j]!;
				const t = timing.get(c.id)!;
				if (t.endMs <= boundary) break;
				const dur = Math.max(minDur, t.endMs - t.startMs);
				const end = boundary;
				const start = Math.max(0, Math.min(end - minDur, end - dur));
				timing.set(c.id, { startMs: start, endMs: end });
				boundary = start;
				if (boundary <= 0) {
					for (let k = j - 1; k >= 0; k--) {
						timing.set(sorted[k]!.id, { startMs: 0, endMs: minDur });
					}
					break;
				}
			}
		}

		let maxEnd = 0;
		for (const t of timing.values()) {
			maxEnd = Math.max(maxEnd, t.endMs);
		}

		project = touch({
			...project,
			durationMs: Math.max(project.durationMs, maxEnd + 200),
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
	 * Nudge selected cues for keyboard arrangement.
	 * `both` = slide window; `start` / `end` = trim that edge.
	 */
	nudgeSelectedCues(
		deltaMs: number,
		mode: 'both' | 'start' | 'end' = 'both'
	): number {
		const ids = new Set(selectedCueIds);
		if (!ids.size || !Number.isFinite(deltaMs) || deltaMs === 0) return 0;
		const minDur = 200;
		const maxEnd = Math.max(1000, project.durationMs);
		let changed = 0;
		project = touch({
			...project,
			cues: project.cues.map((c) => {
				if (!ids.has(c.id)) return c;
				changed += 1;
				if (mode === 'both') {
					const dur = Math.max(minDur, c.endMs - c.startMs);
					let start = Math.round(c.startMs + deltaMs);
					let end = start + dur;
					if (start < 0) {
						start = 0;
						end = dur;
					}
					if (end > maxEnd) {
						end = maxEnd;
						start = Math.max(0, end - dur);
					}
					return { ...c, startMs: start, endMs: end };
				}
				if (mode === 'start') {
					const start = Math.max(
						0,
						Math.min(c.endMs - minDur, Math.round(c.startMs + deltaMs))
					);
					return { ...c, startMs: start };
				}
				const end = Math.min(
					maxEnd,
					Math.max(c.startMs + minDur, Math.round(c.endMs + deltaMs))
				);
				return { ...c, endMs: end };
			})
		});
		return changed;
	},

	/** Select previous/next cue by timeline order. */
	selectAdjacentCue(dir: -1 | 1): string | null {
		const sorted = [...project.cues].sort(
			(a, b) => a.startMs - b.startMs || a.index - b.index
		);
		if (!sorted.length) return null;
		const currentId = selectedCueIds[0] ?? selectionAnchorId;
		const idx = sorted.findIndex((c) => c.id === currentId);
		const nextIdx =
			idx < 0
				? dir > 0
					? 0
					: sorted.length - 1
				: Math.max(0, Math.min(sorted.length - 1, idx + dir));
		const next = sorted[nextIdx];
		if (!next) return null;
		selectedCueIds = [next.id];
		selectionAnchorId = next.id;
		return next.id;
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
	 * Split a cue at `atMs` into two segments.
	 * When generated TTS exists, both halves keep their audio slices (FFmpeg cut).
	 * Left keeps original text; right duplicates text (editable). Returns new cue id.
	 */
	async splitCueAtMs(id: string | undefined, atMs: number): Promise<string | null> {
		const cueId = id ?? selectedCueIds[0];
		if (!cueId) return null;
		const cue = project.cues.find((c) => c.id === cueId);
		if (!cue) return null;
		const minDur = 200;
		const cut = Math.round(atMs);
		const spanEnd = Math.max(cue.endMs, cuePreviewEndMs(cue));
		if (cut < cue.startMs + minDur || cut > spanEnd - minDur) return null;

		const idx = project.cues.findIndex((c) => c.id === cueId);
		if (idx < 0) return null;

		const audio = cue.assignedAudio;
		const hasAudio =
			Boolean(audio) &&
			typeof audio?.durationMs === 'number' &&
			audio.durationMs > 80 &&
			Boolean(audio.filePath?.trim() || audio.url?.trim());

		const rate =
			typeof audio?.fitPlaybackRate === 'number' && audio.fitPlaybackRate > 0
				? audio.fitPlaybackRate
				: 1;
		const naturalMs = hasAudio ? Math.round(audio!.durationMs!) : 0;
		const wallFromStart = Math.max(0, cut - cue.startMs);
		// Map timeline cut → position inside the natural TTS file.
		const canSliceAudio = hasAudio && naturalMs >= 160;
		const audioCutMs = canSliceAudio
			? Math.max(40, Math.min(naturalMs - 40, Math.round(wallFromStart * rate)))
			: 0;

		type AudioHalf = NonNullable<SubtitleCue['assignedAudio']>;
		let leftAudio: AudioHalf | null = null;
		let rightAudio: AudioHalf | null = null;
		let rightPeaks: number[] | undefined;
		let audioSplitOk = false;

		if (canSliceAudio && audio?.filePath?.trim() && isTauriRuntime()) {
			const src = audio.filePath.trim();
			try {
				const [leftSlice, rightSlice] = await Promise.all([
					sliceAudioFile({
						sourcePath: src,
						cueId: `${cue.id}-L`,
						startMs: 0,
						endMs: audioCutMs
					}),
					sliceAudioFile({
						sourcePath: src,
						cueId: `${cue.id}-R`,
						startMs: audioCutMs,
						endMs: naturalMs
					})
				]);
				const { convertFileSrc } = await import('@tauri-apps/api/core');
				const leftUrl = convertFileSrc(leftSlice.filePath);
				const rightUrl = convertFileSrc(rightSlice.filePath);
				const base = {
					sourceCueId: cue.id,
					label: audio.label,
					generated: audio.generated ?? true,
					engine: audio.engine,
					fitPlaybackRate: 1,
					sourceText: audio.sourceText
				};
				leftAudio = {
					...base,
					filePath: leftSlice.filePath,
					url: leftUrl,
					durationMs: leftSlice.durationMs
				};
				rightAudio = {
					...base,
					sourceCueId: '', // filled after right id known
					filePath: rightSlice.filePath,
					url: rightUrl,
					durationMs: rightSlice.durationMs
				};
				audioSplitOk = true;

				try {
					const [lw, rw] = await Promise.all([
						extractWaveformFromUrl(leftUrl, 120).catch(() => null),
						extractWaveformFromUrl(rightUrl, 120).catch(() => null)
					]);
					if (lw?.peaks) ttsWaveforms = { ...ttsWaveforms, [cue.id]: lw.peaks };
					if (rw?.peaks) rightPeaks = rw.peaks;
				} catch {
					/* waveform optional */
				}
			} catch {
				audioSplitOk = false;
				leftAudio = null;
				rightAudio = null;
				rightPeaks = undefined;
			}
		}

		const rightEnd = Math.max(cue.endMs, spanEnd);
		const picStart =
			typeof cue.pictureStartMs === 'number' ? cue.pictureStartMs : undefined;
		const picEnd = typeof cue.pictureEndMs === 'number' ? cue.pictureEndMs : undefined;

		const right = createSubtitleCue(
			cue.index + 1,
			{
				startMs: cut,
				endMs: rightEnd,
				pictureStartMs:
					picStart != null || picEnd != null
						? Math.max(cut, picStart ?? cut)
						: undefined,
				pictureEndMs: picEnd != null ? Math.max(cut + minDur, picEnd) : undefined,
				source: cue.source,
				translation: cue.translation,
				speaker: cue.speaker,
				pitch: cue.pitch,
				speed: cue.speed,
				volume: cue.volume,
				voiceId: cue.voiceId,
				status: audioSplitOk ? ('generated' as const) : ('draft' as const),
				assignedAudio: null
			},
			{ voiceId, speaker: cue.speaker }
		);

		if (audioSplitOk && rightAudio) {
			right.assignedAudio = { ...rightAudio, sourceCueId: right.id };
			right.status = 'generated';
			if (rightPeaks?.length) {
				ttsWaveforms = { ...ttsWaveforms, [right.id]: rightPeaks };
			}
		}

		const leftPicEnd =
			picEnd != null
				? Math.min(picEnd, cut)
				: picStart != null
					? Math.min(cut, Math.max(picStart + minDur, cut))
					: undefined;

		const cues = [...project.cues];
		cues[idx] = {
			...cue,
			endMs: cut,
			pictureEndMs:
				picStart != null || picEnd != null
					? Math.max((picStart ?? cue.startMs) + minDur, leftPicEnd ?? cut)
					: cue.pictureEndMs,
			assignedAudio: audioSplitOk ? leftAudio : null,
			status: audioSplitOk
				? ('generated' as const)
				: cue.status === 'generated' || cue.status === 'error'
					? ('ready' as const)
					: cue.status
		};
		cues.splice(idx + 1, 0, right);
		project = touch({
			...project,
			cues: cues.map((c, i) => ({ ...c, index: i + 1 }))
		});
		if (!audioSplitOk) {
			dropTtsWaveforms([cue.id]);
		} else {
			notifyTtsInvalidate(cue.id);
			notifyTtsInvalidate(right.id);
		}
		this.syncTimelineDuration();
		selectedCueIds = [cue.id, right.id];
		selectionAnchorId = right.id;
		return right.id;
	},

	/** Split at playhead (legacy helper). */
	async splitCueAtPlayhead(id?: string): Promise<string | null> {
		return this.splitCueAtMs(id, playback.playheadMs);
	},

	/**
	 * Split every selected cue that contains `atMs` (default playhead).
	 * If nothing selected, split the cue under that time.
	 * Returns number of successful cuts.
	 */
	async splitCuesAtMs(atMs?: number): Promise<number> {
		const cut = Math.round(atMs ?? playback.playheadMs);
		const minDur = 200;
		const contains = (c: SubtitleCue) => {
			const spanEnd = Math.max(c.endMs, cuePreviewEndMs(c));
			return cut >= c.startMs + minDur && cut <= spanEnd - minDur;
		};

		let targets = project.cues.filter(
			(c) => selectedCueIds.includes(c.id) && contains(c)
		);
		if (!targets.length) {
			const under = project.cues.find((c) => contains(c));
			if (under) targets = [under];
		}
		if (!targets.length) return 0;

		// Cut from right to left so indices stay stable while inserting.
		targets.sort((a, b) => b.startMs - a.startMs || b.index - a.index);
		let n = 0;
		const keepSelected: string[] = [];
		for (const t of targets) {
			const rightId = await this.splitCueAtMs(t.id, cut);
			if (rightId) {
				n += 1;
				keepSelected.push(t.id, rightId);
			}
		}
		if (keepSelected.length) {
			selectedCueIds = [...new Set(keepSelected)];
			selectionAnchorId = keepSelected[keepSelected.length - 1] ?? null;
		}
		return n;
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

		dropTtsWaveforms([keep.id, ...remove]);

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
								status: 'ready' as const,
								assignedAudio: null
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
		const target = project.cues.find((c) => c.id === targetCueId);
		if (!source || !target) return;

		const sameText = cueSpeakText(target) === cueSpeakText(source);
		const srcAudio = source.assignedAudio;
		const canCopyClip =
			sameText &&
			!!srcAudio &&
			!!(srcAudio.filePath || srcAudio.url);

		if (canCopyClip) {
			const peaks = ttsWaveforms[sourceCueId];
			if (peaks?.length) {
				ttsWaveforms = { ...ttsWaveforms, [targetCueId]: [...peaks] };
			}
		} else {
			dropTtsWaveforms([targetCueId]);
		}
		notifyTtsInvalidate(targetCueId);

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
					status: canCopyClip
						? ('generated' as const)
						: cue.status === 'generated'
							? ('ready' as const)
							: cue.status === 'draft'
								? ('ready' as const)
								: cue.status,
					assignedAudio: canCopyClip
						? {
								...srcAudio!,
								sourceCueId: source.id,
								label: srcAudio!.label || `TTS #${source.index}`,
								sourceText: srcAudio!.sourceText ?? cueSpeakText(source)
							}
						: null
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

		const asset = createMediaAsset(file, 'video', 0);
		if (videoPath) asset.path = videoPath;
		const otherAssets = project.assets.filter((a) => a.id !== project.videoAssetId);
		const syncTitle = options?.syncTitle !== false;
		if (syncTitle) {
			sourceVideoFile = file;
			sourceVideoPath = videoPath;
			sourceDurationMs = 0;
		}
		project = touch({
			...project,
			name: syncTitle ? titleFromMediaFileName(file.name) : project.name,
			videoAssetId: asset.id,
			assets: [asset, ...otherAssets],
			mediaTempoFromSource: syncTitle ? 1 : (project.mediaTempoFromSource ?? 1)
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
		options?: { syncTitle?: boolean; recordHistory?: boolean }
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
			if (syncTitle) {
				sourceVideoPath = path;
				sourceVideoFile = null;
				sourceDurationMs = 0;
			}
			project = touch(
				{
					...project,
					name: syncTitle ? titleFromMediaFileName(name) : project.name,
					videoAssetId: asset.id,
					assets: [asset, ...otherAssets],
					// New user media → source timeline. Remaster keeps prior factor until applyVideoTempo.
					mediaTempoFromSource: syncTitle ? 1 : (project.mediaTempoFromSource ?? 1)
				},
				{ recordHistory: options?.recordHistory !== false }
			);
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
		sourceVideoPath = null;
		sourceVideoFile = null;
		sourceDurationMs = 0;
		const videoId = project.videoAssetId;
		project = touch({
			...project,
			videoAssetId: null,
			assets: videoId ? project.assets.filter((a) => a.id !== videoId) : project.assets,
			mediaTempoFromSource: 1
		});
		playback.isPlaying = false;
		playback.focusedCueId = null;
		playback.playheadMs = 0;
	},

	/**
	 * After FFmpeg pitch-safe remaster: swap video media, update duration.
	 * Picture-lock Align: remap cues from source anchors (anchors never scaled).
	 * Manual Apply: `scaleCues: false` — subtitle times stay exactly as on the timeline;
	 * only picture/audio media changes.
	 */
	async applyVideoTempo(
		tempo: number,
		outputPath: string,
		durationMs: number,
		opts?: {
			scaleCues?: boolean;
			clearAudio?: boolean;
			pictureLock?: boolean;
			absoluteFromSource?: boolean;
		}
	): Promise<boolean> {
		const t = Number(tempo);
		if (!Number.isFinite(t) || t <= 0) return false;

		pushUndoSnapshot();

		const pictureLock = opts?.pictureLock === true;
		const absoluteFromSource = opts?.absoluteFromSource === true;
		const scaleCues = opts?.scaleCues !== false;
		const clearAudio = opts?.clearAudio ?? (pictureLock ? false : scaleCues);

		const prevTempo = Number.isFinite(project.mediaTempoFromSource)
			? Math.max(0.25, project.mediaTempoFromSource!)
			: 1;
		// Absolute Manual Apply sets the factor vs original; relative remasters multiply.
		const nextTempoFromSource = absoluteFromSource
			? Math.round(Math.min(2, Math.max(0.25, t)) * 10000) / 10000
			: Math.round(Math.min(2, Math.max(0.25, prevTempo * t)) * 10000) / 10000;

		let nextCues = project.cues;
		if (pictureLock) {
			const anchored = withPictureAnchors(project.cues);
			const patches = planPictureLockPatches(anchored, {
				maxRate: ALIGN_MAX_TTS_RATE,
				mediaTempoFromSource: nextTempoFromSource,
				mediaDurationMs: Math.round(durationMs)
			});
			const byId = new Map(patches.map((p) => [p.id, p]));
			nextCues = anchored.map((cue) => {
				const p = byId.get(cue.id);
				if (!p) return cue;
				const audio = clearAudio ? null : cue.assignedAudio;
				return {
					...cue,
					startMs: p.startMs,
					endMs: p.endMs,
					pictureStartMs: cue.pictureStartMs ?? pictureAnchorStart(cue),
					pictureEndMs: cue.pictureEndMs ?? pictureAnchorEnd(cue),
					status:
						clearAudio && cue.status === 'generated' ? ('ready' as const) : cue.status,
					assignedAudio: audio
						? { ...audio, fitPlaybackRate: p.fitPlaybackRate }
						: null
				};
			});
		} else if (scaleCues) {
			const cueScale = absoluteFromSource
				? nextTempoFromSource / Math.max(0.25, prevTempo)
				: t;
			nextCues = scaleCueTimesForTempo(project.cues, cueScale).map((cue) => ({
				...cue,
				status:
					clearAudio && cue.status === 'generated' ? ('ready' as const) : cue.status,
				assignedAudio: clearAudio ? null : cue.assignedAudio
			}));
		}

		const nextDuration = Math.max(
			1000,
			Math.round(durationMs) || Math.round((project.durationMs || 0) / t)
		);
		// When leaving cues alone, keep timeline long enough for existing subtitles.
		const leaveCuesAlone = !pictureLock && !scaleCues;
		let contentFloor = 0;
		if (leaveCuesAlone) {
			for (const cue of project.cues) {
				contentFloor = Math.max(contentFloor, cueAudioEndMs(cue), cue.endMs);
			}
		}
		const projectDuration = leaveCuesAlone
			? Math.max(nextDuration, contentFloor > 0 ? contentFloor + 200 : 0)
			: nextDuration;

		const ok = await this.setVideoFromPath(outputPath, {
			syncTitle: false,
			recordHistory: false
		});
		if (!ok) return false;

		if (absoluteFromSource && sourceDurationMs < 1000) {
			sourceDurationMs = Math.max(1000, Math.round(nextDuration * nextTempoFromSource));
		}

		project = touch(
			{
				...project,
				cues: nextCues,
				durationMs: projectDuration,
				mediaTempoFromSource: nextTempoFromSource,
				assets: project.assets.map((a) =>
					a.id === project.videoAssetId
						? { ...a, durationMs: nextDuration, path: outputPath }
						: a
				)
			},
			{ recordHistory: false }
		);
		playback.playheadMs = Math.min(playback.playheadMs, projectDuration);
		playback.focusedCueId = null;
		return true;
	},

	/**
	 * Restore original source media at 1.00×. Subtitle cue times stay as-is.
	 * Requires `sourceVideoPath` / `sourceVideoFile` from the user’s open.
	 */
	async restoreSourceVideoTempo(_opts?: { scaleCues?: boolean }): Promise<boolean> {
		const path = sourceVideoPath?.trim() || null;
		const file = sourceVideoFile;
		if (!path && !file) return false;

		pushUndoSnapshot();

		const mediaDuration = Math.max(
			1000,
			sourceDurationMs ||
				Math.round(
					(project.durationMs || 0) * Math.max(0.25, project.mediaTempoFromSource ?? 1)
				) ||
				project.durationMs
		);
		let contentFloor = 0;
		for (const cue of project.cues) {
			contentFloor = Math.max(contentFloor, cueAudioEndMs(cue), cue.endMs);
		}
		const nextDuration = Math.max(
			mediaDuration,
			contentFloor > 0 ? contentFloor + 200 : 0
		);

		let ok = false;
		if (path) {
			ok = await this.setVideoFromPath(path, { syncTitle: false, recordHistory: false });
		} else if (file) {
			ok = this.setVideoFromFile(file, null, { syncTitle: false });
		}
		if (!ok) return false;

		project = touch(
			{
				...project,
				durationMs: nextDuration,
				mediaTempoFromSource: 1,
				assets: project.assets.map((a) =>
					a.id === project.videoAssetId
						? { ...a, durationMs: mediaDuration, path: path ?? a.path }
						: a
				)
			},
			{ recordHistory: false }
		);
		playback.playheadMs = Math.min(playback.playheadMs, nextDuration);
		playback.focusedCueId = null;
		return true;
	},

	/** Called when `<video>` reports real duration. */
	/** Latest subtitle/TTS content end (ms) — may exceed the source video. */
	contentEndMs(): number {
		let max = 0;
		for (const cue of project.cues) {
			max = Math.max(max, cueAudioEndMs(cue), cue.endMs);
		}
		return max;
	},

	/**
	 * Set timeline length. By default never shrinks below dub content end
	 * (media metadata reload used to wipe TTS-extended timelines).
	 * Pass `{ force: true }` after Tempo remaster when media length is authoritative.
	 *
	 * `ms` is treated as true picture length for the video asset. The project
	 * timeline may be longer (content floor); the asset must stay at picture
	 * length so Fit-to-dub / overhang detection still works.
	 */
	setDurationMs(ms: number, opts?: { force?: boolean }) {
		const mediaMs = Math.max(1000, Math.round(ms));
		let durationMs = mediaMs;
		if (!opts?.force) {
			durationMs = Math.max(durationMs, this.contentEndMs() + 200);
		}
		const videoId = project.videoAssetId;
		const atSourceTempo = Math.abs((project.mediaTempoFromSource ?? 1) - 1) < 0.001;
		if (atSourceTempo) {
			sourceDurationMs = mediaMs;
		}
		project = touch(
			{
				...project,
				durationMs,
				assets: project.assets.map((a) =>
					a.id === videoId ? { ...a, durationMs: mediaMs } : a
				)
			},
			{ recordHistory: false }
		);
		if (playback.playheadMs > durationMs) playback.playheadMs = durationMs;
	},

	/**
	 * Import dropped/picked media. Video opens as picture; `.srt` loads into the cue table.
	 * Returns how many files were accepted as assets / subtitle imports.
	 */
	async importMediaFiles(files: File[]): Promise<number> {
		let videoFile: File | null = null;
		const subtitleFiles: File[] = [];
		const added: ReturnType<typeof createMediaAsset>[] = [];
		let accepted = 0;

		for (const file of files) {
			const kind = classifyMediaFile(file);
			if (!kind) continue;
			accepted += 1;
			if (kind === 'video' && !videoFile) videoFile = file;
			if (kind === 'subtitle' && /\.srt$/i.test(file.name)) {
				subtitleFiles.push(file);
				continue;
			}
			if (kind === 'subtitle') {
				// Non-SRT subtitle containers — keep as asset only for now.
				added.push(createMediaAsset(file, kind, 0));
				continue;
			}
			added.push(createMediaAsset(file, kind, project.durationMs));
		}

		if (!accepted) return 0;

		if (videoFile) {
			this.setVideoFromFile(videoFile);
		}
		if (added.length) {
			project = touch({
				...project,
				assets: [...added, ...project.assets]
			});
		}

		// First .srt wins → cue table (replace). Extra .srt files are ignored for cues.
		if (subtitleFiles[0]) {
			await this.importSrtFile(subtitleFiles[0], { replace: true });
		}

		return accepted;
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
		void import('$lib/tts/voice-preview')
			.then((m) => m.stopVoicePreview())
			.catch(() => undefined);
	},

	/** Play/pause toggle for one cue (row Play button or TTS block). */
	toggleCuePlayback(id: string) {
		const cue = project.cues.find((item) => item.id === id);
		if (!cue) return;

		const end = cuePreviewEndMs(cue);
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
		const end = cuePreviewEndMs(cue);
		return playback.playheadMs >= cue.startMs && playback.playheadMs < end;
	},

	/**
	 * When a cue-focused play runs past the subtitle period, stop transport.
	 * Called from the video clock so TTS preview stops at the window you arranged.
	 */
	finishFocusedCueIfPast(playheadMs: number) {
		const id = playback.focusedCueId;
		if (!id || !playback.isPlaying) return;
		const cue = project.cues.find((item) => item.id === id);
		if (!cue) {
			playback.focusedCueId = null;
			return;
		}
		const end = cuePreviewEndMs(cue);
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
	setVoiceId(id: string, opts?: { applyToCues?: boolean }) {
		const engine = getTtsEngineId();
		const mapped = mapVoiceIdToEngine(id, engine);
		const next =
			engine === 'edge-tts' ? voicesStore.ensureVoicePresent(mapped) : mapped;
		voiceId = next;
		// Remember last selected voice across sessions.
		preferencesStore.setDefaultVoiceId(next);
		if (opts?.applyToCues !== false) {
			// Default: stamp onto selected cues (or all if none selected), like Prosody.
			this.applyVoiceToCues(next);
		}
	},

	/**
	 * Apply a voice id to selected subtitle rows (or all rows if none selected).
	 * Clears TTS on changed cues so Generate uses the new voice.
	 */
	applyVoiceToCues(id: string): number {
		const engine = getTtsEngineId();
		const next =
			engine === 'edge-tts'
				? voicesStore.ensureVoicePresent(mapVoiceIdToEngine(id, engine))
				: mapVoiceIdToEngine(id, engine);
		const ids =
			selectedCueIds.length > 0
				? new Set(selectedCueIds)
				: new Set(project.cues.map((c) => c.id));
		if (!ids.size) return 0;

		let changed = 0;
		const nextWaveforms = { ...ttsWaveforms };
		const nextCues = project.cues.map((cue) => {
			if (!ids.has(cue.id)) return cue;
			if (cue.voiceId === next && !cue.assignedAudio) return cue;
			changed += 1;
			delete nextWaveforms[cue.id];
			return {
				...cue,
				voiceId: next,
				status:
					cue.status === 'generated' || cue.status === 'error'
						? ('ready' as const)
						: cue.status,
				assignedAudio: null
			};
		});
		if (!changed) return 0;
		ttsWaveforms = nextWaveforms;
		project = touch({ ...project, cues: nextCues });
		return changed;
	},

	/**
	 * Remap session + every cue (+ speaker bank) voices to the active TTS engine
	 * (e.g. Edge Sreymom/Piseth ↔ VoxCPM presets), preserving gender. Clears TTS
	 * so Generate uses the new engine voices.
	 */
	syncVoicesToTtsEngine(engine?: TtsEngineId): { cues: number; speakers: number } {
		const eng = engine ?? getTtsEngineId();
		const nextSession = mapVoiceIdToEngine(voiceId, eng);
		voiceId =
			eng === 'edge-tts' ? voicesStore.ensureVoicePresent(nextSession) : nextSession;
		preferencesStore.setDefaultVoiceId(voiceId);

		let cueCount = 0;
		const nextCues = project.cues.map((cue) => {
			const bank = (project.speakerBank ?? []).find(
				(s) => s.id === (cue.speaker || '').trim()
			);
			const nextVoice = mapVoiceIdToEngine(
				cue.voiceId || voiceId,
				eng,
				bank?.gender ?? null
			);
			const engineOk = voiceMatchesEngine(cue.voiceId, eng);
			const same = engineOk && cue.voiceId === nextVoice;
			if (same && !cue.assignedAudio) return cue;
			cueCount += 1;
			return {
				...cue,
				voiceId: nextVoice,
				status:
					cue.status === 'generated' || cue.status === 'error'
						? ('ready' as const)
						: cue.status,
				assignedAudio: null
			};
		});

		let speakerCount = 0;
		const nextBank = (project.speakerBank ?? []).map((s) => {
			const nextVoice = voiceIdForEngineGender(eng, s.gender);
			if (s.voiceId === nextVoice && voiceMatchesEngine(s.voiceId, eng)) return s;
			speakerCount += 1;
			// Engine switch invalidates VoxCPM preset locks.
			return {
				...s,
				voiceId: nextVoice,
				...(eng !== 'voxcpm' || !voiceMatchesEngine(s.voiceId, eng)
					? { locked: false, refWavPath: '' }
					: {})
			};
		});

		const waveforms: Record<string, number[]> = {};
		project = touch({
			...project,
			cues: nextCues,
			speakerBank: nextBank
		});
		ttsWaveforms = waveforms;
		return { cues: cueCount, speakers: speakerCount };
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
		const n = Number(value);
		if (!Number.isFinite(n)) return;
		pitch = Math.round(Math.max(-6, Math.min(6, n)));
		this.applyProsodyToCues({ pitch });
	},
	setSpeed(value: number) {
		const n = Number(value);
		if (!Number.isFinite(n)) return;
		speed = Math.round(Math.max(0.5, Math.min(1.5, n)) * 100) / 100;
		this.applyProsodyToCues({ speed });
	},
	setVolume(value: number) {
		const n = Number(value);
		if (!Number.isFinite(n)) return;
		volume = Math.round(Math.max(0, Math.min(100, n)));
		this.applyProsodyToCues({ volume });
	},
	/**
	 * Stamp session Prosody onto selected cues (or all cues if none selected)
	 * so Edge-TTS Generate actually uses the right-sidebar sliders.
	 */
	applyProsodyToCues(patch: { pitch?: number; speed?: number; volume?: number }) {
		const ids =
			selectedCueIds.length > 0 ? new Set(selectedCueIds) : new Set(project.cues.map((c) => c.id));
		if (!ids.size) return;
		project = touch(
			{
				...project,
				cues: project.cues.map((cue) => {
					if (!ids.has(cue.id)) return cue;
					return {
						...cue,
						...(typeof patch.pitch === 'number' ? { pitch: patch.pitch } : {}),
						...(typeof patch.speed === 'number' ? { speed: patch.speed } : {}),
						...(typeof patch.volume === 'number' ? { volume: patch.volume } : {})
					};
				})
			},
			{ recordHistory: false }
		);
	},
	/** Push current session Prosody onto selection / all (explicit Apply). */
	stampProsodyToCues(): number {
		const before = selectedCueIds.length || project.cues.length;
		this.applyProsodyToCues({ pitch, speed, volume });
		return before;
	},
	setOriginalAudioGain(value: number) {
		const n = Number(value);
		if (!Number.isFinite(n)) return;
		originalAudioGain = Math.max(0, Math.min(1, n));
	},
	setOriginalAudioMuted(muted: boolean) {
		originalAudioMuted = Boolean(muted);
	},
	toggleOriginalAudioMute() {
		originalAudioMuted = !originalAudioMuted;
	},

	/** Update burn-in / preview subtitle look (font, size, position, look). */
	setSubtitleStyle(patch: Partial<SubtitleStyle>) {
		const cur = project.subtitleStyle ?? { ...DEFAULT_SUBTITLE_STYLE };
		const next: SubtitleStyle = {
			fontFamily:
				typeof patch.fontFamily === 'string' && patch.fontFamily.trim()
					? patch.fontFamily.trim()
					: cur.fontFamily,
			fontFile:
				patch.fontFile !== undefined
					? patch.fontFile
					: (cur.fontFile ?? null),
			fontSizePx: Number.isFinite(Number(patch.fontSizePx))
				? Math.max(12, Math.min(72, Math.round(Number(patch.fontSizePx))))
				: cur.fontSizePx,
			x: Number.isFinite(Number(patch.x))
				? Math.max(0.05, Math.min(0.95, Number(patch.x)))
				: cur.x,
			y: Number.isFinite(Number(patch.y))
				? Math.max(0.03, Math.min(0.97, Number(patch.y)))
				: cur.y,
			look:
				patch.look === 'box' || patch.look === 'outline'
					? patch.look
					: (cur.look ?? DEFAULT_SUBTITLE_STYLE.look),
			maxWidthPct: Number.isFinite(Number(patch.maxWidthPct))
				? Math.max(0.2, Math.min(0.98, Number(patch.maxWidthPct)))
				: (cur.maxWidthPct ?? DEFAULT_SUBTITLE_STYLE.maxWidthPct),
			outlineWidth: Number.isFinite(Number(patch.outlineWidth))
				? Math.max(0, Math.min(5, Number(patch.outlineWidth)))
				: (cur.outlineWidth ?? DEFAULT_SUBTITLE_STYLE.outlineWidth)
		};
		project = touch({ ...project, subtitleStyle: next });
	},

	async generateSelected() {
		// Ensure right-sidebar Prosody is on the cues about to speak.
		this.applyProsodyToCues({ pitch, speed, volume });
		const n = await this.generateCues(selectedCueIds);
		return n;
	},

	/**
	 * Ensure a speaker name from the subtitle dropdown exists in the project bank.
	 * Pulls lock/preset from Saved voices or the vault when available.
	 */
	ensureSpeakerFromTemplate(speakerName: string): boolean {
		const id = speakerName.trim();
		if (!id) return false;
		const bank = [...(project.speakerBank ?? [])];
		if (bank.some((s) => s.id === id)) return true;

		const eng = getTtsEngineId();
		const saved =
			loadSavedVoices().find((v) => v.name.trim() === id) ??
			loadSavedVoices().find((v) => v.id === id);
		const vault = loadSpeakerVault().find((e) => e.id === id);

		let profile: SpeakerVoiceProfile;
		if (saved) {
			profile = {
				id,
				gender: saved.gender,
				voiceId: saved.voiceId,
				locked: Boolean(saved.refWavPath),
				refWavPath: saved.refWavPath || '',
				cueCount: 0
			};
		} else if (vault) {
			profile = {
				id,
				gender: vault.gender,
				voiceId:
					eng === 'voxcpm'
						? matchVoxcpmVoiceToGender(vault.voiceId, vault.gender)
						: vault.voiceId,
				locked: Boolean(vault.locked && vault.refWavPath),
				refWavPath: vault.locked ? vault.refWavPath : '',
				cueCount: 0
			};
		} else {
			profile = {
				id,
				gender: 'neutral',
				voiceId: voiceIdForSpeakerGender('neutral', eng),
				locked: false,
				refWavPath: '',
				cueCount: 0
			};
		}

		bank.push(profile);
		project = {
			...project,
			speakerBank: bank,
			updatedAt: new Date().toISOString()
		};
		isDirty = true;
		persistSpeakerBankToVault(bank);
		return true;
	},

	/**
	 * Manually create Speaker 1..N (no auto-detect). Preserves matching speakers'
	 * gender / preset / lock when the count still includes them.
	 */
	setManualSpeakers(count: number): number {
		const n = Math.max(1, Math.min(8, Math.round(Number(count)) || 1));
		speakersError = null;
		const eng = getTtsEngineId();
		const prevById = new Map(
			mergeBankWithVault(project.speakerBank ?? []).map((s) => [s.id, s] as const)
		);
		const validIds = new Set<string>();

		const bank: SpeakerVoiceProfile[] = [];
		for (let i = 1; i <= n; i++) {
			const id = `Speaker ${i}`;
			validIds.add(id);
			const prev = prevById.get(id);
			const gender: SpeakerVoiceProfile['gender'] =
				prev?.gender === 'male' || prev?.gender === 'female' || prev?.gender === 'neutral'
					? prev.gender
					: i % 2 === 1
						? 'female'
						: 'male';
			const rawVoice = prev?.voiceId || voiceIdForSpeakerGender(gender, eng);
			const nextVoiceId =
				eng === 'voxcpm'
					? matchVoxcpmVoiceToGender(rawVoice, gender)
					: voiceIdForSpeakerGender(gender, eng);
			const keepLock =
				Boolean(prev?.locked && prev.refWavPath) &&
				prev.voiceId === nextVoiceId &&
				prev.gender === gender;
			bank.push({
				id,
				gender,
				voiceId: nextVoiceId,
				locked: keepLock,
				refWavPath: keepLock ? prev!.refWavPath : '',
				cueCount: 0,
				...(prev?.videoRefWavPath ? { videoRefWavPath: prev.videoRefWavPath } : {})
			});
		}

		const defaultId = bank[0]!.id;
		const voiceBySpeaker = new Map(bank.map((s) => [s.id, s.voiceId]));
		const cues = project.cues.map((c) => {
			const raw = (c.speaker || '').trim();
			const spk = raw && validIds.has(raw) ? raw : defaultId;
			const nextVoice = voiceBySpeaker.get(spk) ?? c.voiceId;
			if (spk === (c.speaker || '').trim() && nextVoice === c.voiceId) return c;
			return {
				...c,
				speaker: spk,
				voiceId: nextVoice
			};
		});

		for (const s of bank) {
			s.cueCount = cues.filter((c) => (c.speaker || '').trim() === s.id).length;
		}

		project = touch({
			...project,
			speakerBank: bank,
			cues
		});
		persistSpeakerBankToVault(bank);
		saveProjectToStorage(project);
		// Keep sidebar Voice Selection in sync with Speaker 1.
		const lead = bank[0]?.voiceId;
		if (lead) {
			voiceId = migrateVoiceId(lead);
			preferencesStore.setDefaultVoiceId(voiceId);
		}
		return bank.length;
	},

	/**
	 * Push current speaker-bank voices onto matching cues (and remap unknown
	 * speakers to Speaker 1). Used by Done so closing the dialog always applies.
	 */
	applySpeakerBankToCues(): number {
		const bank = [...(project.speakerBank ?? [])];
		if (!bank.length) return 0;
		const validIds = new Set(bank.map((s) => s.id));
		const defaultId = bank[0]!.id;
		const voiceBySpeaker = new Map(bank.map((s) => [s.id, s.voiceId]));
		let changed = 0;
		const cueIdsClear: string[] = [];
		const cues = project.cues.map((c) => {
			const raw = (c.speaker || '').trim();
			const spk = raw && validIds.has(raw) ? raw : defaultId;
			const nextVoice = voiceBySpeaker.get(spk) ?? c.voiceId;
			if (spk === (c.speaker || '').trim() && nextVoice === c.voiceId) return c;
			changed += 1;
			const next = { ...c, speaker: spk, voiceId: nextVoice };
			if (c.assignedAudio && (spk !== raw || nextVoice !== c.voiceId)) {
				next.assignedAudio = null;
				if (next.status === 'generated' || next.status === 'error') {
					next.status = 'ready';
				}
				cueIdsClear.push(c.id);
			}
			return next;
		});
		for (const s of bank) {
			s.cueCount = cues.filter((c) => (c.speaker || '').trim() === s.id).length;
		}
		if (changed || bank.some((s, i) => s.cueCount !== (project.speakerBank?.[i]?.cueCount ?? -1))) {
			project = touch({ ...project, speakerBank: bank, cues });
			if (cueIdsClear.length) dropTtsWaveforms(cueIdsClear);
			saveProjectToStorage(project);
			persistSpeakerBankToVault(bank);
		}
		const lead = bank[0]?.voiceId;
		if (lead) {
			voiceId = migrateVoiceId(lead);
			preferencesStore.setDefaultVoiceId(voiceId);
		}
		return changed;
	},

	/**
	 * Commit speaker count + push bank voices onto cues (Engine dialog Done).
	 */
	commitSpeakers(count?: number): number {
		const n =
			typeof count === 'number' && Number.isFinite(count)
				? Math.max(1, Math.min(8, Math.round(count)))
				: Math.max(1, project.speakerBank?.length || 1);
		const bankLen = project.speakerBank?.length ?? 0;
		if (!bankLen || bankLen !== n) {
			return this.setManualSpeakers(n);
		}
		this.applySpeakerBankToCues();
		return bankLen;
	},

	/**
	 * Cluster ASR cues into Speaker 1..N (neural embeddings), estimate gender,
	 * and assign cues. Prefer setManualSpeakers for the Studio UI.
	 */
	async detectSpeakers(opts?: { maxSpeakers?: number }): Promise<number> {
		if (speakersDetecting) return 0;
		if (!isTauriRuntime()) {
			speakersError = 'Speaker detect runs in the desktop app only.';
			return 0;
		}
		const path = this.videoPath?.trim() || this.videoAsset?.path?.trim() || '';
		if (!path) {
			speakersError = 'Load a video first.';
			return 0;
		}
		if (!project.cues.length) {
			speakersError = 'Extract Subs first so cues have timing.';
			return 0;
		}

		speakersDetecting = true;
		speakersError = null;
		try {
			// Free VRAM — diarization + VoxCPM won't both fit on 8GB.
			try {
				const { invoke } = await import('@tauri-apps/api/core');
				await invoke('stop_voxcpm_server').catch(() => undefined);
			} catch {
				/* optional */
			}

			const { invoke } = await import('@tauri-apps/api/core');
			const result = await invoke<{
				ok: boolean;
				speakerCount: number;
				message: string;
				speakers: Array<{
					id: string;
					gender: string;
					refWavPath?: string;
					videoRefWavPath?: string;
					cueCount: number;
				}>;
				assignments: Array<{ cueId: string; speaker: string }>;
			}>('detect_speakers', {
				args: {
					videoPath: path,
					projectId: project.id,
					maxSpeakers: opts?.maxSpeakers ?? 0,
					cues: project.cues.map((c) => ({
						id: c.id,
						startMs: c.startMs,
						endMs: c.endMs
					}))
				}
			});

			const prevById = new Map(
				(project.speakerBank ?? []).map((s) => [s.id, s] as const)
			);
			const eng = getTtsEngineId();

			const bank: SpeakerVoiceProfile[] = (result.speakers ?? []).map((s) => {
				const detected =
					s.gender === 'male' || s.gender === 'female' ? s.gender : ('neutral' as const);
				const prev = prevById.get(s.id);
				// Keep the user's boy/girl choice across Detect / rebuild when Speaker N survives.
				const gender =
					prev?.gender === 'male' || prev?.gender === 'female' ? prev.gender : detected;
				const videoRef =
					(s.videoRefWavPath ?? s.refWavPath ?? '').trim() || undefined;
				const rawVoice = prev?.voiceId || voiceIdForSpeakerGender(gender, eng);
				const voiceId =
					eng === 'voxcpm'
						? matchVoxcpmVoiceToGender(rawVoice, gender)
						: voiceIdForSpeakerGender(gender, eng);
				return {
					id: s.id,
					gender,
					refWavPath: '',
					locked: false,
					cueCount: s.cueCount,
					voiceId,
					...(videoRef ? { videoRefWavPath: videoRef } : {})
				};
			});
			const byCue = new Map(result.assignments.map((a) => [a.cueId, a.speaker]));
			const voiceBySpeaker = new Map(bank.map((s) => [s.id, s.voiceId]));

			project = touch({
				...project,
				speakerBank: bank,
				cues: project.cues.map((c) => {
					const spk = byCue.get(c.id) ?? c.speaker ?? 'Speaker 1';
					return {
						...c,
						speaker: spk,
						voiceId: voiceBySpeaker.get(spk) ?? c.voiceId,
						assignedAudio: null,
						status:
							c.status === 'generated' || c.status === 'error'
								? ('ready' as const)
								: c.status
					};
				})
			});
			saveProjectToStorage(project);
			return bank.length;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			speakersError = msg;
			return 0;
		} finally {
			speakersDetecting = false;
		}
	},

	/** Rename / gender / preset for a speaker bank entry; syncs matching cues. */
	updateSpeaker(
		speakerId: string,
		patch: Partial<Pick<SpeakerVoiceProfile, 'id' | 'gender' | 'voiceId'>>
	): boolean {
		const id = speakerId.trim();
		if (!id) return false;
		const bank = [...(project.speakerBank ?? [])];
		const idx = bank.findIndex((s) => s.id === id);
		if (idx < 0) return false;
		const prev = bank[idx]!;
		let nextId = prev.id;
		if (typeof patch.id === 'string') {
			const renamed = patch.id.trim();
			if (!renamed) return false;
			if (renamed !== prev.id && bank.some((s) => s.id === renamed)) return false;
			nextId = renamed;
		}
		const gender =
			patch.gender === 'male' || patch.gender === 'female' || patch.gender === 'neutral'
				? patch.gender
				: prev.gender;
		let nextVoice =
			typeof patch.voiceId === 'string' && patch.voiceId.trim()
				? patch.voiceId.trim()
				: prev.voiceId;

		if (patch.gender && patch.gender !== prev.gender) {
			nextVoice =
				getTtsEngineId() === 'voxcpm'
					? matchVoxcpmVoiceToGender(patch.voiceId || prev.voiceId, gender)
					: voiceIdForSpeakerGender(gender, getTtsEngineId());
		} else if (typeof patch.voiceId === 'string' && patch.voiceId.trim()) {
			if (getTtsEngineId() === 'voxcpm' && (gender === 'male' || gender === 'female')) {
				nextVoice = matchVoxcpmVoiceToGender(patch.voiceId, gender);
			}
		}

		const genderChanged = gender !== prev.gender;
		const voiceChanged = nextVoice !== prev.voiceId;
		const renamed = nextId !== prev.id;
		bank[idx] = {
			...prev,
			id: nextId,
			gender,
			voiceId: nextVoice,
			// Changing preset/gender invalidates a previous lock sample.
			...(genderChanged || voiceChanged
				? { locked: false, refWavPath: '' }
				: {})
		};
		project = touch({
			...project,
			speakerBank: bank,
			cues: project.cues.map((c) => {
				if ((c.speaker || '').trim() !== prev.id) return c;
				const next = {
					...c,
					speaker: nextId,
					voiceId: nextVoice
				};
				if ((renamed || voiceChanged || genderChanged) && c.assignedAudio) {
					next.assignedAudio = null;
					if (next.status === 'generated' || next.status === 'error') {
						next.status = 'ready';
					}
					dropTtsWaveforms([c.id]);
				}
				return next;
			})
		});
		if (renamed) renameSpeakerInVault(prev.id, nextId);
		saveProjectToStorage(project);
		persistSpeakerBankToVault(project.speakerBank ?? []);
		return true;
	},

	/**
	 * Lock a speaker to a Khmer clone sample.
	 * Prefers the exact WAV from the last Preview for that preset (VoxCPM design
	 * voices are non-deterministic — re-generating would sound different).
	 */
	async lockSpeakerVoice(
		speakerId: string,
		opts?: { sourceWavPath?: string }
	): Promise<boolean> {
		const id = speakerId.trim();
		const bank = (project.speakerBank ?? []).find((s) => s.id === id);
		if (!bank) {
			speakersError = 'Speaker not found — set speakers first.';
			return false;
		}
		if (!isTauriRuntime()) {
			speakersError = 'Voice lock requires the desktop app.';
			return false;
		}
		if (getTtsEngineId() !== 'voxcpm') {
			speakersError = 'Switch TTS engine to VoxCPM2 to lock a voice.';
			return false;
		}
		if (speakersLockingId) return false;

		speakersLockingId = id;
		speakersError = null;
		try {
			const usedVoiceId =
				bank.gender === 'male' || bank.gender === 'female'
					? matchVoxcpmVoiceToGender(bank.voiceId, bank.gender)
					: resolveVoxcpmVoiceId(bank.voiceId, voiceId);

			const { getLastVoxcpmPreviewPath, VOXCPM_LOCK_SAMPLE_TEXT } = await import(
				'$lib/tts/voice-preview'
			);
			let sourcePath = (opts?.sourceWavPath ?? '').trim();
			if (!sourcePath) {
				sourcePath = getLastVoxcpmPreviewPath(usedVoiceId)?.trim() || '';
			}

			// No matching preview → synthesize with the same line/params as Preview.
			if (!sourcePath) {
				const engine = getTtsEngine();
				const result = await engine.synthesize({
					cueId: `lock-${Date.now()}-${id.replace(/[^\w.-]+/g, '_')}`,
					text: VOXCPM_LOCK_SAMPLE_TEXT,
					voiceId: usedVoiceId,
					pitch: 0,
					speed: 1,
					volume: 100,
					language: 'km'
				});
				if (!result.filePath || !result.byteLength) {
					throw new Error('Lock sample was empty — is VoxCPM2 started?');
				}
				sourcePath = result.filePath;
			}

			const { invoke } = await import('@tauri-apps/api/core');
			const saved = await invoke<{ filePath: string }>('save_speaker_lock_wav', {
				args: {
					projectId: project.id,
					speakerId: id,
					sourcePath
				}
			});

			const nextBank = (project.speakerBank ?? []).map((s) =>
				s.id === id
					? {
							...s,
							voiceId: usedVoiceId,
							refWavPath: saved.filePath,
							locked: true
						}
					: s
			);
			const cueIds: string[] = [];
			project = touch({
				...project,
				speakerBank: nextBank,
				cues: project.cues.map((c) => {
					if ((c.speaker || '').trim() !== id) return c;
					cueIds.push(c.id);
					return {
						...c,
						voiceId: usedVoiceId,
						assignedAudio: null,
						status:
							c.status === 'generated' || c.status === 'error'
								? ('ready' as const)
								: c.status
					};
				})
			});
			if (cueIds.length) dropTtsWaveforms(cueIds);
			saveProjectToStorage(project);
			persistSpeakerBankToVault(project.speakerBank ?? []);
			upsertSavedVoice({
				name: id,
				gender: bank.gender,
				voiceId: usedVoiceId,
				refWavPath: saved.filePath
			});
			savedVoicesTick += 1;
			return true;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			speakersError = msg;
			return false;
		} finally {
			speakersLockingId = null;
		}
	},

	/**
	 * Apply a loved voice from the library onto a speaker slot (one click).
	 * Renames the slot to the saved voice name when free, so the table shows
	 * “Hong_Kong_TVB_3” instead of staying on “Speaker 1”.
	 * Returns the speaker id after apply (may be renamed), or null on failure.
	 */
	applySavedVoice(speakerId: string, savedVoiceId: string): string | null {
		const id = speakerId.trim();
		const saved = getSavedVoice(savedVoiceId);
		if (!saved) {
			speakersError = 'Saved voice not found.';
			return null;
		}
		const bank = [...(project.speakerBank ?? [])];
		const idx = bank.findIndex((s) => s.id === id);
		if (idx < 0) {
			speakersError = 'Speaker not found — set speakers first.';
			return null;
		}
		const prev = bank[idx]!;
		const wantedName = saved.name.trim() || prev.id;
		const nameTaken =
			wantedName !== prev.id && bank.some((s, i) => i !== idx && s.id === wantedName);
		const nextId = nameTaken ? prev.id : wantedName;

		const cueIds: string[] = [];
		const cues = project.cues.map((c) => {
			if ((c.speaker || '').trim() !== id) return c;
			cueIds.push(c.id);
			return {
				...c,
				speaker: nextId,
				voiceId: saved.voiceId,
				assignedAudio: null,
				status:
					c.status === 'generated' || c.status === 'error'
						? ('ready' as const)
						: c.status
			};
		});

		bank[idx] = {
			...prev,
			id: nextId,
			gender: saved.gender,
			voiceId: saved.voiceId,
			locked: true,
			refWavPath: saved.refWavPath,
			cueCount: cues.filter((c) => (c.speaker || '').trim() === nextId).length
		};

		project = touch({
			...project,
			speakerBank: bank,
			cues
		});
		if (cueIds.length) dropTtsWaveforms(cueIds);
		if (nextId !== id) renameSpeakerInVault(id, nextId);
		saveProjectToStorage(project);
		persistSpeakerBankToVault(project.speakerBank ?? []);
		speakersError = null;
		return nextId;
	},

	removeSavedVoice(savedVoiceId: string): boolean {
		const ok = deleteSavedVoice(savedVoiceId);
		if (ok) savedVoicesTick += 1;
		return ok;
	},

	/** Restore locked speakers from the vault into this project (e.g. Engine open). */
	restoreSpeakersFromVault(): number {
		const vault = speakerBankFromVault();
		if (!vault.length) return 0;
		const eng = getTtsEngineId();
		const bank = vault.map((s) => {
			const voiceId =
				eng === 'voxcpm'
					? matchVoxcpmVoiceToGender(s.voiceId, s.gender)
					: s.voiceId;
			return {
				...s,
				voiceId,
				cueCount: project.cues.filter((c) => (c.speaker || '').trim() === s.id).length
			};
		});
		// Backfill loved-voice library from existing vault locks (one-time migrate feel).
		for (const s of bank) {
			if (s.locked && s.refWavPath) {
				upsertSavedVoice({
					name: s.id,
					gender: s.gender,
					voiceId: s.voiceId,
					refWavPath: s.refWavPath
				});
			}
		}
		savedVoicesTick += 1;
		const validIds = new Set(bank.map((s) => s.id));
		const defaultId = bank[0]!.id;
		const voiceBySpeaker = new Map(bank.map((s) => [s.id, s.voiceId]));
		project = touch({
			...project,
			speakerBank: bank,
			cues: project.cues.map((c) => {
				const raw = (c.speaker || '').trim();
				const spk = raw && validIds.has(raw) ? raw : defaultId;
				return {
					...c,
					speaker: spk,
					voiceId: voiceBySpeaker.get(spk) ?? c.voiceId
				};
			})
		});
		saveProjectToStorage(project);
		persistSpeakerBankToVault(bank);
		return bank.length;
	},

	clearSpeakerLock(speakerId: string): boolean {
		const id = speakerId.trim();
		const bank = project.speakerBank ?? [];
		if (!bank.some((s) => s.id === id)) return false;
		const cueIds: string[] = [];
		project = touch({
			...project,
			speakerBank: bank.map((s) =>
				s.id === id
					? {
							...s,
							locked: false,
							refWavPath: '',
							videoRefWavPath: undefined
						}
					: s
			),
			cues: project.cues.map((c) => {
				if ((c.speaker || '').trim() !== id || !c.assignedAudio) return c;
				cueIds.push(c.id);
				return {
					...c,
					assignedAudio: null,
					status:
						c.status === 'generated' || c.status === 'error'
							? ('ready' as const)
							: c.status
				};
			})
		});
		if (cueIds.length) dropTtsWaveforms(cueIds);
		saveProjectToStorage(project);
		clearSpeakerLockInVault(id);
		persistSpeakerBankToVault(project.speakerBank ?? []);
		return true;
	},

	selectTitleLiver(id: string | null) {
		selectedTitleLiverId = id;
		if (id) rightCollapsed = false;
	},

	/**
	 * Add a Title Liver clip at the playhead (or given start). Selects it.
	 */
	addTitleLiverClip(opts?: {
		templateId?: TitleLiverTemplateId;
		startMs?: number;
		durationMs?: number;
		line1?: string;
		line2?: string;
	}): TitleLiverClip {
		const start =
			typeof opts?.startMs === 'number'
				? Math.max(0, Math.round(opts.startMs))
				: Math.max(0, Math.round(playback.playheadMs));
		const dur = Math.max(800, Math.round(opts?.durationMs ?? 4000));
		const end = Math.min(
			Math.max(start + dur, start + 800),
			Math.max(project.durationMs || start + dur, start + dur)
		);
		const clip = createTitleLiverClip({
			templateId: opts?.templateId ?? 'soft-bar',
			startMs: start,
			endMs: end,
			line1: opts?.line1,
			line2: opts?.line2
		});
		project = touch({
			...project,
			titleLiverClips: [...(project.titleLiverClips ?? []), clip]
		});
		selectedTitleLiverId = clip.id;
		rightCollapsed = false;
		return clip;
	},

	updateTitleLiverClip(
		id: string,
		patch: Partial<Omit<TitleLiverClip, 'id'>>
	): boolean {
		const clips = [...(project.titleLiverClips ?? [])];
		const idx = clips.findIndex((c) => c.id === id);
		if (idx < 0) return false;
		const prev = clips[idx]!;
		let startMs =
			typeof patch.startMs === 'number' ? Math.max(0, Math.round(patch.startMs)) : prev.startMs;
		let endMs =
			typeof patch.endMs === 'number' ? Math.max(0, Math.round(patch.endMs)) : prev.endMs;
		if (endMs < startMs + 400) endMs = startMs + 400;
		clips[idx] = {
			...prev,
			...patch,
			startMs,
			endMs,
			line1: typeof patch.line1 === 'string' ? patch.line1 : prev.line1,
			line2: typeof patch.line2 === 'string' ? patch.line2 : prev.line2,
			line3: typeof patch.line3 === 'string' ? patch.line3 : (prev.line3 ?? ''),
			accent:
				typeof patch.accent === 'string' && patch.accent.trim()
					? patch.accent.trim()
					: prev.accent,
			templateId: patch.templateId ?? prev.templateId,
			x:
				typeof patch.x === 'number' && Number.isFinite(patch.x)
					? Math.max(0.02, Math.min(0.98, patch.x))
					: (prev.x ?? 0.5),
			y:
				typeof patch.y === 'number' && Number.isFinite(patch.y)
					? Math.max(0.02, Math.min(0.98, patch.y))
					: (prev.y ?? 0.82),
			fontFamily:
				typeof patch.fontFamily === 'string' && patch.fontFamily.trim()
					? patch.fontFamily.trim()
					: (prev.fontFamily || 'Noto Sans Khmer'),
			fontFile:
				patch.fontFile !== undefined ? patch.fontFile : (prev.fontFile ?? null),
			fontSizePx:
				typeof patch.fontSizePx === 'number' && Number.isFinite(patch.fontSizePx)
					? Math.max(10, Math.min(96, Math.round(patch.fontSizePx)))
					: (prev.fontSizePx ?? 22),
			outlineWidth:
				typeof patch.outlineWidth === 'number' && Number.isFinite(patch.outlineWidth)
					? Math.max(0, Math.min(5, patch.outlineWidth))
					: (prev.outlineWidth ?? 1.25),
			scale:
				typeof patch.scale === 'number' && Number.isFinite(patch.scale)
					? Math.max(0.5, Math.min(2, patch.scale))
					: (prev.scale ?? 1),
			maxWidthPct:
				typeof patch.maxWidthPct === 'number' && Number.isFinite(patch.maxWidthPct)
					? Math.max(0.25, Math.min(0.98, patch.maxWidthPct))
					: (prev.maxWidthPct ?? 0.92)
		};
		project = touch({ ...project, titleLiverClips: clips });
		return true;
	},

	duplicateTitleLiverClip(id?: string | null): TitleLiverClip | null {
		const srcId = id ?? selectedTitleLiverId;
		if (!srcId) return null;
		const src = (project.titleLiverClips ?? []).find((c) => c.id === srcId);
		if (!src) return null;
		const dur = Math.max(400, src.endMs - src.startMs);
		const start = Math.max(0, src.endMs + 120);
		const { id: _omit, ...rest } = src;
		const clip = createTitleLiverClip({
			...rest,
			startMs: start,
			endMs: start + dur
		});
		project = touch({
			...project,
			titleLiverClips: [...(project.titleLiverClips ?? []), clip]
		});
		selectedTitleLiverId = clip.id;
		rightCollapsed = false;
		return clip;
	},

	nudgeTitleLiver(id: string | null | undefined, dx: number, dy: number): boolean {
		const srcId = id ?? selectedTitleLiverId;
		if (!srcId) return false;
		const src = (project.titleLiverClips ?? []).find((c) => c.id === srcId);
		if (!src) return false;
		return this.updateTitleLiverClip(srcId, {
			x: (src.x ?? 0.5) + dx,
			y: (src.y ?? 0.82) + dy
		});
	},

	applyTitleLiverPreset(presetId: string, atMs?: number): number {
		const preset = TITLE_LIVER_PRESETS.find((p) => p.id === presetId);
		if (!preset) return 0;
		const base =
			typeof atMs === 'number' && Number.isFinite(atMs)
				? Math.max(0, Math.round(atMs))
				: Math.max(0, Math.round(playback.playheadMs));
		const added: TitleLiverClip[] = [];
		for (const spec of preset.clips) {
			added.push(
				createTitleLiverClip({
					templateId: spec.templateId,
					startMs: base + spec.offsetMs,
					endMs: base + spec.offsetMs + spec.durationMs,
					line1: spec.line1,
					line2: spec.line2,
					line3: spec.line3
				})
			);
		}
		if (!added.length) return 0;
		project = touch({
			...project,
			titleLiverClips: [...(project.titleLiverClips ?? []), ...added]
		});
		selectedTitleLiverId = added[0]!.id;
		rightCollapsed = false;
		return added.length;
	},

	removeTitleLiverClip(id: string): boolean {
		const clips = project.titleLiverClips ?? [];
		if (!clips.some((c) => c.id === id)) return false;
		project = touch({
			...project,
			titleLiverClips: clips.filter((c) => c.id !== id)
		});
		if (selectedTitleLiverId === id) selectedTitleLiverId = null;
		return true;
	},

	moveTitleLiverTiming(id: string, startMs: number): boolean {
		const clip = (project.titleLiverClips ?? []).find((c) => c.id === id);
		if (!clip) return false;
		const dur = Math.max(400, clip.endMs - clip.startMs);
		const start = Math.max(0, Math.round(startMs));
		return this.updateTitleLiverClip(id, { startMs: start, endMs: start + dur });
	},

	trimTitleLiverEdge(id: string, edge: 'start' | 'end', ms: number): boolean {
		const clip = (project.titleLiverClips ?? []).find((c) => c.id === id);
		if (!clip) return false;
		const minDur = 400;
		if (edge === 'start') {
			const start = Math.max(0, Math.min(clip.endMs - minDur, Math.round(ms)));
			return this.updateTitleLiverClip(id, { startMs: start });
		}
		const end = Math.max(clip.startMs + minDur, Math.round(ms));
		return this.updateTitleLiverClip(id, { endMs: end });
	},

	get dubOverhangMs() {
		const media =
			originalAudio.durationMs > 1000
				? originalAudio.durationMs
				: (project.assets.find((a) => a.id === project.videoAssetId)?.durationMs ?? 0);
		const videoMs = media > 1000 ? media : project.durationMs;
		const content = this.contentEndMs();
		if (videoMs < 500 || content < 500) return 0;
		return Math.max(0, content - videoMs);
	}
};
