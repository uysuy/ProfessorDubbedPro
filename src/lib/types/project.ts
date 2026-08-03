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
