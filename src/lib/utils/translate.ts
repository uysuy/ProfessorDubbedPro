import { invoke } from '@tauri-apps/api/core';
import { isTauriRuntime } from '$lib/utils/platform';
import type { LlmTranslateProvider, TranslationQuality } from '$lib/stores/preferences.svelte';

export type TranslateProvider =
	| 'azure'
	| 'google'
	| 'deepseek'
	| 'qwen'
	| 'gemini'
	| 'none';

export type TranslateTextsResult = {
	translations: string[];
	provider: TranslateProvider | string;
	/** Present when High Quality fell back to Fast (e.g. Gemini quota). */
	warning?: string | null;
};

export type TranslateTextsOptions = {
	texts: string[];
	from?: string;
	to?: string;
	azureKey?: string;
	azureRegion?: string;
	quality?: TranslationQuality;
	llmProvider?: LlmTranslateProvider;
	llmApiKey?: string;
	llmModel?: string;
};

/**
 * Translate subtitle lines via the desktop `translate_texts` command.
 * Fast = Azure/Google; High = LLM (DeepSeek / Qwen / Gemini) with Fast fallback.
 */
export async function translateTexts(opts: TranslateTextsOptions): Promise<TranslateTextsResult> {
	if (!isTauriRuntime()) {
		throw new Error('Translation runs in the desktop app only. Start with `pnpm tauri:dev`.');
	}
	if (!opts.texts.length) {
		return { translations: [], provider: 'none' };
	}

	return invoke<TranslateTextsResult>('translate_texts', {
		args: {
			texts: opts.texts,
			from: opts.from ?? 'zh-Hans',
			to: opts.to ?? 'km',
			azureKey: opts.azureKey ?? '',
			azureRegion: opts.azureRegion ?? '',
			quality: opts.quality ?? 'fast',
			llmProvider: opts.llmProvider ?? 'deepseek',
			llmApiKey: opts.llmApiKey ?? '',
			llmModel: opts.llmModel ?? ''
		}
	});
}

export function translateProviderLabel(provider: string | null | undefined): string {
	switch ((provider ?? '').toLowerCase()) {
		case 'azure':
			return 'Azure';
		case 'google':
			return 'Google';
		case 'deepseek':
			return 'DeepSeek';
		case 'qwen':
			return 'Qwen';
		case 'gemini':
			return 'Gemini';
		default:
			return 'MT';
	}
}
