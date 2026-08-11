<script lang="ts">
	import { Label } from '$lib/components/ui/label/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import VoiceSelect from '$lib/components/studio/VoiceSelect.svelte';
	import {
		preferencesStore,
		languageLabel,
		languageNativeLabel,
		LANGUAGE_OPTIONS,
		AUTOSAVE_INTERVAL_OPTIONS,
		EXPORT_MODE_OPTIONS,
		TRANSLATION_QUALITY_OPTIONS,
		LLM_TRANSLATE_PROVIDER_OPTIONS,
		WHISPER_MODEL_OPTIONS,
		ASR_ENGINE_OPTIONS,
		FUNASR_MODEL_OPTIONS,
		TTS_ENGINE_OPTIONS,
		type AutoSaveIntervalSec,
		type DubLanguageCode,
		type TranslationQuality,
		type LlmTranslateProvider,
		type WhisperModelSize,
		type AsrEngine,
		type FunAsrModel
	} from '$lib/stores/preferences.svelte';
	import { autosaveStore } from '$lib/stores/autosave.svelte';
	import { projectStore } from '$lib/stores/project.svelte';
	import { voicesStore } from '$lib/stores/voices.svelte';
	import { VOXCPM_VOICES } from '$lib/tts/voxcpm-voices';
	import type { TtsEngineId } from '$lib/tts';
	import type { ExportMode } from '$lib/utils/export';

	const voiceName = $derived(voicesStore.displayName(preferencesStore.defaultVoiceId));
	const langName = $derived(languageLabel(preferencesStore.defaultLanguage));
	const intervalLabel = $derived(
		AUTOSAVE_INTERVAL_OPTIONS.find((o) => o.value === preferencesStore.autoSaveIntervalSec)
			?.label ?? `${preferencesStore.autoSaveIntervalSec}s`
	);
	const exportLabel = $derived(
		EXPORT_MODE_OPTIONS.find((o) => o.value === preferencesStore.defaultExportMode)?.label ??
			'Burned-in'
	);
	const qualityLabel = $derived(
		TRANSLATION_QUALITY_OPTIONS.find((o) => o.value === preferencesStore.translationQuality)
			?.label ?? 'Fast'
	);
	const llmProviderLabel = $derived(
		LLM_TRANSLATE_PROVIDER_OPTIONS.find((o) => o.value === preferencesStore.llmTranslateProvider)
			?.label ?? 'DeepSeek'
	);
	const whisperModelLabel = $derived(
		WHISPER_MODEL_OPTIONS.find((o) => o.value === preferencesStore.whisperModel)?.label ?? 'Small'
	);
	const asrEngineLabel = $derived(
		ASR_ENGINE_OPTIONS.find((o) => o.value === preferencesStore.asrEngine)?.label ?? 'Auto'
	);
	const funasrModelLabel = $derived(
		FUNASR_MODEL_OPTIONS.find((o) => o.value === preferencesStore.funasrModel)?.label ??
			'SenseVoice-Small'
	);
	const ttsEngineLabel = $derived(
		TTS_ENGINE_OPTIONS.find((o) => o.value === preferencesStore.ttsEngine)?.label ?? 'Edge TTS'
	);
	const voiceList = $derived(
		preferencesStore.ttsEngine === 'voxcpm' ? VOXCPM_VOICES : undefined
	);
	const translatorHint = $derived(
		preferencesStore.translationQuality === 'high'
			? preferencesStore.llmTranslateApiKey.trim()
				? `High Quality · ${llmProviderLabel}`
				: 'High Quality · add LLM API key'
			: preferencesStore.azureTranslatorKey.trim()
				? 'Fast · Azure Translator'
				: 'Fast · Google Translate'
	);

	function onVoiceChange(id: string) {
		preferencesStore.setDefaultVoiceId(id);
		projectStore.setVoiceId(id, { applyToCues: false });
	}

	function onLanguageChange(value: string | undefined) {
		if (!value || !LANGUAGE_OPTIONS.some((o) => o.value === value)) return;
		const code = value as DubLanguageCode;
		preferencesStore.setDefaultLanguage(code);
		projectStore.setTargetLanguage(code);
	}

	function onIntervalChange(value: string | undefined) {
		const n = Number(value);
		if (n !== 60 && n !== 75 && n !== 90) return;
		preferencesStore.setAutoSaveIntervalSec(n as AutoSaveIntervalSec);
		autosaveStore.reschedule();
	}

	function onExportChange(value: string | undefined) {
		if (!EXPORT_MODE_OPTIONS.some((o) => o.value === value)) return;
		preferencesStore.setDefaultExportMode(value as ExportMode);
	}

	function onQualityChange(value: string | undefined) {
		if (!value || !TRANSLATION_QUALITY_OPTIONS.some((o) => o.value === value)) return;
		preferencesStore.setTranslationQuality(value as TranslationQuality);
	}

	function onLlmProviderChange(value: string | undefined) {
		if (!value || !LLM_TRANSLATE_PROVIDER_OPTIONS.some((o) => o.value === value)) return;
		preferencesStore.setLlmTranslateProvider(value as LlmTranslateProvider);
	}

	function onWhisperModelChange(value: string | undefined) {
		if (!value || !WHISPER_MODEL_OPTIONS.some((o) => o.value === value)) return;
		preferencesStore.setWhisperModel(value as WhisperModelSize);
	}

	function onAsrEngineChange(value: string | undefined) {
		if (!value || !ASR_ENGINE_OPTIONS.some((o) => o.value === value)) return;
		preferencesStore.setAsrEngine(value as AsrEngine);
	}

	function onFunasrModelChange(value: string | undefined) {
		if (!value || !FUNASR_MODEL_OPTIONS.some((o) => o.value === value)) return;
		preferencesStore.setFunasrModel(value as FunAsrModel);
	}

	function onTtsEngineChange(value: string | undefined) {
		if (!value || !TTS_ENGINE_OPTIONS.some((o) => o.value === value)) return;
		const engine = value as TtsEngineId;
		preferencesStore.setTtsEngine(engine);
		projectStore.syncVoicesToTtsEngine(engine);
	}
</script>

<div
	class="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4"
	data-slot="project-settings-grid"
>
	<section
		class="flex min-w-0 flex-col gap-1.5 rounded-md border border-border/70 bg-muted/15 p-3 shadow-[var(--elevation-panel)]"
	>
		<Label class="text-xs" for="pref-voice">Default Voice</Label>
		<VoiceSelect
			value={preferencesStore.defaultVoiceId}
			voices={voiceList}
			onValueChange={onVoiceChange}
		/>
		<p class="mt-auto text-[11px] leading-snug text-muted-foreground">
			New cues &amp; Voice panel. <span class="text-foreground/80">{voiceName}</span>
		</p>
	</section>

	<section
		class="flex min-w-0 flex-col gap-1.5 rounded-md border border-border/70 bg-muted/15 p-3 shadow-[var(--elevation-panel)]"
	>
		<Label class="text-xs" for="pref-language">Default Language</Label>
		<Select.Root
			type="single"
			value={preferencesStore.defaultLanguage}
			onValueChange={onLanguageChange}
		>
			<Select.Trigger id="pref-language" class="h-8 w-full">
				<span class="flex min-w-0 items-center gap-2">
					<span>{langName}</span>
					{#if preferencesStore.defaultLanguage === 'km'}
						<span class="font-khmer text-[12px] text-muted-foreground"
							>{languageNativeLabel('km')}</span
						>
					{/if}
				</span>
			</Select.Trigger>
			<Select.Content>
				{#each LANGUAGE_OPTIONS as opt (opt.value)}
					<Select.Item value={opt.value} label={opt.label}>
						<span class="flex w-full items-center justify-between gap-3">
							<span>{opt.label}</span>
							<span
								class="text-[11px] text-muted-foreground"
								class:font-khmer={opt.value === 'km'}
								lang={opt.value}>{opt.nativeLabel}</span
							>
						</span>
					</Select.Item>
				{/each}
			</Select.Content>
		</Select.Root>
		<p class="mt-auto text-[11px] leading-snug text-muted-foreground">
			Dub target for ZH → KM projects (Khmer + English).
		</p>
	</section>

	<section
		class="flex min-w-0 flex-col gap-1.5 rounded-md border border-border/70 bg-muted/15 p-3 shadow-[var(--elevation-panel)] sm:col-span-2"
	>
		<div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
			<div class="flex min-w-0 flex-col gap-1.5">
				<Label class="text-xs" for="pref-asr-engine">Extract Subs engine</Label>
				<Select.Root
					type="single"
					value={preferencesStore.asrEngine}
					onValueChange={onAsrEngineChange}
				>
					<Select.Trigger id="pref-asr-engine" class="h-8 w-full">{asrEngineLabel}</Select.Trigger>
					<Select.Content>
						{#each ASR_ENGINE_OPTIONS as opt (opt.value)}
							<Select.Item value={opt.value} label={opt.label}>
								<span class="flex w-full items-center justify-between gap-3">
									<span>{opt.label}</span>
									<span class="text-[10px] text-muted-foreground">{opt.hint}</span>
								</span>
							</Select.Item>
						{/each}
					</Select.Content>
				</Select.Root>
			</div>
			<div class="flex min-w-0 flex-col gap-1.5">
				<Label class="text-xs" for="pref-funasr-model">FunASR model</Label>
				<Select.Root
					type="single"
					value={preferencesStore.funasrModel}
					onValueChange={onFunasrModelChange}
				>
					<Select.Trigger id="pref-funasr-model" class="h-8 w-full">{funasrModelLabel}</Select.Trigger>
					<Select.Content>
						{#each FUNASR_MODEL_OPTIONS as opt (opt.value)}
							<Select.Item value={opt.value} label={opt.label}>
								<span class="flex w-full items-center justify-between gap-3">
									<span>{opt.label}</span>
									<span class="text-[10px] text-muted-foreground">{opt.hint}</span>
								</span>
							</Select.Item>
						{/each}
					</Select.Content>
				</Select.Root>
			</div>
			<div class="flex min-w-0 flex-col gap-1.5">
				<Label class="text-xs" for="pref-whisper-model">Whisper fallback</Label>
				<Select.Root
					type="single"
					value={preferencesStore.whisperModel}
					onValueChange={onWhisperModelChange}
				>
					<Select.Trigger id="pref-whisper-model" class="h-8 w-full">{whisperModelLabel}</Select.Trigger>
					<Select.Content>
						{#each WHISPER_MODEL_OPTIONS as opt (opt.value)}
							<Select.Item value={opt.value} label={opt.label}>
								<span class="flex w-full items-center justify-between gap-3">
									<span>{opt.label}</span>
									<span class="text-[10px] text-muted-foreground">{opt.hint}</span>
								</span>
							</Select.Item>
						{/each}
					</Select.Content>
				</Select.Root>
			</div>
		</div>
		<p class="text-[11px] leading-snug text-muted-foreground">
			Extract Subs listens to the spoken audio track only (not burned-in AI captions). Chinese
			default: FunASR SenseVoice. Setup once with
			<span class="font-mono text-[10px]">pnpm funasr:setup</span>. For tougher Mandarin,
			try Paraformer-ZH. Whisper stays as fallback.
		</p>
	</section>

	<section
		class="flex min-w-0 flex-col gap-1.5 rounded-md border border-border/70 bg-muted/15 p-3 shadow-[var(--elevation-panel)] sm:col-span-2"
	>
		<div class="flex min-w-0 flex-col gap-1.5">
			<Label class="text-xs" for="pref-tts-engine">TTS engine</Label>
			<Select.Root
				type="single"
				value={preferencesStore.ttsEngine}
				onValueChange={onTtsEngineChange}
			>
				<Select.Trigger id="pref-tts-engine" class="h-8 w-full">{ttsEngineLabel}</Select.Trigger>
				<Select.Content>
					{#each TTS_ENGINE_OPTIONS as opt (opt.value)}
						<Select.Item value={opt.value} label={opt.label}>
							<span class="flex w-full items-center justify-between gap-3">
								<span>{opt.label}</span>
								<span class="text-[10px] text-muted-foreground">{opt.hint}</span>
							</span>
						</Select.Item>
					{/each}
				</Select.Content>
			</Select.Root>
		</div>
		<p class="text-[11px] leading-snug text-muted-foreground">
			Edge TTS is online and default. VoxCPM2 is optional local Khmer TTS — setup once with
			<span class="font-mono text-[10px]">pnpm voxcpm:setup</span>
			(~5GB model on first Generate, ~8GB VRAM). RTX 1070 is tight; switch back to Edge if it
			runs out of memory.
		</p>
	</section>

	<section
		class="flex min-w-0 flex-col gap-1.5 rounded-md border border-border/70 bg-muted/15 p-3 shadow-[var(--elevation-panel)]"
	>
		<div class="flex items-center justify-between gap-3">
			<Label class="text-xs" for="pref-tts-lipsync">Lip sync TTS</Label>
			<Switch
				id="pref-tts-lipsync"
				checked={preferencesStore.ttsLipSync}
				onCheckedChange={(v: boolean) => preferencesStore.setTtsLipSync(v)}
			/>
		</div>
		<p class="mt-auto text-[11px] leading-snug text-muted-foreground">
			On: mild speed-up (max ~1.3×) to match video; if Khmer is still longer, the cue extends
			instead of sounding chipmunk-fast. Off: natural pace (may run long). Re-generate TTS after
			changing.
		</p>
	</section>

	<section
		class="flex min-w-0 flex-col gap-1.5 rounded-md border border-border/70 bg-muted/15 p-3 shadow-[var(--elevation-panel)]"
	>
		<Label class="text-xs" for="pref-autosave-interval">Auto-save interval</Label>
		<Select.Root
			type="single"
			value={String(preferencesStore.autoSaveIntervalSec)}
			onValueChange={onIntervalChange}
		>
			<Select.Trigger id="pref-autosave-interval" class="h-8 w-full">{intervalLabel}</Select.Trigger>
			<Select.Content>
				{#each AUTOSAVE_INTERVAL_OPTIONS as opt (opt.value)}
					<Select.Item value={String(opt.value)} label={opt.label}>{opt.label}</Select.Item>
				{/each}
			</Select.Content>
		</Select.Root>
		<p class="mt-auto text-[11px] leading-snug text-muted-foreground">
			Quiet snapshot cadence while editing.
		</p>
	</section>

	<section
		class="flex min-w-0 flex-col gap-1.5 rounded-md border border-border/70 bg-muted/15 p-3 shadow-[var(--elevation-panel)]"
	>
		<Label class="text-xs" for="pref-export">Default export type</Label>
		<Select.Root
			type="single"
			value={preferencesStore.defaultExportMode}
			onValueChange={onExportChange}
		>
			<Select.Trigger id="pref-export" class="h-8 w-full">{exportLabel}</Select.Trigger>
			<Select.Content>
				{#each EXPORT_MODE_OPTIONS as opt (opt.value)}
					<Select.Item value={opt.value} label={opt.label}>
						<span class="flex w-full items-center justify-between gap-3">
							<span>{opt.label}</span>
							<span class="text-[10px] text-muted-foreground">{opt.hint}</span>
						</span>
					</Select.Item>
				{/each}
			</Select.Content>
		</Select.Root>
		<p class="mt-auto text-[11px] leading-snug text-muted-foreground">
			SRT / Soft / Burned-in pre-select.
		</p>
	</section>

	<section
		class="flex min-w-0 flex-col gap-1.5 rounded-md border border-border/70 bg-muted/15 p-3 shadow-[var(--elevation-panel)] sm:col-span-2 xl:col-span-2"
	>
		<Label class="text-xs" for="pref-azure-key">Azure Translator key (optional)</Label>
		<Input
			id="pref-azure-key"
			type="password"
			autocomplete="off"
			spellcheck={false}
			placeholder="Paste subscription key…"
			class="h-8 font-mono text-xs"
			value={preferencesStore.azureTranslatorKey}
			oninput={(e) =>
				preferencesStore.setAzureTranslatorKey((e.currentTarget as HTMLInputElement).value)}
		/>
		<div class="mt-1 flex flex-col gap-1.5 sm:flex-row sm:items-end">
			<div class="min-w-0 flex-1">
				<Label class="text-xs" for="pref-azure-region">Region</Label>
				<Input
					id="pref-azure-region"
					type="text"
					autocomplete="off"
					spellcheck={false}
					placeholder="global or eastasia"
					class="mt-1 h-8 font-mono text-xs"
					value={preferencesStore.azureTranslatorRegion}
					oninput={(e) =>
						preferencesStore.setAzureTranslatorRegion((e.currentTarget as HTMLInputElement).value)}
				/>
			</div>
			<p class="text-[11px] leading-snug text-muted-foreground sm:max-w-[14rem] sm:pb-1">
				Fast mode: Azure when set, otherwise Google Translate.
			</p>
		</div>
	</section>

	<section
		class="flex min-w-0 flex-col gap-2 rounded-md border border-border/70 bg-muted/15 p-3 shadow-[var(--elevation-panel)] sm:col-span-2 xl:col-span-4"
	>
		<div class="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
			<div class="flex min-w-0 flex-col gap-1.5">
				<Label class="text-xs" for="pref-translate-quality">Translation quality</Label>
				<Select.Root
					type="single"
					value={preferencesStore.translationQuality}
					onValueChange={onQualityChange}
				>
					<Select.Trigger id="pref-translate-quality" class="h-8 w-full">{qualityLabel}</Select.Trigger>
					<Select.Content>
						{#each TRANSLATION_QUALITY_OPTIONS as opt (opt.value)}
							<Select.Item value={opt.value} label={opt.label}>
								<span class="flex w-full items-center justify-between gap-3">
									<span>{opt.label}</span>
									<span class="text-[10px] text-muted-foreground">{opt.hint}</span>
								</span>
							</Select.Item>
						{/each}
					</Select.Content>
				</Select.Root>
			</div>

			<div class="flex min-w-0 flex-col gap-1.5">
				<Label class="text-xs" for="pref-llm-provider">LLM provider</Label>
				<Select.Root
					type="single"
					value={preferencesStore.llmTranslateProvider}
					onValueChange={onLlmProviderChange}
				>
					<Select.Trigger id="pref-llm-provider" class="h-8 w-full">{llmProviderLabel}</Select.Trigger>
					<Select.Content>
						{#each LLM_TRANSLATE_PROVIDER_OPTIONS as opt (opt.value)}
							<Select.Item value={opt.value} label={opt.label}>
								<span class="flex w-full items-center justify-between gap-3">
									<span>{opt.label}</span>
									<span class="text-[10px] text-muted-foreground">{opt.hint}</span>
								</span>
							</Select.Item>
						{/each}
					</Select.Content>
				</Select.Root>
			</div>

			<div class="flex min-w-0 flex-col gap-1.5 sm:col-span-2">
				<Label class="text-xs" for="pref-llm-key">LLM API key (High Quality)</Label>
				<Input
					id="pref-llm-key"
					type="password"
					autocomplete="off"
					spellcheck={false}
					placeholder="DeepSeek / Qwen / Gemini key…"
					class="h-8 font-mono text-xs"
					value={preferencesStore.llmTranslateApiKey}
					oninput={(e) =>
						preferencesStore.setLlmTranslateApiKey((e.currentTarget as HTMLInputElement).value)}
				/>
			</div>
		</div>

		<div class="flex min-w-0 flex-col gap-1.5 sm:max-w-md">
			<Label class="text-xs" for="pref-llm-model">Model override (optional)</Label>
			<Input
				id="pref-llm-model"
				type="text"
				autocomplete="off"
				spellcheck={false}
				placeholder={LLM_TRANSLATE_PROVIDER_OPTIONS.find(
					(o) => o.value === preferencesStore.llmTranslateProvider
				)?.defaultModel ?? 'deepseek-chat'}
				class="h-8 font-mono text-xs"
				value={preferencesStore.llmTranslateModel}
				oninput={(e) =>
					preferencesStore.setLlmTranslateModel((e.currentTarget as HTMLInputElement).value)}
			/>
		</div>

		<p class="text-[11px] leading-snug text-muted-foreground">
			Active: <span class="text-foreground/85">{translatorHint}</span>. High Quality uses an expanded
			ZH→KM slang glossary (relationship, sales, internet Mandarin) plus a post-check that blocks
			known wrong senses. Fast mode expands slang before Azure/Google. Gemini defaults to
			<span class="font-mono text-[10px]">gemini-2.5-pro</span>.
		</p>
	</section>
</div>
