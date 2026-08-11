/**
 * Studio chrome: which setup dialogs are open (menus / pipeline buttons).
 * Keeps Paste draft across open/close so New/Open can clear it from project store effects.
 */

export type SubtitleDialogTab = 'paste' | 'import' | 'style' | 'translate';

let subtitleOpen = $state(false);
let subtitleTab = $state<SubtitleDialogTab>('paste');
let tempoOpen = $state(false);
let voiceEngineOpen = $state(false);
let prosodyOpen = $state(false);

let scriptDraft = $state('');
let scriptFeedback = $state<string | null>(null);
/** Default true = fit lines to Extract span / create cues. False = merge into FunASR count. */
let createExtraCues = $state(true);

export const studioUi = {
	get subtitleOpen() {
		return subtitleOpen;
	},
	set subtitleOpen(v: boolean) {
		subtitleOpen = v;
	},
	get subtitleTab() {
		return subtitleTab;
	},
	set subtitleTab(v: SubtitleDialogTab) {
		subtitleTab = v;
	},
	openSubtitle(tab: SubtitleDialogTab = 'paste') {
		subtitleTab = tab;
		subtitleOpen = true;
	},

	get tempoOpen() {
		return tempoOpen;
	},
	set tempoOpen(v: boolean) {
		tempoOpen = v;
	},
	openTempo() {
		tempoOpen = true;
	},

	get voiceEngineOpen() {
		return voiceEngineOpen;
	},
	set voiceEngineOpen(v: boolean) {
		voiceEngineOpen = v;
	},
	openVoiceEngine() {
		voiceEngineOpen = true;
	},

	get prosodyOpen() {
		return prosodyOpen;
	},
	set prosodyOpen(v: boolean) {
		prosodyOpen = v;
	},
	openProsody() {
		prosodyOpen = true;
	},

	get scriptDraft() {
		return scriptDraft;
	},
	set scriptDraft(v: string) {
		scriptDraft = v;
	},
	get scriptFeedback() {
		return scriptFeedback;
	},
	set scriptFeedback(v: string | null) {
		scriptFeedback = v;
	},
	get createExtraCues() {
		return createExtraCues;
	},
	set createExtraCues(v: boolean) {
		createExtraCues = v;
	},

	/** Clear paste draft when project changes (New / Open). */
	clearPasteDraft() {
		scriptDraft = '';
		scriptFeedback = null;
	}
};
