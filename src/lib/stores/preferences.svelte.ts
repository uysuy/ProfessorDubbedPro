import type { ExportMode } from '$lib/utils/export';
import { DEFAULT_EDGE_VOICE_ID, migrateVoiceId } from '$lib/tts/edge-voices';
import { isTtsEngineId, setTtsEngine as applyTtsEngine, type TtsEngineId } from '$lib/tts';
import { DEFAULT_VOXCPM_VOICE_ID, isVoxcpmVoiceId } from '$lib/tts/voxcpm-voices';

export const PREFERENCES_STORAGE_KEY = 'pdp.preferences';

export type AutoSaveIntervalSec = 60 | 75 | 90;

/** Supported dub languages for now: Khmer + English. */
export type DubLanguageCode = 'km' | 'en';

/** Fast = Google/Azure MT; High = LLM (DeepSeek / Qwen / Gemini). */
export type TranslationQuality = 'fast' | 'high';

export type LlmTranslateProvider = 'deepseek' | 'qwen' | 'gemini';

/** Local Whisper GGML size for Extract Subs fallback. */
export type WhisperModelSize = 'small' | 'base';

/** Chinese ASR backend selection. */
export type AsrEngine = 'auto' | 'funasr' | 'whisper';

/** FunASR model alias. */
export type FunAsrModel = 'sensevoice' | 'fun-asr-nano' | 'paraformer';

export type AppPreferences = {
	defaultVoiceId: string;
	/** Target (dub) language — Khmer by default. */
	defaultLanguage: DubLanguageCode;
	autoSaveIntervalSec: AutoSaveIntervalSec;
	defaultExportMode: ExportMode;
	/** Azure Translator key — when set, used for Chinese→Khmer; else Google. */
	azureTranslatorKey: string;
	/** Azure region (e.g. eastasia). Empty or "global" omits the region header. */
	azureTranslatorRegion: string;
	/** Translation mode — Fast by default. */
	translationQuality: TranslationQuality;
	/** LLM used for High Quality Chinese→Khmer. */
	llmTranslateProvider: LlmTranslateProvider;
	/** API key for the selected LLM provider. */
	llmTranslateApiKey: string;
	/** Optional model override (empty = provider default). */
	llmTranslateModel: string;
	/** Whisper model for Extract Subs fallback. */
	whisperModel: WhisperModelSize;
	/** ASR engine — auto uses FunASR for Chinese, Whisper otherwise / on failure. */
	asrEngine: AsrEngine;
	/** FunASR model when engine is funasr/auto. */
	funasrModel: FunAsrModel;
	/**
	 * When true (default), long Khmer TTS extends the cue window to fit natural speech
	 * (no per-line speed-up — keeps pitch/tempo balanced). When false, same extend behavior
	 * for overrun (speech is never rate-warped per cue anymore).
	 */
	ttsLipSync: boolean;
	/** Active TTS backend — Edge (default) or optional local VoxCPM2. */
	ttsEngine: TtsEngineId;
};

export const LANGUAGE_OPTIONS: {
	value: DubLanguageCode;
	label: string;
	nativeLabel: string;
}[] = [
	{ value: 'km', label: 'Khmer', nativeLabel: 'ខ្មែរ' },
	{ value: 'en', label: 'English', nativeLabel: 'English' }
];

export const AUTOSAVE_INTERVAL_OPTIONS: { value: AutoSaveIntervalSec; label: string }[] = [
	{ value: 60, label: '60 seconds' },
	{ value: 75, label: '75 seconds' },
	{ value: 90, label: '90 seconds' }
];

export const EXPORT_MODE_OPTIONS: { value: ExportMode; label: string; hint: string }[] = [
	{ value: 'srt', label: 'SRT only', hint: 'Subtitle file' },
	{ value: 'videoSoftSubs', label: 'Soft subtitles', hint: 'Embedded track' },
	{ value: 'videoBurnedIn', label: 'Burned-in', hint: 'Always visible' }
];

export const TRANSLATION_QUALITY_OPTIONS: {
	value: TranslationQuality;
	label: string;
	hint: string;
}[] = [
	{ value: 'fast', label: 'Fast', hint: 'Google / Azure' },
	{ value: 'high', label: 'High Quality', hint: 'LLM · slang glossary' }
];

export const LLM_TRANSLATE_PROVIDER_OPTIONS: {
	value: LlmTranslateProvider;
	label: string;
	hint: string;
	defaultModel: string;
}[] = [
	{ value: 'deepseek', label: 'DeepSeek', hint: 'Recommended', defaultModel: 'deepseek-chat' },
	{ value: 'qwen', label: 'Qwen', hint: 'DashScope', defaultModel: 'qwen-plus' },
	{ value: 'gemini', label: 'Gemini', hint: 'Uses Pro by default', defaultModel: 'gemini-2.5-pro' }
];

export const WHISPER_MODEL_OPTIONS: {
	value: WhisperModelSize;
	label: string;
	hint: string;
	fileName: string;
}[] = [
	{ value: 'small', label: 'Small', hint: 'Accurate · ~465 MB', fileName: 'ggml-small.bin' },
	{ value: 'base', label: 'Base', hint: 'Faster · ~142 MB', fileName: 'ggml-base.bin' }
];

export const ASR_ENGINE_OPTIONS: {
	value: AsrEngine;
	label: string;
	hint: string;
}[] = [
	{ value: 'auto', label: 'Auto', hint: 'FunASR for Chinese' },
	{ value: 'funasr', label: 'FunASR', hint: 'SenseVoice · best ZH' },
	{ value: 'whisper', label: 'Whisper', hint: 'Fallback / offline ggml' }
];

export const FUNASR_MODEL_OPTIONS: {
	value: FunAsrModel;
	label: string;
	hint: string;
}[] = [
	{ value: 'sensevoice', label: 'SenseVoice-Small', hint: 'Fast · recommended' },
	{ value: 'paraformer', label: 'Paraformer-ZH', hint: 'Best Mandarin · larger download' },
	{ value: 'fun-asr-nano', label: 'Fun-ASR-Nano', hint: 'Higher accuracy · slower' }
];

export const TTS_ENGINE_OPTIONS: {
	value: TtsEngineId;
	label: string;
	hint: string;
}[] = [
	{ value: 'edge-tts', label: 'Edge TTS', hint: 'Online · default · no GPU' },
	{
		value: 'voxcpm',
		label: 'VoxCPM2 (local)',
		hint: 'Natural KM · ~5GB download · ~8GB VRAM'
	}
];

const DEFAULTS: AppPreferences = {
	defaultVoiceId: DEFAULT_EDGE_VOICE_ID,
	defaultLanguage: 'km',
	autoSaveIntervalSec: 75,
	defaultExportMode: 'videoBurnedIn',
	azureTranslatorKey: '',
	azureTranslatorRegion: '',
	translationQuality: 'fast',
	llmTranslateProvider: 'deepseek',
	llmTranslateApiKey: '',
	llmTranslateModel: '',
	whisperModel: 'small',
	asrEngine: 'auto',
	funasrModel: 'sensevoice',
	ttsLipSync: true,
	ttsEngine: 'edge-tts'
};

function isExportMode(v: unknown): v is ExportMode {
	return v === 'srt' || v === 'videoSoftSubs' || v === 'videoBurnedIn';
}

function isLanguage(v: unknown): v is DubLanguageCode {
	return v === 'km' || v === 'en';
}

function isInterval(v: unknown): v is AutoSaveIntervalSec {
	return v === 60 || v === 75 || v === 90;
}

function isQuality(v: unknown): v is TranslationQuality {
	return v === 'fast' || v === 'high';
}

function isLlmProvider(v: unknown): v is LlmTranslateProvider {
	return v === 'deepseek' || v === 'qwen' || v === 'gemini';
}

function isWhisperModel(v: unknown): v is WhisperModelSize {
	return v === 'small' || v === 'base';
}

function isAsrEngine(v: unknown): v is AsrEngine {
	return v === 'auto' || v === 'funasr' || v === 'whisper';
}

function isFunAsrModel(v: unknown): v is FunAsrModel {
	return v === 'sensevoice' || v === 'fun-asr-nano' || v === 'paraformer';
}

export function whisperModelFileName(size: WhisperModelSize): string {
	return WHISPER_MODEL_OPTIONS.find((o) => o.value === size)?.fileName ?? 'ggml-small.bin';
}

/** Normalize stored / project codes; map removed locales back to Khmer. */
export function normalizeDubLanguage(code: string | null | undefined): DubLanguageCode {
	const c = (code ?? '').trim().toLowerCase();
	if (c === 'en' || c.startsWith('en-')) return 'en';
	if (c === 'km' || c.startsWith('km-') || c === 'kh') return 'km';
	return DEFAULTS.defaultLanguage;
}

function parsePreferences(raw: unknown): AppPreferences {
	if (typeof raw !== 'object' || raw == null) return { ...DEFAULTS };
	const o = raw as Record<string, unknown>;
	return {
		defaultVoiceId: migrateVoiceId(
			typeof o.defaultVoiceId === 'string' && o.defaultVoiceId.trim()
				? o.defaultVoiceId
				: DEFAULTS.defaultVoiceId
		),
		defaultLanguage: isLanguage(o.defaultLanguage)
			? o.defaultLanguage
			: normalizeDubLanguage(typeof o.defaultLanguage === 'string' ? o.defaultLanguage : null),
		autoSaveIntervalSec: isInterval(o.autoSaveIntervalSec)
			? o.autoSaveIntervalSec
			: DEFAULTS.autoSaveIntervalSec,
		defaultExportMode: isExportMode(o.defaultExportMode)
			? o.defaultExportMode
			: DEFAULTS.defaultExportMode,
		azureTranslatorKey:
			typeof o.azureTranslatorKey === 'string' ? o.azureTranslatorKey : DEFAULTS.azureTranslatorKey,
		azureTranslatorRegion:
			typeof o.azureTranslatorRegion === 'string'
				? o.azureTranslatorRegion.trim()
				: DEFAULTS.azureTranslatorRegion,
		translationQuality: isQuality(o.translationQuality)
			? o.translationQuality
			: DEFAULTS.translationQuality,
		llmTranslateProvider: isLlmProvider(o.llmTranslateProvider)
			? o.llmTranslateProvider
			: DEFAULTS.llmTranslateProvider,
		llmTranslateApiKey:
			typeof o.llmTranslateApiKey === 'string'
				? o.llmTranslateApiKey
				: DEFAULTS.llmTranslateApiKey,
		llmTranslateModel: (() => {
			const model =
				typeof o.llmTranslateModel === 'string'
					? o.llmTranslateModel.trim()
					: DEFAULTS.llmTranslateModel;
			// Drop retired / new-user-blocked Gemini ids so the app default applies.
			const blocked = new Set([
				'gemini-2.5-flash-lite',
				'gemini-2.0-flash-lite',
				'gemini-1.5-flash',
				'gemini-1.5-pro'
			]);
			return blocked.has(model.toLowerCase()) ? '' : model;
		})(),
		whisperModel: isWhisperModel(o.whisperModel) ? o.whisperModel : DEFAULTS.whisperModel,
		asrEngine: isAsrEngine(o.asrEngine) ? o.asrEngine : DEFAULTS.asrEngine,
		funasrModel: isFunAsrModel(o.funasrModel) ? o.funasrModel : DEFAULTS.funasrModel,
		ttsLipSync: typeof o.ttsLipSync === 'boolean' ? o.ttsLipSync : DEFAULTS.ttsLipSync,
		ttsEngine: isTtsEngineId(o.ttsEngine) ? o.ttsEngine : DEFAULTS.ttsEngine
	};
}

function readStored(): AppPreferences {
	if (typeof localStorage === 'undefined') return { ...DEFAULTS };
	try {
		const raw = localStorage.getItem(PREFERENCES_STORAGE_KEY);
		if (!raw) return { ...DEFAULTS };
		return parsePreferences(JSON.parse(raw));
	} catch {
		return { ...DEFAULTS };
	}
}

function persist(prefs: AppPreferences) {
	if (typeof localStorage === 'undefined') return;
	try {
		localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(prefs));
	} catch {
		/* ignore quota */
	}
}

let prefs = $state<AppPreferences>(readStored());
applyTtsEngine(prefs.ttsEngine);

function patch(partial: Partial<AppPreferences>) {
	prefs = { ...prefs, ...partial };
	persist(prefs);
}

export function languageLabel(code: string): string {
	const c = (code ?? '').trim().toLowerCase();
	if (c.startsWith('zh') || c === 'chinese' || c === 'china') return 'Chinese';
	const normalized = normalizeDubLanguage(code);
	return LANGUAGE_OPTIONS.find((o) => o.value === normalized)?.label ?? normalized.toUpperCase();
}

export function languageNativeLabel(code: string): string {
	const normalized = normalizeDubLanguage(code);
	return (
		LANGUAGE_OPTIONS.find((o) => o.value === normalized)?.nativeLabel ?? languageLabel(normalized)
	);
}

/** True when text should use Khmer font shaping. */
export function usesKhmerScript(code: string): boolean {
	return normalizeDubLanguage(code) === 'km';
}

export const preferencesStore = {
	get snapshot(): AppPreferences {
		return prefs;
	},
	get defaultVoiceId() {
		return prefs.defaultVoiceId;
	},
	get defaultLanguage() {
		return prefs.defaultLanguage;
	},
	get autoSaveIntervalSec() {
		return prefs.autoSaveIntervalSec;
	},
	get defaultExportMode() {
		return prefs.defaultExportMode;
	},
	get azureTranslatorKey() {
		return prefs.azureTranslatorKey;
	},
	get azureTranslatorRegion() {
		return prefs.azureTranslatorRegion;
	},
	get translationQuality() {
		return prefs.translationQuality;
	},
	get llmTranslateProvider() {
		return prefs.llmTranslateProvider;
	},
	get llmTranslateApiKey() {
		return prefs.llmTranslateApiKey;
	},
	get llmTranslateModel() {
		return prefs.llmTranslateModel;
	},
	get whisperModel() {
		return prefs.whisperModel;
	},
	get asrEngine() {
		return prefs.asrEngine;
	},
	get funasrModel() {
		return prefs.funasrModel;
	},
	get ttsLipSync() {
		return prefs.ttsLipSync;
	},
	get ttsEngine() {
		return prefs.ttsEngine;
	},
	setDefaultVoiceId(id: string) {
		const next = migrateVoiceId(id);
		if (!next) return;
		patch({ defaultVoiceId: next });
	},
	setDefaultLanguage(code: DubLanguageCode) {
		patch({ defaultLanguage: normalizeDubLanguage(code) });
	},
	setAutoSaveIntervalSec(sec: AutoSaveIntervalSec) {
		patch({ autoSaveIntervalSec: sec });
	},
	setDefaultExportMode(mode: ExportMode) {
		patch({ defaultExportMode: mode });
	},
	setAzureTranslatorKey(key: string) {
		patch({ azureTranslatorKey: key.trim() });
	},
	setAzureTranslatorRegion(region: string) {
		patch({ azureTranslatorRegion: region.trim() });
	},
	setTranslationQuality(quality: TranslationQuality) {
		if (!isQuality(quality)) return;
		patch({ translationQuality: quality });
	},
	setLlmTranslateProvider(provider: LlmTranslateProvider) {
		if (!isLlmProvider(provider)) return;
		patch({ llmTranslateProvider: provider });
	},
	setLlmTranslateApiKey(key: string) {
		const trimmed = key.trim();
		const next: Partial<AppPreferences> = { llmTranslateApiKey: trimmed };
		// Google AI Studio keys usually start with AIza — select Gemini automatically.
		if (trimmed.startsWith('AIza') && prefs.llmTranslateProvider !== 'gemini') {
			next.llmTranslateProvider = 'gemini';
		}
		patch(next);
	},
	setLlmTranslateModel(model: string) {
		patch({ llmTranslateModel: model.trim() });
	},
	setWhisperModel(model: WhisperModelSize) {
		if (!isWhisperModel(model)) return;
		patch({ whisperModel: model });
	},
	setAsrEngine(engine: AsrEngine) {
		if (!isAsrEngine(engine)) return;
		patch({ asrEngine: engine });
	},
	setFunasrModel(model: FunAsrModel) {
		if (!isFunAsrModel(model)) return;
		patch({ funasrModel: model });
	},
	setTtsLipSync(on: boolean) {
		patch({ ttsLipSync: Boolean(on) });
	},
	setTtsEngine(engine: TtsEngineId) {
		if (!isTtsEngineId(engine)) return;
		applyTtsEngine(engine);
		const next: Partial<AppPreferences> = { ttsEngine: engine };
		// Keep voice id family aligned with the engine.
		if (engine === 'voxcpm' && !isVoxcpmVoiceId(prefs.defaultVoiceId)) {
			next.defaultVoiceId = DEFAULT_VOXCPM_VOICE_ID;
		} else if (engine === 'edge-tts' && isVoxcpmVoiceId(prefs.defaultVoiceId)) {
			next.defaultVoiceId = DEFAULT_EDGE_VOICE_ID;
		}
		patch(next);
	},
	/** Re-read from disk (e.g. after another tab). */
	reload() {
		prefs = readStored();
		applyTtsEngine(prefs.ttsEngine);
	}
};