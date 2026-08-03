import type { MediaKind } from '$lib/types/project';

export function classifyMediaFile(file: File): MediaKind | null {
	const name = file.name.toLowerCase();
	const type = file.type.toLowerCase();

	if (type.startsWith('video/') || /\.(mp4|mov|mkv|webm|m4v|avi)$/i.test(name)) {
		return 'video';
	}
	if (type.startsWith('audio/') || /\.(wav|mp3|flac|aac|m4a|ogg|wma)$/i.test(name)) {
		return 'audio';
	}
	if (
		type.includes('subrip') ||
		type.includes('ttml') ||
		/\.(srt|vtt|ass|ssa|sbv|txt)$/i.test(name)
	) {
		return 'subtitle';
	}
	return null;
}

export function isFileDrag(e: DragEvent) {
	const types = e.dataTransfer?.types;
	if (!types) return false;
	return Array.from(types).includes('Files');
}
