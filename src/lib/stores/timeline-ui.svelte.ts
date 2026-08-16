/**
 * Timeline chrome: Arrange mode, track eye/solo, snap, edit tool.
 * Resolve/Premiere-inspired controls for pre-TTS subtitle alignment.
 */

import type { TimelineTrackKind } from '$lib/utils/timeline';

export type TimelineTool = 'select' | 'blade';

type TrackFlags = Record<TimelineTrackKind, boolean>;

const ALL_VISIBLE: TrackFlags = {
	titleLiver: true,
	video: true,
	subtitles: true,
	tts: true,
	original: true
};

const NO_SOLO: TrackFlags = {
	titleLiver: false,
	video: false,
	subtitles: false,
	tts: false,
	original: false
};

let arrangeMode = $state(false);
let snapEnabled = $state(true);
let tool = $state<TimelineTool>('select');
let visibility = $state<TrackFlags>({ ...ALL_VISIBLE });
let solo = $state<TrackFlags>({ ...NO_SOLO });
let locked = $state<TrackFlags>({ ...NO_SOLO });

function anySolo(): boolean {
	return (
		solo.titleLiver || solo.video || solo.subtitles || solo.tts || solo.original
	);
}

export const timelineUi = {
	get arrangeMode() {
		return arrangeMode;
	},
	get snapEnabled() {
		return snapEnabled;
	},
	set snapEnabled(v: boolean) {
		snapEnabled = Boolean(v);
	},
	toggleSnap() {
		snapEnabled = !snapEnabled;
		return snapEnabled;
	},

	get tool() {
		return tool;
	},
	set tool(v: TimelineTool) {
		tool = v === 'blade' ? 'blade' : 'select';
	},
	setTool(v: TimelineTool) {
		tool = v === 'blade' ? 'blade' : 'select';
		return tool;
	},

	get visibility() {
		return visibility;
	},
	get solo() {
		return solo;
	},
	get locked() {
		return locked;
	},

	isTrackShown(kind: TimelineTrackKind): boolean {
		if (!visibility[kind]) return false;
		if (anySolo() && !solo[kind]) return false;
		return true;
	},

	isTrackLocked(kind: TimelineTrackKind): boolean {
		return Boolean(locked[kind]);
	},

	toggleVisible(kind: TimelineTrackKind) {
		visibility = { ...visibility, [kind]: !visibility[kind] };
		// Turning a track off clears its solo so we don't end up with empty timeline.
		if (!visibility[kind] && solo[kind]) {
			solo = { ...solo, [kind]: false };
		}
	},

	toggleLocked(kind: TimelineTrackKind) {
		locked = { ...locked, [kind]: !locked[kind] };
	},

	toggleSolo(kind: TimelineTrackKind) {
		const next = !solo[kind];
		solo = { ...solo, [kind]: next };
		if (next && !visibility[kind]) {
			visibility = { ...visibility, [kind]: true };
		}
	},

	/** Resolve-like arrange: hide TTS, keep Title Liver + Video + Subs + Original. */
	enterArrangeMode() {
		arrangeMode = true;
		visibility = {
			titleLiver: true,
			video: true,
			subtitles: true,
			tts: false,
			original: true
		};
		solo = {
			titleLiver: true,
			video: true,
			subtitles: true,
			tts: false,
			original: true
		};
		snapEnabled = true;
		tool = 'select';
		return true;
	},

	exitArrangeMode() {
		arrangeMode = false;
		visibility = { ...ALL_VISIBLE };
		solo = { ...NO_SOLO };
		tool = 'select';
		return false;
	},

	toggleArrangeMode() {
		if (arrangeMode) return this.exitArrangeMode();
		return this.enterArrangeMode();
	},

	/** Taller picture + Subs + Original while arranging. */
	trackHeight(kind: TimelineTrackKind, base: number): number {
		if (!arrangeMode) return base;
		if (kind === 'video') return Math.max(base, 88);
		if (kind === 'subtitles') return Math.max(base, 88);
		if (kind === 'original') return Math.max(base, 100);
		return base;
	}
};
