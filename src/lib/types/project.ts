export interface SubtitleCue {
	id: string;
	index: number;
	startMs: number;
	endMs: number;
	source: string;
	translation: string;
	speaker: string;
	pitch: number;
	speed: number;
	volume: number;
	voiceId: string;
	status: 'draft' | 'ready' | 'generated' | 'error';
	/** TTS / assigned audio clip on the TTS track. */
	assignedAudio?: {
		sourceCueId: string;
		label: string;
		/** True when created by generate (not only drag-assign). */
		generated?: boolean;
		/** Absolute path to generated audio (Edge-TTS MP3). */
		filePath?: string | null;
		/** convertFileSrc / blob URL for waveform & playback. */
		url?: string | null;
		durationMs?: number;
		engine?: string;
		/**
		 * Extra Web Audio rate so speech finishes inside the video cue window.
		 * 1 = natural length; >1 = lip-sync squeeze.
		 */
		fitPlaybackRate?: number;
	} | null;
}

export type MediaKind = 'video' | 'audio' | 'subtitle';

export type TrackRole = 'picture' | 'dialogue' | 'dub' | 'music' | 'sfx' | 'reference';

export interface Timecode {
	hours: number;
	minutes: number;
	seconds: number;
	frames: number;
	fps: number;
}

export interface MediaAsset {
	id: string;
	name: string;
	kind: MediaKind;
	path: string;
	durationMs: number;
	createdAt: string;
}

export interface DubbingTrack {
	id: string;
	name: string;
	role: TrackRole;
	language: string;
	muted: boolean;
	solo: boolean;
	locked: boolean;
	volumeDb: number;
}

/** On-video / burn-in subtitle look — preview and export must match. */
export type SubtitleLook = 'box' | 'outline';

export type SubtitleStyle = {
	/** ASS / CSS font family name, e.g. "Khmer OS", "Noto Sans Khmer". */
	fontFamily: string;
	/** Absolute TTF/OTF path when known (export copies into fontsdir). */
	fontFile?: string | null;
	/**
	 * Design font size in px as if the picture were 720px tall.
	 * Preview and burn-in both scale by pictureHeight / 720.
	 */
	fontSizePx: number;
	/** Anchor X of the subtitle box, 0 = left … 1 = right. */
	x: number;
	/** Anchor Y of the subtitle box, 0 = top … 1 = bottom. */
	y: number;
	/**
	 * `outline` = white text + black stroke (like many Chinese burn-ins).
	 * `box` = translucent background plate behind text.
	 */
	look: SubtitleLook;
	/** Max width of the subtitle block as a fraction of the video frame (0.2–0.98). */
	maxWidthPct: number;
	/**
	 * Black outline thickness in design px (at 720p tall). 0 = none.
	 * Only applies when `look === 'outline'`.
	 */
	outlineWidth: number;
};

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
	fontFamily: 'Noto Sans Khmer',
	fontFile: null,
	fontSizePx: 20,
	x: 0.5,
	y: 0.84,
	look: 'outline',
	maxWidthPct: 0.96,
	outlineWidth: 1
};

export interface DubbingProject {
	id: string;
	name: string;
	sourceLanguage: string;
	targetLanguage: string;
	fps: number;
	durationMs: number;
	/** Active source video asset id (if any). */
	videoAssetId: string | null;
	assets: MediaAsset[];
	tracks: DubbingTrack[];
	cues: SubtitleCue[];
	/** Burn-in / preview subtitle appearance. */
	subtitleStyle: SubtitleStyle;
	updatedAt: string;
}

export interface VoiceProfile {
	id: string;
	name: string;
	language: string;
	style: string;
	gender: 'female' | 'male' | 'neutral';
	type: 'Neural' | 'Studio' | 'Ready';
	/** Microsoft Edge short voice name for Khmer (when available). */
	edgeVoiceKm?: string;
	/** Microsoft Edge short voice name for English. */
	edgeVoiceEn?: string;
}
