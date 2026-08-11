import { projectStore } from '$lib/stores/project.svelte';
import { dndStore } from '$lib/stores/dnd.svelte';
import {
	cancelVideoTempo,
	runVideoTempoRemaster,
	type VideoTempoProgress
} from '$lib/utils/video-tempo';
import { cueAudioEndMs } from '$lib/utils/tts-fit';
import {
	planSmartAlign,
	SMART_ALIGN_OVERHANG_WARN_MS,
	type AlignResultStats,
	type SmartAlignPlan,
	type SmartAlignStrategy
} from '$lib/utils/cue-smart-align';
import { isTauriRuntime } from '$lib/utils/platform';
import { formatClock } from '$lib/utils/time';

let isRemastering = $state(false);
let progress = $state(0);
let message = $state('');
let error = $state<string | null>(null);
let tempoFactor = $state(1);
let lastAlignResult = $state<AlignResultStats | null>(null);
/** Pending overhang choice after Align placed natural Khmer past picture end. */
let overhangPlan = $state<SmartAlignPlan | null>(null);

const TEMPO_PRESETS = [0.5, 0.65, 0.75, 0.85, 0.9, 0.95, 1] as const;

function onProgress(p: VideoTempoProgress) {
	progress = Math.max(0, Math.min(100, Math.round(p.percent)));
	message = p.message || p.stage;
}

/** True media length of the *current* video file — NEVER project.durationMs. */
function videoDurationMs(): number {
	const fromWave = projectStore.originalAudio.durationMs;
	if (fromWave > 1000) return fromWave;

	const fromAsset = projectStore.videoAsset?.durationMs ?? 0;
	if (fromAsset > 1000) return fromAsset;

	return 0;
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

function naturalKhmerMs(): number {
	const cues = projectStore.current.cues;
	let sum = 0;
	for (const cue of cues) {
		const d = cue.assignedAudio?.durationMs;
		if (typeof d === 'number' && d > 80) sum += Math.round(d);
		else sum += Math.max(200, cue.endMs - cue.startMs);
	}
	return sum;
}

function dubOverhangMs(): number {
	const videoMs = videoDurationMs();
	const contentMs = dubContentEndMs();
	if (videoMs < 500 || contentMs < 500) return 0;
	return Math.max(0, contentMs - videoMs);
}

function videoUnderhangMs(): number {
	const videoMs = videoDurationMs();
	const contentMs = dubContentEndMs();
	if (videoMs < 500 || contentMs < 500) return 0;
	return Math.max(0, videoMs - contentMs);
}

function mediaTempoFromSource(): number {
	const t = projectStore.current.mediaTempoFromSource;
	return Number.isFinite(t) ? Math.max(0.25, Math.min(2, t!)) : 1;
}

/** Preview plan for the Align button label (non-destructive). */
function previewPlan(): SmartAlignPlan | null {
	const videoMs = videoDurationMs();
	if (videoMs < 500 || !projectStore.current.cues.length) return null;
	return planSmartAlign({
		videoMs,
		cues: projectStore.current.cues,
		mediaTempoFromSource: mediaTempoFromSource()
	});
}

function setAlignResult(stats: AlignResultStats) {
	lastAlignResult = stats;
	message = stats.message;
	error = null;
	dndStore.flash(stats.message);
}

function finishAlignStats(opts: {
	originalVideoMs: number;
	videoTempo: number;
	audioStretch: number;
	strategy: SmartAlignStrategy;
	overhangMs?: number;
}): AlignResultStats {
	const khmerAudioMs = dubContentEndMs();
	const overhangMs = opts.overhangMs ?? Math.max(0, khmerAudioMs - videoDurationMs());
	const message = [
		`Aligned · video ${formatClock(opts.originalVideoMs)}`,
		`Khmer ${formatClock(khmerAudioMs)}`,
		`tempo ${opts.videoTempo.toFixed(2)}×`,
		`speech ${opts.audioStretch.toFixed(2)}×`
	].join(' · ');
	return {
		originalVideoMs: opts.originalVideoMs,
		khmerAudioMs,
		videoTempo: opts.videoTempo,
		audioStretch: opts.audioStretch,
		strategy: opts.strategy,
		overhangMs,
		message
	};
}

/** Remaster current picture only — never moves subtitle cue times. */
async function remasterVideoOnly(relativeTempo: number): Promise<{
	tempo: number;
	durationMs: number;
} | null> {
	if (relativeTempo >= 0.995) return null;
	projectStore.captureSourceFromCurrentIfNeeded();
	const result = await runVideoTempoRemaster({
		tempo: relativeTempo,
		videoPath: projectStore.videoPath,
		videoFile: projectStore.videoFile,
		onProgress
	});
	await projectStore.applyVideoTempo(result.tempo, result.outputPath, result.durationMs, {
		pictureLock: false,
		clearAudio: false,
		scaleCues: false,
		absoluteFromSource: false
	});
	const abs = projectStore.current.mediaTempoFromSource ?? result.tempo;
	tempoFactor = Math.round(Math.min(1, Math.max(0.5, abs)) * 1000) / 1000;
	return { tempo: result.tempo, durationMs: result.durationMs };
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
	get mediaDurationMs() {
		return videoDurationMs();
	},
	get dubOverhangMs() {
		return dubOverhangMs();
	},
	get videoUnderhangMs() {
		return videoUnderhangMs();
	},
	get lastAlignResult() {
		return lastAlignResult;
	},
	get overhangPlan() {
		return overhangPlan;
	},
	get hasOverhangPrompt() {
		return overhangPlan != null && overhangPlan.overhangMs > SMART_ALIGN_OVERHANG_WARN_MS;
	},
	/** Button label helper — maps smart plan → legacy-shaped fields. */
	get fitToDubPlan() {
		const plan = previewPlan();
		if (!plan) return null;
		const alreadyFits = plan.strategy === 'fits';
		const tooExtreme = plan.strategy === 'overhang';
		let strategy: 'none' | 'tts-only' | 'video-only' | 'hybrid' = 'none';
		if (plan.strategy === 'mild') {
			if (plan.ttsRate > 1.001 && plan.videoTempo < 0.995) strategy = 'hybrid';
			else if (plan.ttsRate > 1.001) strategy = 'tts-only';
			else if (plan.videoTempo < 0.995) strategy = 'video-only';
		} else if (plan.strategy === 'gap-expand') {
			strategy = 'tts-only';
		} else if (plan.strategy === 'overhang') {
			strategy = 'video-only';
		}
		return {
			tempo: plan.videoTempo,
			videoMs: plan.videoMs,
			contentMs: plan.contentEndMs,
			alreadyFits,
			tooExtreme,
			mode: plan.videoTempo < 0.995 ? ('stretch' as const) : ('none' as const),
			ttsRate: plan.ttsRate,
			effectiveContentMs: plan.effectiveVideoMs,
			strategy,
			smartStrategy: plan.strategy,
			summary: plan.summary,
			overhangMs: plan.overhangMs,
			naturalSpeechMs: plan.naturalSpeechMs
		};
	},

	clearOverhangPrompt() {
		overhangPlan = null;
	},

	/**
	 * After Generate TTS: cue times stay as Generate left them.
	 * Nudge user to Align when Khmer will need gap-expand / mild video fit.
	 */
	promptOverhangAfterTts(): boolean {
		const videoMs = videoDurationMs();
		if (videoMs < 500 || !projectStore.current.cues.length) return false;

		const plan = planSmartAlign({
			videoMs,
			cues: projectStore.current.cues,
			mediaTempoFromSource: mediaTempoFromSource()
		});

		if (plan.strategy === 'fits') {
			overhangPlan = null;
			dndStore.flash(`TTS ready · Khmer fits picture — Align optional`);
			return true;
		}

		if (plan.strategy === 'mild' || plan.strategy === 'gap-expand') {
			overhangPlan = null;
			tempoFactor = plan.videoTempo < 0.995 ? plan.videoTempo : tempoFactor;
			projectStore.setVideoTool('tempo');
			dndStore.flash(`TTS ready · ${plan.summary} — run Align script ↔ video`);
			return true;
		}

		// Heavy overhang — offer Auto-extend / trim / manual (Align applies placement first).
		overhangPlan = plan;
		tempoFactor = Math.min(1, Math.max(0.5, videoMs / Math.max(plan.contentEndMs, 1)));
		projectStore.setVideoTool('tempo');
		message = `TTS ready · Khmer runs ${formatClock(plan.overhangMs)} past video — Align, or choose Auto-extend / Manual.`;
		dndStore.flash(message);
		lastAlignResult = finishAlignStats({
			originalVideoMs: videoMs,
			videoTempo: 1,
			audioStretch: 1,
			strategy: 'overhang',
			overhangMs: plan.overhangMs
		});
		return true;
	},

	setTempoFactor(n: number) {
		tempoFactor = Math.round(Math.min(2, Math.max(0.5, n)) * 1000) / 1000;
	},

	/** Reset slider to applied tempo (1.00× for a freshly opened source). */
	syncFromProject() {
		const t = projectStore.current.mediaTempoFromSource ?? 1;
		tempoFactor = Math.round(Math.min(1, Math.max(0.5, t)) * 1000) / 1000;
	},

	async cancel() {
		await cancelVideoTempo();
	},

	/** Manual “Apply pitch-safe slowdown” — absolute tempo vs original source. */
	async apply(opts?: { scaleCues?: boolean }): Promise<boolean> {
		if (isRemastering) return false;

		const target = tempoFactor;
		const currentAbs = Math.round((projectStore.current.mediaTempoFromSource ?? 1) * 1000) / 1000;
		if (Math.abs(target - currentAbs) < 0.001) {
			dndStore.flash(`Tempo is already ${target.toFixed(2)}×.`);
			return false;
		}

		projectStore.captureSourceFromCurrentIfNeeded();
		const sourcePath = projectStore.sourceVideoPath;
		const sourceFile = projectStore.sourceVideoFile;
		const hasSource = Boolean(sourcePath?.trim() || sourceFile);
		const hasCurrent = Boolean(projectStore.videoPath || projectStore.videoFile);

		isRemastering = true;
		progress = 5;
		error = null;
		overhangPlan = null;
		projectStore.setVideoTool('tempo');

		try {
			// 1.00× → restore original media (not remaster the already-slowed file).
			if (Math.abs(target - 1) < 0.001) {
				if (!hasSource) {
					error =
						'Original video unavailable — re-open the source file, then apply 1.00×.';
					message = error;
					dndStore.flash(error);
					return false;
				}
				message = 'Restoring original video (1.00×)…';
				const ok = await projectStore.restoreSourceVideoTempo();
				if (!ok) {
					error = 'Could not restore the original video.';
					message = error;
					dndStore.flash(error);
					return false;
				}
				progress = 100;
				const durLabel = formatClock(
					projectStore.sourceDurationMs || projectStore.current.durationMs
				);
				message = `Restored · 1.00× → ${durLabel}`;
				tempoFactor = 1;
				dndStore.flash(`Restored original tempo · 1.00× → ${durLabel}`);
				return true;
			}

			if (!hasSource && !hasCurrent) {
				error = 'Open a video first, then apply Tempo.';
				message = error;
				dndStore.flash(error);
				return false;
			}

			// Always remaster from the original source at absolute target tempo.
			const remasterPath = sourcePath?.trim() || (!hasSource ? projectStore.videoPath : null);
			const remasterFile = remasterPath
				? null
				: sourceFile || (!hasSource ? projectStore.videoFile : null);

			message = `Remastering at ${target.toFixed(2)}× from original (pitch preserved)…`;
			const result = await runVideoTempoRemaster({
				tempo: target,
				videoPath: remasterPath,
				videoFile: remasterFile,
				onProgress
			});
			// Media only — leave subtitle / TTS cue times exactly as on the timeline.
			await projectStore.applyVideoTempo(result.tempo, result.outputPath, result.durationMs, {
				absoluteFromSource: true,
				pictureLock: false,
				clearAudio: false,
				scaleCues: false
			});
			progress = 100;
			tempoFactor = result.tempo;
			const durLabel = formatClock(result.durationMs);
			message = `Done · ${result.tempo.toFixed(2)}× → ${durLabel}`;
			dndStore.flash(`Tempo ${result.tempo.toFixed(2)}× applied · ${durLabel} (cues unchanged)`);
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
	 * Align script ↔ video (Extract → Paste path).
	 * Keeps Extract picture anchors when possible; expands gaps for long Khmer;
	 * mild path may nudge speech ≤~1.08× and/or pitch-safe video slowdown.
	 * Generate still does not retime — only Align places TTS against picture.
	 */
	async fitToDub(): Promise<boolean> {
		if (isRemastering) return false;
		if (!projectStore.current.cues.length) {
			error = 'Extract / paste cues first, then Generate TTS, then Align.';
			dndStore.flash(error);
			return false;
		}

		const videoMs = videoDurationMs();
		if (videoMs < 500) {
			error =
				'Video length not ready yet — wait for the waveform to load, or re-open the video.';
			dndStore.flash(error);
			return false;
		}

		overhangPlan = null;
		lastAlignResult = null;
		error = null;
		projectStore.captureSourceFromCurrentIfNeeded();
		projectStore.stampPictureAnchorsOnly();

		const plan = planSmartAlign({
			videoMs,
			cues: projectStore.current.cues,
			mediaTempoFromSource: mediaTempoFromSource()
		});

		isRemastering = true;
		progress = 10;
		message = plan.summary;
		projectStore.setVideoTool('tempo');

		try {
			// Always place cues from the plan (anchors preferred; spill expands gaps).
			if (plan.patches.length) {
				progress = 25;
				message = `${plan.summary} · placing cues…`;
				projectStore.applySmartAlignPatches(plan.patches);
			}

			if (plan.strategy === 'fits' || plan.strategy === 'gap-expand') {
				projectStore.syncTimelineDuration();
				progress = 100;
				setAlignResult(
					finishAlignStats({
						originalVideoMs: videoMs,
						videoTempo: 1,
						audioStretch: plan.ttsRate,
						strategy: plan.strategy,
						overhangMs: Math.max(0, dubContentEndMs() - videoDurationMs())
					})
				);
				return true;
			}

			if (plan.strategy === 'overhang') {
				overhangPlan = {
					...plan,
					contentEndMs: dubContentEndMs(),
					overhangMs: Math.max(0, dubContentEndMs() - videoMs)
				};
				progress = 100;
				error = null;
				message = `Khmer runs ${formatClock(overhangPlan.overhangMs)} past video — choose Auto-extend (slow video), Auto-trim, or Manual.`;
				dndStore.flash(message);
				lastAlignResult = finishAlignStats({
					originalVideoMs: videoMs,
					videoTempo: 1,
					audioStretch: plan.ttsRate,
					strategy: 'overhang',
					overhangMs: overhangPlan.overhangMs
				});
				return true;
			}

			// Mild: patches applied; optional pitch-safe video remaster.
			if (plan.videoTempo < 0.995) {
				if (!isTauriRuntime()) {
					error =
						'Mild video tempo needs the desktop app (`pnpm tauri:dev`). Cue placement was applied.';
					dndStore.flash(error);
					overhangPlan = plan;
					progress = 100;
					return false;
				}
				progress = 45;
				message = `Aligning · video ${plan.videoTempo.toFixed(2)}×…`;
				const remastered = await remasterVideoOnly(plan.videoTempo);
				progress = 100;
				setAlignResult(
					finishAlignStats({
						originalVideoMs: videoMs,
						videoTempo: remastered?.tempo ?? 1,
						audioStretch: plan.ttsRate,
						strategy: 'mild',
						overhangMs: Math.max(0, dubContentEndMs() - videoDurationMs())
					})
				);
				return true;
			}

			projectStore.syncTimelineDuration();
			progress = 100;
			setAlignResult(
				finishAlignStats({
					originalVideoMs: videoMs,
					videoTempo: 1,
					audioStretch: plan.ttsRate,
					strategy: 'mild',
					overhangMs: Math.max(0, dubContentEndMs() - videoDurationMs())
				})
			);
			return true;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			error = msg || 'Align failed.';
			message = error;
			if (!/cancel/i.test(msg)) dndStore.flash(error);
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
	 * Overhang option: force-fit into picture (may nudge starts + mild TTS rate).
	 */
	async resolveOverhangTrim(): Promise<boolean> {
		const videoMs = videoDurationMs();
		if (videoMs < 500) return false;
		isRemastering = true;
		progress = 20;
		message = 'Auto-trim · fitting Khmer into picture…';
		error = null;
		try {
			projectStore.stampPictureAnchorsOnly();
			const plan = planSmartAlign({
				videoMs,
				cues: projectStore.current.cues,
				mediaTempoFromSource: mediaTempoFromSource(),
				forceFitIntoVideo: true
			});
			if (plan.patches.length) {
				projectStore.applySmartAlignPatches(plan.patches);
			}
			projectStore.setDurationMs(videoMs, { force: true });
			overhangPlan = null;
			progress = 100;
			setAlignResult(
				finishAlignStats({
					originalVideoMs: videoMs,
					videoTempo: 1,
					audioStretch: plan.ttsRate,
					strategy: 'mild',
					overhangMs: Math.max(0, dubContentEndMs() - videoDurationMs())
				})
			);
			return true;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			error = msg || 'Auto-trim failed.';
			dndStore.flash(error);
			return false;
		} finally {
			isRemastering = false;
			progress = 0;
		}
	},

	/**
	 * Overhang option: pitch-safe slow video to cover placed Khmer timeline.
	 */
	async resolveOverhangExtend(): Promise<boolean> {
		const videoMs = videoDurationMs();
		if (videoMs < 500) return false;
		if (!isTauriRuntime()) {
			error = 'Auto-extend needs the desktop app (`pnpm tauri:dev`).';
			dndStore.flash(error);
			return false;
		}

		// Place natural layout first if Align hasn't yet (e.g. prompt right after TTS).
		const pending = overhangPlan;
		if (pending?.patches?.length) {
			projectStore.stampPictureAnchorsOnly();
			projectStore.applySmartAlignPatches(pending.patches);
		}

		const contentMs = Math.max(dubContentEndMs(), naturalKhmerMs());
		const wantTempo =
			Math.round(Math.min(1, Math.max(0.5, videoMs / Math.max(contentMs, 1))) * 1000) / 1000;

		isRemastering = true;
		progress = 15;
		error = null;
		overhangPlan = null;
		message =
			wantTempo < 0.995
				? `Auto-extend · video ${wantTempo.toFixed(2)}×…`
				: 'Auto-extend · timeline already covers Khmer…';
		projectStore.setVideoTool('tempo');

		try {
			if (wantTempo >= 0.995) {
				projectStore.syncTimelineDuration();
				progress = 100;
				setAlignResult(
					finishAlignStats({
						originalVideoMs: videoMs,
						videoTempo: 1,
						audioStretch: 1,
						strategy: 'fits',
						overhangMs: 0
					})
				);
				return true;
			}

			progress = 35;
			const remastered = await remasterVideoOnly(wantTempo);
			progress = 100;
			setAlignResult(
				finishAlignStats({
					originalVideoMs: videoMs,
					videoTempo: remastered?.tempo ?? wantTempo,
					audioStretch: 1,
					strategy: 'gap-expand',
					overhangMs: Math.max(0, dubContentEndMs() - videoDurationMs())
				})
			);
			return true;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			error = msg || 'Auto-extend failed.';
			message = error;
			if (!/cancel/i.test(msg)) dndStore.flash(error);
			return false;
		} finally {
			isRemastering = false;
			if (progress >= 100) {
				await new Promise((r) => setTimeout(r, 700));
			}
			progress = 0;
		}
	},

	/** Overhang option: leave placement for manual timeline edits. */
	resolveOverhangManual(): void {
		overhangPlan = null;
		message = 'Manual mode · adjust cues on the timeline, then Export when ready.';
		dndStore.flash(message);
		if (lastAlignResult) {
			lastAlignResult = { ...lastAlignResult, message };
		}
	}
};
