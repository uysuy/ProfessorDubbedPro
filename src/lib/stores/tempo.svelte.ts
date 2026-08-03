import { projectStore } from '$lib/stores/project.svelte';
import { dndStore } from '$lib/stores/dnd.svelte';
import {
	cancelVideoTempo,
	computeFitToDubTempo,
	runVideoTempoRemaster,
	type FitToDubPlan,
	type VideoTempoProgress
} from '$lib/utils/video-tempo';
import { cueAudioEndMs } from '$lib/utils/tts-fit';
import { isTauriRuntime } from '$lib/utils/platform';
import { formatClock } from '$lib/utils/time';

let isRemastering = $state(false);
let progress = $state(0);
let message = $state('');
let error = $state<string | null>(null);
let tempoFactor = $state(0.92);

const TEMPO_PRESETS = [0.8, 0.85, 0.9, 0.92, 0.95, 1] as const;

function onProgress(p: VideoTempoProgress) {
	progress = Math.max(0, Math.min(100, Math.round(p.percent)));
	message = p.message || p.stage;
}

/**
 * True media length of the source video — NOT project.durationMs.
 * Project duration often grows when Khmer TTS extends cues past the picture,
 * which would hide "Fit video to dub" (alreadyFits).
 */
function videoDurationMs(): number {
	// Waveform is extracted from the real file — most reliable when ready.
	const fromWave = projectStore.originalAudio.durationMs;
	if (fromWave > 1000) return fromWave;

	const fromAsset = projectStore.videoAsset?.durationMs ?? 0;
	if (fromAsset > 1000) return fromAsset;

	return projectStore.current.durationMs;
}

function dubContentEndMs(): number {
	const cues = projectStore.current.cues;
	if (!cues.length) return 0;
	let max = 0;
	for (const cue of cues) {
		max = Math.max(max, cueAudioEndMs(cue), cue.endMs);
	}
	return max;
}

/** Overhang of dub past true media (ms). Positive ⇒ Fit is useful. */
function dubOverhangMs(): number {
	const videoMs = videoDurationMs();
	const contentMs = dubContentEndMs();
	if (videoMs < 500 || contentMs < 500) return 0;
	return Math.max(0, contentMs - videoMs);
}

export const tempoStore = {
	get isRemastering() {
		return isRemastering;
	},
	get progress() {
		return progress;
	},
	get message() {
		return message;
	},
	get error() {
		return error;
	},
	get tempoFactor() {
		return tempoFactor;
	},
	get presets() {
		return TEMPO_PRESETS;
	},

	/** Live preview of fit-to-dub math (null when no video/cues). */
	get fitToDubPlan(): FitToDubPlan | null {
		const videoMs = videoDurationMs();
		const contentMs = dubContentEndMs();
		if (videoMs < 500 || contentMs < 500) return null;
		return computeFitToDubTempo({ videoMs, contentMs });
	},

	get dubOverhangMs() {
		return dubOverhangMs();
	},

	/** True media length used for fit math (waveform / asset). */
	get mediaDurationMs() {
		return videoDurationMs();
	},

	get contentEndMs() {
		return dubContentEndMs();
	},

	setTempoFactor(v: number) {
		const n = Number(v);
		if (!Number.isFinite(n)) return;
		// Allow down to 0.5× for fit-to-dub (FFmpeg atempo floor).
		tempoFactor = Math.round(Math.min(1, Math.max(0.5, n)) * 1000) / 1000;
	},

	async cancel() {
		await cancelVideoTempo();
		message = 'Cancelling…';
	},

	/**
	 * Remaster current video at `tempoFactor` (pitch-safe), swap media, scale cues.
	 */
	async apply(opts?: { scaleCues?: boolean }): Promise<boolean> {
		if (isRemastering) return false;
		if (!isTauriRuntime()) {
			error = 'Pitch-safe Tempo requires the desktop app (`pnpm tauri:dev`).';
			dndStore.flash(error);
			return false;
		}
		if (!projectStore.videoPath && !projectStore.videoFile) {
			error = 'Open a video first, then apply Tempo.';
			dndStore.flash(error);
			return false;
		}
		if (Math.abs(tempoFactor - 1) < 0.001) {
			error = 'Tempo is 1.00× — nothing to remaster. Pick a slower factor (e.g. 0.92).';
			dndStore.flash(error);
			return false;
		}

		const scaleCues = opts?.scaleCues !== false;
		isRemastering = true;
		progress = 1;
		message = `Remastering at ${tempoFactor.toFixed(2)}× (pitch preserved)…`;
		error = null;
		projectStore.setVideoTool('tempo');

		try {
			const result = await runVideoTempoRemaster({
				tempo: tempoFactor,
				videoPath: projectStore.videoPath,
				videoFile: projectStore.videoFile,
				onProgress
			});

			await projectStore.applyVideoTempo(result.tempo, result.outputPath, result.durationMs, {
				scaleCues
			});

			progress = 100;
			const durLabel = formatClock(result.durationMs);
			message = `Done · ${result.tempo.toFixed(2)}× → ${durLabel}`;
			dndStore.flash(
				scaleCues
					? `Tempo ${result.tempo.toFixed(2)}× applied · ${durLabel} (pitch safe)`
					: `Video fitted to dub · ${result.tempo.toFixed(2)}× → ${durLabel}`
			);
			return true;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			error = msg || 'Tempo remaster failed.';
			message = error;
			if (!/cancel/i.test(msg)) {
				dndStore.flash(error);
			}
			return false;
		} finally {
			isRemastering = false;
			if (progress >= 100) {
				await new Promise((r) => setTimeout(r, 700));
			}
			progress = 0;
		}
	},

	/**
	 * Stretch video to cover the current subtitle/TTS timeline (pitch-safe).
	 * Keeps cue times and TTS clips — does not chipmunk the Khmer voice.
	 */
	async fitToDub(): Promise<boolean> {
		if (isRemastering) return false;
		if (!projectStore.current.cues.length) {
			error = 'Add subtitles / TTS first, then Fit video to dub.';
			dndStore.flash(error);
			return false;
		}

		const plan = computeFitToDubTempo({
			videoMs: videoDurationMs(),
			contentMs: dubContentEndMs()
		});

		if (plan.alreadyFits) {
			error = null;
			message = 'Dub already fits inside the video — nothing to remaster.';
			dndStore.flash(message);
			return false;
		}
		if (plan.tooExtreme) {
			error =
				'Dub is more than 2× the video length. Shorten Khmer lines, then try again (min 0.50×).';
			dndStore.flash(error);
			return false;
		}

		tempoFactor = plan.tempo;
		return this.apply({ scaleCues: false });
	}
};
