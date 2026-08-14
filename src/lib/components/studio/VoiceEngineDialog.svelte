<script lang="ts">
	import { onMount } from 'svelte';
	import { convertFileSrc, invoke } from '@tauri-apps/api/core';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Progress } from '$lib/components/ui/progress/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import { projectStore } from '$lib/stores/project.svelte';
	import { dndStore } from '$lib/stores/dnd.svelte';
	import { studioUi } from '$lib/stores/studio-ui.svelte';
	import { preferencesStore, TTS_ENGINE_OPTIONS } from '$lib/stores/preferences.svelte';
	import { type TtsEngineId } from '$lib/tts';
	import {
		DEFAULT_VOXCPM_VOICE_ID,
		VOXCPM_VOICES,
		matchVoxcpmVoiceToGender,
		voxcpmVoicesForGender
	} from '$lib/tts/voxcpm-voices';
	import { previewVoxcpmVoice, stopVoicePreview, clearLastVoxcpmPreviewPath, getLastVoxcpmPreviewPath } from '$lib/tts/voice-preview';
	import { voiceMatchesEngine } from '$lib/tts/voice-engine';
	import { isTauriRuntime } from '$lib/utils/platform';
	import { LoaderCircle, Lock, LockOpen, Play, SkipForward, Trash2 } from '@lucide/svelte';
	import type { SpeakerVoiceProfile } from '$lib/types/project';

	const open = $derived(studioUi.voiceEngineOpen);
	const engineId = $derived(preferencesStore.ttsEngine);
	const engineLabel = $derived(
		TTS_ENGINE_OPTIONS.find((o) => o.value === engineId)?.label ?? engineId
	);

	type VoxStatus = {
		setupReady: boolean;
		serverRunning: boolean;
		modelLoaded: boolean;
		weightsCached: boolean;
		loading: boolean;
		loadProgress: number;
		loadStage: string;
		model: string;
		port: number;
		message: string;
	};

	let voxStatus = $state<VoxStatus | null>(null);
	let voxBusy = $state(false);
	let voxError = $state<string | null>(null);
	/** Manual speaker count (1–6). */
	let speakerCount = $state(2);
	let previewingId = $state<string | null>(null);
	/** Which speaker Preview / Next speaker act on. */
	let focusedSpeakerId = $state<string | null>(null);
	let lockPreviewAudio: HTMLAudioElement | null = null;

	const speakerBank = $derived(projectStore.speakerBank);
	const focusedSpeaker = $derived(
		speakerBank.find((s) => s.id === focusedSpeakerId) ?? speakerBank[0] ?? null
	);

	const voxCached = $derived(voxStatus?.weightsCached === true);
	const voxRunning = $derived(voxStatus?.serverRunning === true);
	const voxLoaded = $derived(voxStatus?.modelLoaded === true);
	const voxLoading = $derived(voxBusy || voxStatus?.loading === true);
	const voxProgress = $derived(
		Math.max(0, Math.min(100, Number(voxStatus?.loadProgress ?? (voxLoading ? 5 : 0))))
	);
	const voxStageLabel = $derived.by(() => {
		const stage = (voxStatus?.loadStage ?? '').toLowerCase();
		if (stage === 'ready') return 'Ready';
		if (stage === 'downloading') return 'Downloading weights';
		if (stage === 'loading_weights' || stage === 'importing') return 'Loading weights';
		if (stage === 'to_gpu') return 'Moving to GPU';
		if (stage === 'resolving_cache' || stage === 'queued' || stage === 'starting') {
			return voxCached ? 'Starting from local cache' : 'Starting';
		}
		if (voxLoading) return voxCached ? 'Loading into VRAM' : 'Working';
		return '';
	});

	async function refreshVoxStatus() {
		if (!isTauriRuntime() || engineId !== 'voxcpm') {
			voxStatus = null;
			return;
		}
		try {
			voxStatus = await invoke<VoxStatus>('voxcpm_status');
		} catch {
			voxStatus = null;
		}
	}

	function stopLockAudio() {
		if (!lockPreviewAudio) return;
		try {
			lockPreviewAudio.pause();
		} catch {
			/* ignore */
		}
		lockPreviewAudio = null;
	}

	onMount(() => {
		void refreshVoxStatus();
		const bankLen = projectStore.speakerBank.length;
		if (bankLen > 0) {
			speakerCount = Math.max(1, Math.min(6, bankLen));
			focusedSpeakerId = projectStore.speakerBank[0]?.id ?? null;
		}
		return () => {
			stopLockAudio();
			stopVoicePreview();
		};
	});

	$effect(() => {
		const bank = speakerBank;
		if (!bank.length) {
			focusedSpeakerId = null;
			return;
		}
		if (!focusedSpeakerId || !bank.some((s) => s.id === focusedSpeakerId)) {
			focusedSpeakerId = bank[0]!.id;
		}
	});

	$effect(() => {
		void engineId;
		void refreshVoxStatus();
		if (!voiceMatchesEngine(projectStore.voiceId, engineId)) {
			projectStore.setVoiceId(
				engineId === 'voxcpm' ? DEFAULT_VOXCPM_VOICE_ID : preferencesStore.defaultVoiceId,
				{ applyToCues: false }
			);
		}
	});

	function onOpenChange(v: boolean) {
		studioUi.voiceEngineOpen = v;
		if (v) {
			void refreshVoxStatus();
			// Bring back loved speakers without forcing Set speakers again.
			if (!projectStore.speakerBank.length) {
				const n = projectStore.restoreSpeakersFromVault();
				if (n > 0) {
					speakerCount = Math.max(1, Math.min(6, n));
					focusedSpeakerId = projectStore.speakerBank[0]?.id ?? null;
					dndStore.flash(`Restored ${n} saved speaker${n === 1 ? '' : 's'}`);
				}
			} else {
				const bankLen = projectStore.speakerBank.length;
				speakerCount = Math.max(1, Math.min(6, bankLen));
				focusedSpeakerId = projectStore.speakerBank[0]?.id ?? focusedSpeakerId;
			}
		} else {
			stopLockAudio();
			stopVoicePreview();
			previewingId = null;
		}
	}

	function onEngineChange(value: string | undefined) {
		if (!value || !TTS_ENGINE_OPTIONS.some((o) => o.value === value)) return;
		const engine = value as TtsEngineId;
		preferencesStore.setTtsEngine(engine);
		const { cues } = projectStore.syncVoicesToTtsEngine(engine);
		dndStore.flash(
			cues > 0
				? `Switched to ${TTS_ENGINE_OPTIONS.find((o) => o.value === engine)?.label ?? engine} — updated ${cues} subtitle voice${cues === 1 ? '' : 's'}`
				: `Switched to ${TTS_ENGINE_OPTIONS.find((o) => o.value === engine)?.label ?? engine}`
		);
		void refreshVoxStatus();
	}

	async function onVoxStart() {
		voxBusy = true;
		voxError = null;
		dndStore.flash(
			voxCached
				? 'Starting VoxCPM2 from local cache…'
				: 'Starting VoxCPM2 (first time may download ~5GB)…'
		);
		const poll = setInterval(() => void refreshVoxStatus(), 1000);
		try {
			voxStatus = await invoke<VoxStatus>('load_voxcpm_model');
			dndStore.flash('VoxCPM2 ready');
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			voxError = msg;
			dndStore.flash(msg);
			await refreshVoxStatus();
		} finally {
			clearInterval(poll);
			voxBusy = false;
			await refreshVoxStatus();
		}
	}

	async function onVoxStop() {
		voxBusy = true;
		try {
			voxStatus = await invoke<VoxStatus>('stop_voxcpm_server');
			voxError = null;
			dndStore.flash('VoxCPM stopped — VRAM freed');
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			voxError = msg;
			dndStore.flash(msg);
		} finally {
			voxBusy = false;
			await refreshVoxStatus();
		}
	}

	function onApplySpeakers() {
		const n = projectStore.setManualSpeakers(speakerCount);
		focusedSpeakerId = projectStore.speakerBank[0]?.id ?? null;
		dndStore.flash(
			n === 1
				? '1 speaker ready — set gender/preset, Preview, then Lock'
				: `${n} speakers ready — set gender/preset, Preview, then Lock each`
		);
	}

	function onDone() {
		const before = projectStore.speakerBank.length;
		const n = projectStore.commitSpeakers(speakerCount);
		focusedSpeakerId = projectStore.speakerBank[0]?.id ?? null;
		const cueN = projectStore.current.cues.length;
		if (n > 0) {
			dndStore.flash(
				cueN > 0
					? `Applied ${n} speaker${n === 1 ? '' : 's'} to ${cueN} line${cueN === 1 ? '' : 's'} — assign Speaker in the table if needed, then Generate`
					: `Applied ${n} speaker${n === 1 ? '' : 's'} — Extract / paste lines, then assign Speaker in the table`
			);
		} else if (!before) {
			dndStore.flash('Set a speaker count first, then Done');
			return;
		}
		onOpenChange(false);
	}

	function focusSpeaker(id: string) {
		focusedSpeakerId = id;
	}

	function onNextSpeaker() {
		const bank = speakerBank;
		if (bank.length < 2) {
			dndStore.flash('Only one speaker — add more with Set speakers');
			return;
		}
		const curId = focusedSpeaker?.id ?? bank[0]!.id;
		const idx = bank.findIndex((s) => s.id === curId);
		const next = bank[(idx + 1) % bank.length]!;
		focusedSpeakerId = next.id;
		stopLockAudio();
		stopVoicePreview();
		previewingId = null;
		dndStore.flash(`Now: ${next.id} — Preview to hear this voice`);
	}

	function presetLabel(voiceId: string): string {
		return VOXCPM_VOICES.find((v) => v.id === voiceId)?.name ?? voiceId;
	}

	function genderLabel(g: SpeakerVoiceProfile['gender']): string {
		if (g === 'female') return 'Female';
		if (g === 'male') return 'Male';
		return 'Neutral';
	}

	function resolvePreviewVoiceId(sp: SpeakerVoiceProfile): string {
		if (sp.gender === 'male' || sp.gender === 'female') {
			return matchVoxcpmVoiceToGender(sp.voiceId, sp.gender);
		}
		return sp.voiceId;
	}

	async function onPreview(sp?: SpeakerVoiceProfile | null) {
		const target = sp ?? focusedSpeaker;
		if (!target) {
			dndStore.flash('Set speakers first.');
			return;
		}
		if (!voxLoaded) {
			dndStore.flash('Start VoxCPM2 first, then Preview.');
			return;
		}
		focusedSpeakerId = target.id;
		stopLockAudio();
		stopVoicePreview();
		previewingId = target.id;
		try {
			// Locked → hear the saved clone sample. Unlocked → hear the current preset.
			if (target.locked && target.refWavPath) {
				const url = convertFileSrc(target.refWavPath);
				const audio = new Audio(url);
				lockPreviewAudio = audio;
				await audio.play();
				await new Promise<void>((resolve) => {
					audio.onended = () => resolve();
					audio.onerror = () => resolve();
				});
			} else {
				await previewVoxcpmVoice(resolvePreviewVoiceId(target));
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			dndStore.flash(msg || 'Could not preview voice');
		} finally {
			if (previewingId === target.id) previewingId = null;
			stopLockAudio();
		}
	}

	async function onLock(sp: SpeakerVoiceProfile) {
		if (!voxLoaded) {
			dndStore.flash('Start VoxCPM2 first, then Lock voice.');
			return;
		}
		stopLockAudio();
		stopVoicePreview();
		const voiceId = resolvePreviewVoiceId(sp);
		const previewPath = getLastVoxcpmPreviewPath(voiceId);
		if (!previewPath && !(sp.locked && sp.refWavPath)) {
			dndStore.flash('Preview this preset first, then Lock — so we save the exact voice you heard.');
		}
		const ok = await projectStore.lockSpeakerVoice(sp.id, {
			sourceWavPath: previewPath || undefined
		});
		if (ok) {
			const locked = projectStore.speakerBank.find((s) => s.id === sp.id);
			dndStore.flash(
				previewPath
					? `Locked the voice you previewed → ${presetLabel(locked?.voiceId || sp.voiceId)}`
					: `Saved “${sp.id}” → ${presetLabel(locked?.voiceId || sp.voiceId)} (preview first next time for an exact match)`
			);
		} else if (projectStore.speakersError) {
			dndStore.flash(projectStore.speakersError);
		}
	}

	function onClear(sp: SpeakerVoiceProfile) {
		stopLockAudio();
		stopVoicePreview();
		projectStore.clearSpeakerLock(sp.id);
		dndStore.flash(`Cleared ${sp.id} lock — Saved voices library kept for re-select`);
	}

	function onApplySaved(sp: SpeakerVoiceProfile, savedId: string | undefined) {
		if (!savedId) return;
		const savedName =
			projectStore.savedVoices.find((v) => v.id === savedId)?.name ?? 'voice';
		const nextId = projectStore.applySavedVoice(sp.id, savedId);
		if (nextId) {
			if (focusedSpeakerId === sp.id || focusedSpeakerId === nextId) {
				focusedSpeakerId = nextId;
			}
			dndStore.flash(
				nextId !== sp.id
					? `Applied “${savedName}” — speaker renamed to ${nextId}`
					: `Applied saved voice “${savedName}” → ${nextId}`
			);
		} else if (projectStore.speakersError) {
			dndStore.flash(projectStore.speakersError);
		}
	}

	function onDeleteSaved(savedId: string) {
		const name = projectStore.savedVoices.find((v) => v.id === savedId)?.name ?? 'voice';
		if (typeof window !== 'undefined') {
			const ok = window.confirm(`Remove saved voice “${name}” from the library?`);
			if (!ok) return;
		}
		projectStore.removeSavedVoice(savedId);
		dndStore.flash(`Removed “${name}” from Saved voices`);
	}
</script>

<Dialog.Root open={open} onOpenChange={onOpenChange}>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>Engine & Speakers</Dialog.Title>
			<Dialog.Description>
				Preview a preset, then Lock — we save the exact WAV you just heard (VoxCPM design voices
				vary each run). Pick it later from Saved voices.
			</Dialog.Description>
		</Dialog.Header>

		<div class="space-y-4 py-1">
			<section class="space-y-1.5">
				<Label class="text-[10px] font-semibold tracking-[0.12em] text-foreground/75 uppercase"
					>TTS engine</Label
				>
				<Select.Root type="single" value={engineId} onValueChange={onEngineChange}>
					<Select.Trigger class="h-8 w-full text-[12px]" aria-label="TTS engine"
						>{engineLabel}</Select.Trigger
					>
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
			</section>

			{#if engineId === 'voxcpm'}
				<section class="space-y-2 rounded-md border border-border/70 bg-muted/25 p-2.5">
					<p class="text-[10px] leading-snug text-muted-foreground">
						{#if voxStatus}
							{voxStatus.message}
						{:else}
							Optional local engine — run
							<span class="font-mono">pnpm voxcpm:setup</span>
							once.
						{/if}
					</p>
					<div class="flex flex-wrap gap-1">
						{#if voxRunning || voxLoaded || voxLoading}
							<Button
								size="sm"
								variant="outline"
								class="h-7 text-[10px]"
								disabled={voxBusy && !voxRunning}
								onclick={onVoxStop}
							>
								{voxBusy && voxRunning && !voxLoaded ? 'Stopping…' : 'Stop'}
							</Button>
						{:else}
							<Button
								size="sm"
								variant="outline"
								class="h-7 text-[10px]"
								disabled={voxBusy}
								onclick={onVoxStart}
							>
								{voxBusy ? 'Starting…' : 'Start'}
							</Button>
						{/if}
					</div>
					{#if voxLoading || (voxBusy && !voxLoaded)}
						<div class="space-y-1 rounded-md border border-primary/30 bg-primary/8 px-2 py-1.5">
							<div class="flex items-center justify-between gap-2 text-[10px] text-primary">
								<span class="truncate">{voxStageLabel || 'Loading…'}</span>
								<span class="font-mono tabular-nums">{voxProgress}%</span>
							</div>
							<Progress value={voxProgress} max={100} class="h-1.5" />
						</div>
					{/if}
					{#if voxError}
						<p
							class="max-h-24 overflow-auto rounded border border-destructive/40 bg-destructive/10 px-1.5 py-1 text-[10px] leading-snug text-destructive whitespace-pre-wrap"
						>
							{voxError}
						</p>
					{/if}
				</section>

				<section class="space-y-2">
					<div class="flex flex-wrap items-end justify-between gap-2">
						<div class="space-y-1">
							<Label
								class="text-[10px] font-semibold tracking-[0.12em] text-foreground/75 uppercase"
								>Speakers</Label
							>
							<div class="flex items-center gap-1.5">
								<span class="text-[10px] text-muted-foreground">Count</span>
								<Select.Root
									type="single"
									value={String(speakerCount)}
									onValueChange={(v) => {
										const n = Number(v);
										speakerCount = Number.isFinite(n) ? Math.max(1, Math.min(6, n)) : 1;
									}}
								>
									<Select.Trigger class="h-7 w-[4.5rem] text-[10px]" aria-label="Speaker count">
										{speakerCount}
									</Select.Trigger>
									<Select.Content>
										{#each [1, 2, 3, 4, 5, 6] as n (n)}
											<Select.Item value={String(n)} label={String(n)}>{n}</Select.Item>
										{/each}
									</Select.Content>
								</Select.Root>
							</div>
						</div>
						<Button size="sm" variant="outline" class="h-7 text-[10px]" onclick={onApplySpeakers}>
							Set speakers
						</Button>
					</div>

					{#if projectStore.speakerBank.length}
						<div class="flex flex-wrap items-center gap-1.5 rounded-md border border-border/55 bg-muted/20 px-2 py-1.5">
							<span class="mr-auto text-[10px] text-muted-foreground">
								Current:
								<span class="font-medium text-foreground">
									{focusedSpeaker?.id ?? '—'}
								</span>
							</span>
							<Button
								size="sm"
								variant="secondary"
								class="h-7 gap-1 px-1.5 text-[10px]"
								disabled={!focusedSpeaker || previewingId != null || !voxLoaded}
								onclick={() => onPreview(focusedSpeaker)}
							>
								{#if previewingId && focusedSpeaker && previewingId === focusedSpeaker.id}
									<LoaderCircle class="size-3 animate-spin" />
									Preview…
								{:else}
									<Play class="size-3" />
									Preview
								{/if}
							</Button>
							<Button
								size="sm"
								variant="outline"
								class="h-7 gap-1 px-1.5 text-[10px]"
								disabled={speakerBank.length < 2 || previewingId != null}
								onclick={onNextSpeaker}
							>
								<SkipForward class="size-3" />
								Next speaker
							</Button>
						</div>
						<ul class="max-h-64 space-y-2 overflow-auto pr-0.5">
							{#each projectStore.speakerBank as sp (sp.id)}
								{@const locking = projectStore.speakersLockingId === sp.id}
								{@const previewing = previewingId === sp.id}
								{@const focused = focusedSpeakerId === sp.id}
								{@const appliedSaved = sp.locked
									? projectStore.savedVoices.find(
											(v) =>
												v.refWavPath === sp.refWavPath ||
												(v.voiceId === sp.voiceId && v.name === sp.id)
										)
									: null}
								<li
									class="space-y-1.5 rounded border px-2 py-2 text-[10px] leading-snug {focused
										? 'border-primary/50 bg-primary/8 ring-1 ring-primary/25'
										: 'border-border/55 bg-muted/30'}"
									role="button"
									tabindex="0"
									onclick={() => focusSpeaker(sp.id)}
									onkeydown={(e) => {
										if (e.key === 'Enter' || e.key === ' ') {
											e.preventDefault();
											focusSpeaker(sp.id);
										}
									}}
								>
									<div class="flex items-center justify-between gap-2">
										<Input
											value={sp.id}
											class="h-7 flex-1 text-[11px] font-medium"
											aria-label="Speaker name"
											onblur={(e) => {
												const next = (e.currentTarget as HTMLInputElement).value.trim();
												if (next && next !== sp.id) {
													const prevId = sp.id;
													const ok = projectStore.updateSpeaker(sp.id, { id: next });
													if (!ok) {
														dndStore.flash('Could not rename (empty or duplicate)');
														e.currentTarget.value = sp.id;
													} else if (focusedSpeakerId === prevId) {
														focusedSpeakerId = next;
													}
												} else {
													e.currentTarget.value = sp.id;
												}
											}}
											onkeydown={(e) => {
												if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
											}}
										/>
										<span
											class="shrink-0 rounded border px-1.5 py-0.5 font-medium {sp.locked
												? 'border-emerald-600/35 bg-emerald-500/12 text-emerald-800 dark:text-emerald-200'
												: 'border-border/60 bg-background/60 text-muted-foreground'}"
										>
											{sp.locked ? 'Locked' : 'Not locked'}
										</span>
									</div>

									<div class="grid grid-cols-2 gap-1.5">
										<div class="space-y-0.5">
											<span class="text-muted-foreground">Gender</span>
											<Select.Root
												type="single"
												value={sp.gender}
												onValueChange={(v) => {
													if (v === 'female' || v === 'male' || v === 'neutral') {
														clearLastVoxcpmPreviewPath(resolvePreviewVoiceId(sp));
														projectStore.updateSpeaker(sp.id, { gender: v });
													}
												}}
											>
												<Select.Trigger class="h-7 w-full text-[10px]" aria-label="Gender">
													{genderLabel(sp.gender)}
												</Select.Trigger>
												<Select.Content>
													<Select.Item value="female" label="Female">Female</Select.Item>
													<Select.Item value="male" label="Male">Male</Select.Item>
													<Select.Item value="neutral" label="Neutral">Neutral</Select.Item>
												</Select.Content>
											</Select.Root>
										</div>
										<div class="space-y-0.5">
											<span class="text-muted-foreground">Preset</span>
											<Select.Root
												type="single"
												value={sp.voiceId}
												onValueChange={(v) => {
													if (v) {
														clearLastVoxcpmPreviewPath(resolvePreviewVoiceId(sp));
														projectStore.updateSpeaker(sp.id, { voiceId: v });
													}
												}}
											>
												<Select.Trigger class="h-7 w-full text-[10px]" aria-label="Voice preset">
													{presetLabel(sp.voiceId)}
												</Select.Trigger>
												<Select.Content>
													{#each voxcpmVoicesForGender(sp.gender) as v (v.id)}
														<Select.Item value={v.id} label={v.name}>{v.name}</Select.Item>
													{/each}
												</Select.Content>
											</Select.Root>
										</div>
									</div>

									<div class="space-y-0.5">
										<span class="text-muted-foreground">Saved voices (pick anytime)</span>
										<Select.Root
											type="single"
											value={appliedSaved?.id ?? ''}
											onValueChange={(v) => {
												if (!v || v === '__none__') return;
												onApplySaved(sp, v);
											}}
										>
											<Select.Trigger
												class="h-7 w-full text-[10px]"
												aria-label="Apply saved voice"
												onclick={(e) => e.stopPropagation()}
											>
												{appliedSaved
													? appliedSaved.name
													: projectStore.savedVoices.length
														? 'Select a saved voice…'
														: 'No saved voices yet — Lock one'}
											</Select.Trigger>
											<Select.Content>
												{#if projectStore.savedVoices.length}
													{#each projectStore.savedVoices as sv (sv.id)}
														<Select.Item value={sv.id} label={sv.name}>
															<span class="flex w-full items-center justify-between gap-2">
																<span class="truncate">{sv.name}</span>
																<span class="shrink-0 text-[9px] text-muted-foreground">
																	{genderLabel(sv.gender)} · {presetLabel(sv.voiceId)}
																</span>
															</span>
														</Select.Item>
													{/each}
												{:else}
													<Select.Item value="__none__" label="None" disabled
														>Lock a voice to save it here</Select.Item
													>
												{/if}
											</Select.Content>
										</Select.Root>
									</div>

									<div class="flex flex-wrap items-center gap-1">
										<span class="mr-auto text-muted-foreground">{sp.cueCount} cues</span>
										<Button
											size="sm"
											variant="ghost"
											class="h-7 gap-1 px-1.5 text-[10px]"
											disabled={previewing || locking || !voxLoaded}
											onclick={(e) => {
												e.stopPropagation();
												void onPreview(sp);
											}}
										>
											{#if previewing}
												<LoaderCircle class="size-3 animate-spin" />
												Preview…
											{:else}
												<Play class="size-3" />
												Preview
											{/if}
										</Button>
										<Button
											size="sm"
											variant={sp.locked ? 'outline' : 'default'}
											class="h-7 gap-1 px-1.5 text-[10px]"
											disabled={locking || previewing || !voxLoaded}
											onclick={(e) => {
												e.stopPropagation();
												void onLock(sp);
											}}
										>
											{#if locking}
												<LoaderCircle class="size-3 animate-spin" />
												Locking…
											{:else}
												<Lock class="size-3" />
												{sp.locked ? 'Re-lock' : 'Lock'}
											{/if}
										</Button>
										{#if sp.locked}
											<Button
												size="sm"
												variant="outline"
												class="h-7 gap-1 px-1.5 text-[10px]"
												disabled={locking || previewing}
												onclick={(e) => {
													e.stopPropagation();
													onClear(sp);
												}}
											>
												<LockOpen class="size-3" />
												Clear
											</Button>
										{/if}
									</div>
								</li>
							{/each}
						</ul>
						{#if projectStore.savedVoices.length}
							<div class="space-y-1 rounded-md border border-border/50 bg-muted/15 px-2 py-1.5">
								<p class="text-[10px] font-medium text-foreground/80">Library (survives New / close)</p>
								<ul class="max-h-28 space-y-0.5 overflow-auto">
									{#each projectStore.savedVoices as sv (sv.id)}
										<li class="flex items-center gap-1 text-[10px]">
											<span class="min-w-0 flex-1 truncate"
												>{sv.name}
												<span class="text-muted-foreground">
													· {genderLabel(sv.gender)} · {presetLabel(sv.voiceId)}</span
												></span
											>
											<Button
												size="sm"
												variant="ghost"
												class="h-6 shrink-0 px-1 text-muted-foreground"
												title="Remove from library"
												onclick={() => onDeleteSaved(sv.id)}
											>
												<Trash2 class="size-3" />
											</Button>
										</li>
									{/each}
								</ul>
							</div>
						{/if}
					{:else}
						<p class="text-[10px] leading-snug text-muted-foreground">
							Choose a count and press <span class="font-medium text-foreground">Set speakers</span>
							(or just <span class="font-medium text-foreground">Done</span> — it applies the count).
							Then set Male/Female + preset, Preview until you like it, and Lock — that also saves
							to your library for next time.
						</p>
						{#if projectStore.savedVoices.length}
							<p class="text-[10px] text-muted-foreground">
								You already have {projectStore.savedVoices.length} saved voice{projectStore
									.savedVoices.length === 1
									? ''
									: 's'} — Set speakers, then pick from Saved voices.
							</p>
						{/if}
					{/if}
					{#if projectStore.speakersError}
						<p class="text-[10px] text-destructive whitespace-pre-wrap">
							{projectStore.speakersError}
						</p>
					{/if}
				</section>
			{/if}
		</div>

		<Dialog.Footer>
			<Button class="h-8" onclick={onDone}>Done</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
