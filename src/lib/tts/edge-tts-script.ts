/** Shared Khmer-script helpers for Edge-TTS voice routing. */

/** Khmer letters + symbols (U+1780–17FF) and Khmer symbols block. */
export function textContainsKhmer(text: string): boolean {
	return /[\u1780-\u17FF\u19E0-\u19FF]/.test(text);
}
