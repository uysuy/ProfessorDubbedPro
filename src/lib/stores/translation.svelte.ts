import { projectStore } from '$lib/stores/project.svelte';
import { preferencesStore } from '$lib/stores/preferences.svelte';
import { dndStore } from '$lib/stores/dnd.svelte';
import { textContainsKhmer } from '$lib/tts/edge-tts-script';
import {
	translateTexts,
	translateProviderLabel,
	type TranslateProvider
} from '$lib/utils/translate';
import { isTauriRuntime } from '$lib/utils/platform';
import type { SubtitleCue } from '$lib/types/project';

const CHUNK_FAST = 8;
const CHUNK_HIGH = 10;

let isTranslating = $state(false);
let progress = $state(0);
let message = $state('');
let error = $state<string | null>(null);
let provider = $state<TranslateProvider | string | null>(null);
let runId = 0;

/** Chinese (or other source) text to send to the MT engine. */
export function cueTranslationInput(cue: SubtitleCue): string | null {
	const source = cue.source.trim();
	if (source) return source;

	const translation = cue.translation.trim();
	if (!translation) return null;
	// Already Khmer with no separate source — cannot re-derive Chinese.
	if (textContainsKhmer(translation)) return null;
	return translation;
}

/** True when a "translation" is still Chinese (LLM echo) — must not keep as Khmer. */
export function isChineseNotKhmer(text: string): boolean {
	const t = text.trim();
	if (!t) return false;
	if (textContainsKhmer(t)) return false;
	return /[\u4e00-\u9fff]/.test(t);
}

/**
 * Existing Khmer / edited dub text that must not be overwritten silently.
 * Chinese duplicated into both fields after Extract Subs is NOT protected.
 */
export function cueHasProtectedTranslation(cue: SubtitleCue): boolean {
	const t = cue.translation.trim();
	if (!t) return false;
	if (textContainsKhmer(t)) return true;
	const s = cue.source.trim();
	return Boolean(s && t !== s);
}

type WorkItem = { id: string; text: string; protected: boolean };

function collectWork(cues: SubtitleCue[]): WorkItem[] {
	const items: WorkItem[] = [];
	for (const cue of cues) {
		const text = cueTranslationInput(cue);
		if (!text) continue;
		items.push({
			id: cue.id,
			text,
			protected: cueHasProtectedTranslation(cue)
		});
	}
	return items;
}

/**
 * Resolve overwrite policy for protected lines.
 * Returns the items to translate, or null if the user cancelled everything.
 */
function applyOverwritePolicy(items: WorkItem[], singleLine: boolean): WorkItem[] | null {
	const protectedCount = items.filter((i) => i.protected).length;
	if (protectedCount === 0) return items;

	if (singleLine) {
		const ok = window.confirm(
			'This line already has Khmer text.\n\nOverwrite it with a new translation?'
		);
		return ok ? items : null;
	}

	const overwrite = window.confirm(
		`${protectedCount} line(s) already have Khmer text.\n\n` +
			'OK — overwrite those lines\n' +
			'Cancel — keep existing Khmer and only fill empty / Chinese-only lines'
	);

	if (overwrite) return items;
	const kept = items.filter((i) => !i.protected);
	if (!kept.length) {
		dndStore.flash('Nothing to translate — existing Khmer lines were kept.');
		return null;
	}
	return kept;
}

async function runTranslation(items: WorkItem[], label: string): Promise<number> {
	const myRun = ++runId;
	isTranslating = true;
	progress = 0;
	message = `${label}…`;
	error = null;
	provider = null;

	const quality = preferencesStore.translationQuality;
	const from = projectStore.current.sourceLanguage || 'zh-Hans';
	const azureKey = preferencesStore.azureTranslatorKey;
	const azureRegion = preferencesStore.azureTranslatorRegion;
	const llmProvider = preferencesStore.llmTranslateProvider;
	const llmApiKey = preferencesStore.llmTranslateApiKey;
	const llmModel = preferencesStore.llmTranslateModel;
	const chunkSize = quality === 'high' ? CHUNK_HIGH : CHUNK_FAST;

	if (quality === 'high' && !llmApiKey.trim()) {
		error =
			'High Quality needs an LLM API key. Add DeepSeek / Qwen / Gemini in Settings, or switch to Fast.';
		message = '';
		dndStore.flash(error);
		isTranslating = false;
		return 0;
	}

	let done = 0;
	let lastProvider: string | null = null;
	let fallbackWarning: string | null = null;

	try {
		const modeLabel = quality === 'high' ? 'High Quality (LLM)' : 'Fast';
		for (let i = 0; i < items.length; i += chunkSize) {
			if (myRun !== runId) return done;
			const chunk = items.slice(i, i + chunkSize);
			message = `${modeLabel}: ${Math.min(i + chunk.length, items.length)} / ${items.length}…`;

			const result = await translateTexts({
				texts: chunk.map((c) => c.text),
				from,
				to: 'km',
				azureKey,
				azureRegion,
				quality,
				llmProvider,
				llmApiKey,
				llmModel
			});

			if (myRun !== runId) return done;

			lastProvider = result.provider;
			provider = result.provider;
			if (result.warning?.trim()) {
				fallbackWarning = result.warning.trim();
			}

			if (result.translations.length !== chunk.length) {
				throw new Error(
					`Translator returned ${result.translations.length} results for ${chunk.length} lines.`
				);
			}

			for (let j = 0; j < chunk.length; j++) {
				const item = chunk[j]!;
				const translated = String(result.translations[j] ?? '').trim();
				if (!translated) continue;
				// Never commit Chinese echo into the Khmer column.
				if (isChineseNotKhmer(translated)) continue;
				projectStore.updateCue(item.id, { translation: translated, status: 'ready' });
				done += 1;
			}

			progress = Math.round(((i + chunk.length) / items.length) * 100);
		}

		projectStore.setTargetLanguage('km');
		const engine = translateProviderLabel(lastProvider);
		const usedFastFallback =
			Boolean(fallbackWarning) ||
			(quality === 'high' && (lastProvider === 'google' || lastProvider === 'azure'));
		message = usedFastFallback
			? `Done — ${done} line(s) via ${engine} (Fast fallback)`
			: `Done — ${done} line(s) via ${engine}`;
		dndStore.flash(
			usedFastFallback
				? fallbackWarning ??
						`Translated ${done} line(s) with Fast fallback (${engine}). Try DeepSeek/Qwen in Settings if Gemini quota is exhausted.`
				: `Translated ${done} line(s) to Khmer (${engine}).`
		);
		return done;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		error = msg;
		message = '';
		dndStore.flash(msg);
		return done;
	} finally {
		if (myRun === runId) {
			isTranslating = false;
			if (!error) progress = 100;
		}
	}
}

async function translateCues(cues: SubtitleCue[], label: string, singleLine: boolean): Promise<number> {
	if (isTranslating) return 0;
	if (!isTauriRuntime()) {
		error = 'Translation requires the desktop app (`pnpm tauri:dev`).';
		dndStore.flash(error);
		return 0;
	}
	if (!cues.length) {
		error = 'No subtitle lines to translate.';
		dndStore.flash(error);
		return 0;
	}

	const collected = collectWork(cues);
	if (!collected.length) {
		error = 'No Chinese source text found to translate.';
		dndStore.flash(error);
		return 0;
	}

	const items = applyOverwritePolicy(collected, singleLine);
	if (!items) return 0;

	return runTranslation(items, label);
}

/**
 * Chinese → Khmer machine translation for subtitle cues.
 */
export const translationStore = {
	get isTranslating() {
		return isTranslating;
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
	get provider() {
		return provider;
	},

	/** Selected cues, or all cues when nothing is selected. */
	async translateSmart(): Promise<number> {
		const selected = projectStore.selectedCueIds;
		if (selected.length > 0) {
			const cues = projectStore.current.cues.filter((c) => selected.includes(c.id));
			return translateCues(cues, 'Translating selected', false);
		}
		return translateCues([...projectStore.current.cues], 'Translating all', false);
	},

	async translateSelected(): Promise<number> {
		const ids = projectStore.selectedCueIds;
		if (!ids.length) {
			error = 'Select one or more subtitle lines first.';
			dndStore.flash(error);
			return 0;
		}
		const cues = projectStore.current.cues.filter((c) => ids.includes(c.id));
		return translateCues(cues, 'Translating selected', false);
	},

	async translateAll(): Promise<number> {
		return translateCues([...projectStore.current.cues], 'Translating all', false);
	},

	async translateCue(id: string): Promise<number> {
		const cue = projectStore.current.cues.find((c) => c.id === id);
		if (!cue) {
			error = 'Subtitle line not found.';
			dndStore.flash(error);
			return 0;
		}
		return translateCues([cue], `Translating #${cue.index}`, true);
	}
};
