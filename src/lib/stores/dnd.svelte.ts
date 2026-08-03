export type DndKind = 'cue-reorder' | 'tts-audio' | 'files';

export type DropEdge = 'before' | 'after' | 'onto';

export const MIME_CUE_REORDER = 'application/x-pdp-cue-reorder';
export const MIME_TTS_AUDIO = 'application/x-pdp-tts-audio';

export { classifyMediaFile, isFileDrag } from '$lib/utils/media';

type DragPayload = {
	kind: DndKind;
	id: string;
	label: string;
	subtitle?: string;
};

type DropTarget = {
	cueId: string;
	edge: DropEdge;
};

let drag = $state<DragPayload | null>(null);
let pointer = $state({ x: 0, y: 0 });
let dropTarget = $state<DropTarget | null>(null);
let fileHover = $state(false);
let feedback = $state<string | null>(null);
let feedbackTimer: ReturnType<typeof setTimeout> | null = null;

function clearFeedbackTimer() {
	if (feedbackTimer) {
		clearTimeout(feedbackTimer);
		feedbackTimer = null;
	}
}

export const dndStore = {
	get drag() {
		return drag;
	},
	get pointer() {
		return pointer;
	},
	get dropTarget() {
		return dropTarget;
	},
	get fileHover() {
		return fileHover;
	},
	get feedback() {
		return feedback;
	},
	get isDragging() {
		return drag != null || fileHover;
	},
	start(payload: DragPayload, x: number, y: number) {
		drag = payload;
		pointer = { x, y };
		dropTarget = null;
	},
	move(x: number, y: number) {
		pointer = { x, y };
	},
	setDropTarget(next: DropTarget | null) {
		dropTarget = next;
	},
	setFileHover(active: boolean) {
		fileHover = active;
	},
	end() {
		drag = null;
		dropTarget = null;
		fileHover = false;
	},
	flash(message: string) {
		clearFeedbackTimer();
		feedback = message;
		feedbackTimer = setTimeout(() => {
			feedback = null;
			feedbackTimer = null;
		}, 2200);
	}
};

