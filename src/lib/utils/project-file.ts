import type { DubbingProject } from '$lib/types/project';
import { parseProject, serializeProject } from '$lib/utils/project-io';
import { isTauriRuntime } from '$lib/utils/platform';

export const PROJECT_FILE_FORMAT = 'professor-dubbed-pro' as const;
export const PROJECT_FILE_VERSION = 1;
export const PROJECT_FILE_EXTENSION = 'dubproj';
/** localStorage key for crash-recovery snapshots */
export const RECOVERY_STORAGE_KEY = 'pdp.recoveryProject';
export const RECOVERY_FILE_NAME = 'recovery.dubproj';

export type ProjectSessionState = {
	playheadMs?: number;
	voiceId?: string;
	pitch?: number;
	speed?: number;
	volume?: number;
};

/** On-disk project document (.dubproj / .json). */
export type ProjectFileDocument = {
	format: typeof PROJECT_FILE_FORMAT;
	version: number;
	savedAt: string;
	project: DubbingProject;
	session?: ProjectSessionState;
};

/** Crash-recovery envelope (localStorage + optional app-data file). */
export type RecoveryDocument = ProjectFileDocument & {
	recovery: true;
	dirty: boolean;
	/** Last known user project path (may be null). */
	projectFilePath: string | null;
	/** Absolute video path when known. */
	videoPath: string | null;
};

export function buildProjectDocument(
	project: DubbingProject,
	session?: ProjectSessionState
): ProjectFileDocument {
	return {
		format: PROJECT_FILE_FORMAT,
		version: PROJECT_FILE_VERSION,
		savedAt: new Date().toISOString(),
		project: serializeProject(project),
		session: session
			? {
					playheadMs: session.playheadMs,
					voiceId: session.voiceId,
					pitch: session.pitch,
					speed: session.speed,
					volume: session.volume
				}
			: undefined
	};
}

export function buildRecoveryDocument(opts: {
	project: DubbingProject;
	session?: ProjectSessionState;
	dirty: boolean;
	projectFilePath: string | null;
	videoPath: string | null;
}): RecoveryDocument {
	const base = buildProjectDocument(opts.project, opts.session);
	return {
		...base,
		recovery: true,
		dirty: opts.dirty,
		projectFilePath: opts.projectFilePath,
		videoPath: opts.videoPath
	};
}

export function parseRecoveryDocument(raw: unknown): RecoveryDocument | null {
	const doc = parseProjectDocument(raw);
	if (!doc) return null;
	if (!isRecord(raw) || raw.recovery !== true) {
		// Accept a normal project doc as recovery fallback.
		return {
			...doc,
			recovery: true,
			dirty: true,
			projectFilePath: null,
			videoPath: null
		};
	}
	return {
		...doc,
		recovery: true,
		dirty: raw.dirty !== false,
		projectFilePath: typeof raw.projectFilePath === 'string' ? raw.projectFilePath : null,
		videoPath: typeof raw.videoPath === 'string' ? raw.videoPath : null
	};
}

/** Sync recovery write — safe for beforeunload. */
export function saveRecoveryToLocalStorage(doc: RecoveryDocument): boolean {
	try {
		localStorage.setItem(RECOVERY_STORAGE_KEY, JSON.stringify(doc));
		return true;
	} catch {
		return false;
	}
}

export function loadRecoveryFromLocalStorage(): RecoveryDocument | null {
	try {
		const raw = localStorage.getItem(RECOVERY_STORAGE_KEY);
		if (!raw) return null;
		return parseRecoveryDocument(JSON.parse(raw));
	} catch {
		return null;
	}
}

export function clearRecoveryLocalStorage(): void {
	try {
		localStorage.removeItem(RECOVERY_STORAGE_KEY);
	} catch {
		/* ignore */
	}
}

/** Best-effort recovery file under the app data directory (Tauri). */
export async function saveRecoveryToAppData(doc: RecoveryDocument): Promise<boolean> {
	if (!isTauriRuntime()) return false;
	try {
		const { BaseDirectory, mkdir, writeTextFile } = await import('@tauri-apps/plugin-fs');
		await mkdir('recovery', { baseDir: BaseDirectory.AppData, recursive: true });
		await writeTextFile(`recovery/${RECOVERY_FILE_NAME}`, `${JSON.stringify(doc, null, 2)}\n`, {
			baseDir: BaseDirectory.AppData
		});
		return true;
	} catch {
		return false;
	}
}

export async function loadRecoveryFromAppData(): Promise<RecoveryDocument | null> {
	if (!isTauriRuntime()) return null;
	try {
		const { BaseDirectory, readTextFile, exists } = await import('@tauri-apps/plugin-fs');
		const path = `recovery/${RECOVERY_FILE_NAME}`;
		if (!(await exists(path, { baseDir: BaseDirectory.AppData }))) return null;
		const text = await readTextFile(path, { baseDir: BaseDirectory.AppData });
		return parseRecoveryDocument(JSON.parse(text));
	} catch {
		return null;
	}
}

export async function clearRecoveryAppData(): Promise<void> {
	if (!isTauriRuntime()) return;
	try {
		const { BaseDirectory, remove } = await import('@tauri-apps/plugin-fs');
		await remove(`recovery/${RECOVERY_FILE_NAME}`, { baseDir: BaseDirectory.AppData });
	} catch {
		/* ignore */
	}
}

/**
 * Quiet overwrite of an existing project file (no dialog).
 */
export async function writeProjectFileQuiet(
	filePath: string,
	document: ProjectFileDocument
): Promise<boolean> {
	if (!filePath.trim()) return false;
	const json = `${JSON.stringify(document, null, 2)}\n`;
	if (!isTauriRuntime()) return false;
	try {
		const { writeTextFile } = await import('@tauri-apps/plugin-fs');
		await writeTextFile(filePath, json);
		return true;
	} catch {
		return false;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value != null && !Array.isArray(value);
}

/** Parse and validate a project file payload. */
export function parseProjectDocument(raw: unknown): ProjectFileDocument | null {
	if (!isRecord(raw)) return null;

	// Accept both wrapped documents and legacy bare DubbingProject JSON.
	if (raw.format === PROJECT_FILE_FORMAT || raw.version != null || isRecord(raw.project)) {
		if (raw.format != null && raw.format !== PROJECT_FILE_FORMAT) return null;
		const project = parseProject(raw.project ?? raw);
		if (!project) return null;
		const session = isRecord(raw.session)
			? {
					playheadMs: Number.isFinite(Number(raw.session.playheadMs))
						? Number(raw.session.playheadMs)
						: undefined,
					voiceId: typeof raw.session.voiceId === 'string' ? raw.session.voiceId : undefined,
					pitch: Number.isFinite(Number(raw.session.pitch)) ? Number(raw.session.pitch) : undefined,
					speed: Number.isFinite(Number(raw.session.speed)) ? Number(raw.session.speed) : undefined,
					volume: Number.isFinite(Number(raw.session.volume))
						? Number(raw.session.volume)
						: undefined
				}
			: undefined;
		return {
			format: PROJECT_FILE_FORMAT,
			version: Number.isFinite(Number(raw.version)) ? Number(raw.version) : 1,
			savedAt: typeof raw.savedAt === 'string' ? raw.savedAt : new Date().toISOString(),
			project,
			session
		};
	}

	const project = parseProject(raw);
	if (!project) return null;
	return {
		format: PROJECT_FILE_FORMAT,
		version: 1,
		savedAt: project.updatedAt,
		project
	};
}

export function looksLikeAbsolutePath(path: string): boolean {
	const p = path.trim();
	if (!p) return false;
	if (p.startsWith('\\\\') || p.startsWith('/')) return true;
	return /^[a-zA-Z]:[\\/]/.test(p);
}

function downloadText(filename: string, content: string) {
	const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	a.click();
	URL.revokeObjectURL(url);
}

function ensureExtension(path: string, ext: string): string {
	const lower = path.toLowerCase();
	if (lower.endsWith(`.${ext}`) || lower.endsWith('.json')) return path;
	return `${path}.${ext}`;
}

export type SaveProjectFileOptions = {
	document: ProjectFileDocument;
	/** Existing project file path — when set, overwrite without a dialog. */
	filePath?: string | null;
	/** Suggested filename stem for the save dialog. */
	suggestedName?: string;
	/** Force showing the save dialog even when filePath is set. */
	saveAs?: boolean;
};

/**
 * Save project JSON via Tauri dialog + fs (or browser download fallback).
 * Returns the written path (or download filename in browser).
 */
export async function saveProjectFile(opts: SaveProjectFileOptions): Promise<string> {
	const json = `${JSON.stringify(opts.document, null, 2)}\n`;
	const stem =
		(opts.suggestedName ?? opts.document.project.name)
			.trim()
			.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '_')
			.replace(/\s+/g, ' ')
			.slice(0, 80) || 'project';

	if (!isTauriRuntime()) {
		const filename = `${stem}.${PROJECT_FILE_EXTENSION}`;
		downloadText(filename, json);
		return filename;
	}

	const { save } = await import('@tauri-apps/plugin-dialog');
	const { writeTextFile } = await import('@tauri-apps/plugin-fs');

	let target = opts.saveAs ? null : opts.filePath?.trim() || null;
	if (!target) {
		const picked = await save({
			title: 'Save project',
			defaultPath: `${stem}.${PROJECT_FILE_EXTENSION}`,
			filters: [
				{ name: 'Dubbing Project', extensions: [PROJECT_FILE_EXTENSION, 'json'] },
				{ name: 'JSON', extensions: ['json'] }
			]
		});
		if (!picked) throw new Error('Save cancelled.');
		target = ensureExtension(picked, PROJECT_FILE_EXTENSION);
	}

	await writeTextFile(target, json);
	return target;
}

/**
 * Open a project file via Tauri dialog + fs (or browser file picker).
 */
export async function openProjectFile(): Promise<{ path: string; document: ProjectFileDocument }> {
	if (!isTauriRuntime()) {
		const file = await pickBrowserFile();
		const text = await file.text();
		const document = parseProjectDocument(JSON.parse(text));
		if (!document) throw new Error('Invalid project file.');
		return { path: file.name, document };
	}

	const { open } = await import('@tauri-apps/plugin-dialog');
	const { readTextFile } = await import('@tauri-apps/plugin-fs');

	const picked = await open({
		title: 'Open project',
		multiple: false,
		filters: [
			{ name: 'Dubbing Project', extensions: [PROJECT_FILE_EXTENSION, 'json'] },
			{ name: 'JSON', extensions: ['json'] }
		]
	});
	if (!picked || Array.isArray(picked)) throw new Error('Open cancelled.');

	const text = await readTextFile(picked);
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new Error('Project file is not valid JSON.');
	}
	const document = parseProjectDocument(raw);
	if (!document) throw new Error('Unrecognized or invalid project file.');
	return { path: picked, document };
}

function pickBrowserFile(): Promise<File> {
	return new Promise((resolve, reject) => {
		const input = document.createElement('input');
		input.type = 'file';
		input.accept = `.${PROJECT_FILE_EXTENSION},.json,application/json`;
		input.onchange = () => {
			const file = input.files?.[0];
			if (file) resolve(file);
			else reject(new Error('Open cancelled.'));
		};
		input.oncancel = () => reject(new Error('Open cancelled.'));
		input.click();
	});
}
