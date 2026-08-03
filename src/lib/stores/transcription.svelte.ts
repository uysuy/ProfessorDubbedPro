import { projectStore } from '$lib/stores/project.svelte';
import { dndStore } from '$lib/stores/dnd.svelte';
import { preferencesStore, whisperModelFileName } from '$lib/stores/preferences.svelte';
import {
	asrEngineLabel,
	cancelLocalTranscription,
	runLocalTranscription,
	type TranscriptionProgress,
	type TranscriptSegment
} from '$lib/utils/transcribe';
import { isTauriRuntime } from '$lib/utils/platform';

let isTranscribing = $state(false);
let progress = $state(0);
let message = $state('');
let error = $state<string | null>(null);
let lastEngine = $state<string | null>(null);

function onProgress(p: TranscriptionProgress) {
	progress = Math.max(0, Math.min(100, Math.round(p.percent)));
	message = p.message || p.stage;
}

/** Placeholders / junk lines from ASR. */
function isJunkSegment(text: string): boolean {
	const t = text.trim().toLowerCase();
	if (!t) return true;
	// SenseVoice event/emotion-only leftovers (no spoken words).
	const withoutSymbols = text
		.replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}]/gu, '')
		.replace(/[♪♫♬🎼🎵🎶]/g, '')
		.trim();
	if (!withoutSymbols) return true;
	return (
		t === 'speaking in foreign language' ||
		t === '(speaking in foreign language)' ||
		t === '[speaking in foreign language]' ||
		t === '[blank_audio]' ||
		t === '(blank_audio)' ||
		t === '[music]' ||
		t === '(music)' ||
		t === '[silence]' ||
		t === '(silence)' ||
		t === '[inaudible]' ||
		t === '(inaudible)' ||
		t === 'nospeech' ||
		t === '<|nospeech|>'
	);
}

function cleanSegments(segments: TranscriptSegment[]): TranscriptSegment[] {
	const cleaned = segments.filter((s) => !isJunkSegment(String(s.text ?? '')));
	if (cleaned.length) return cleaned;
	return segments.filter((s) => String(s.text ?? '').trim().length > 0);
}

/**
 * Auto transcription (Extract Subs) — FunASR for Chinese by default, Whisper fallback.
 */
export const transcriptionStore = {
	get isTranscribing() {
		return isTranscribing;
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
	get lastEngine() {
		return lastEngine;
	},

	async cancel() {
		await cancelLocalTranscription();
		message = 'Cancelling…';
	},

	/**
	 * Transcribe the current video's original audio into subtitle cues.
	 * Chinese → FunASR (SenseVoice) by default; Whisper on failure / non-Chinese.
	 */
	async extractSubs(): Promise<number> {
		if (isTranscribing) return 0;
		if (!isTauriRuntime()) {
			error = 'Extract Subs requires the desktop app (`pnpm tauri:dev`).';
			dndStore.flash(error);
			return 0;
		}
		if (!projectStore.videoPath && !projectStore.videoFile) {
			error = 'Open a video first, then run Extract Subs.';
			dndStore.flash(error);
			return 0;
		}

		isTranscribing = true;
		progress = 1;
		lastEngine = null;
		const enginePref = preferencesStore.asrEngine;
		message =
			enginePref === 'whisper'
				? `Starting Whisper (${preferencesStore.whisperModel})…`
				: enginePref === 'funasr'
					? `Starting FunASR (${preferencesStore.funasrModel})…`
					: 'Starting ASR (FunASR for Chinese)…';
		error = null;
		projectStore.setVideoTool('subs');

		try {
			const result = await runLocalTranscription({
				videoPath: projectStore.videoPath,
				videoFile: projectStore.videoFile,
				language: 'zh',
				model: whisperModelFileName(preferencesStore.whisperModel),
				engine: preferencesStore.asrEngine,
				funasrModel: preferencesStore.funasrModel,
				onProgress
			});

			lastEngine = result.engine ?? null;
			const engineName = asrEngineLabel(result.engine);
			const rawCount = result.segments.length;
			const segments = cleanSegments(result.segments);
			if (!segments.length) {
				throw new Error(
					'ASR found no usable speech text. Try again, or check that the video has clear dialogue.'
				);
			}

			const n = projectStore.applyTranscriptSegments(segments, {
				sourceLanguage: result.language || 'zh'
			});
			progress = 100;
			const dropped = Math.max(0, rawCount - segments.length);
			const modelBit = result.model ? ` · ${result.model}` : '';
			message =
				dropped > 0
					? `Loaded ${n} subtitle${n === 1 ? '' : 's'} (${engineName}${modelBit}, skipped ${dropped} placeholder${dropped === 1 ? '' : 's'})`
					: `Loaded ${n} subtitle${n === 1 ? '' : 's'} (${engineName}${modelBit})`;
			dndStore.flash(
				n === 1
					? `Extracted 1 subtitle · ${engineName}`
					: `Extracted ${n} subtitles · ${engineName}`
			);
			return n;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			error = msg || 'Transcription failed.';
			message = error;
			if (!/cancel/i.test(msg)) {
				dndStore.flash(error);
			}
			return 0;
		} finally {
			isTranscribing = false;
			if (progress >= 100) {
				await new Promise((r) => setTimeout(r, 600));
			}
			progress = 0;
		}
	}
};
