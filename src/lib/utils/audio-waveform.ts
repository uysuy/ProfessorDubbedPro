/**
 * Decode media (video/audio file) and build normalized waveform peaks
 * for the Original Audio timeline track.
 */

export interface WaveformExtractResult {
	peaks: number[];
	durationMs: number;
	sampleRate: number;
}

function mixDown(buffer: AudioBuffer): Float32Array {
	const { numberOfChannels, length } = buffer;
	if (numberOfChannels === 1) return buffer.getChannelData(0).slice(0);

	const mixed = new Float32Array(length);
	for (let ch = 0; ch < numberOfChannels; ch++) {
		const data = buffer.getChannelData(ch);
		for (let i = 0; i < length; i++) mixed[i] += data[i];
	}
	const inv = 1 / numberOfChannels;
	for (let i = 0; i < length; i++) mixed[i] *= inv;
	return mixed;
}

/** Downsample PCM into [0,1] peak bars (max abs per bucket). */
export function peaksFromChannelData(samples: Float32Array, barCount: number): number[] {
	const count = Math.max(8, Math.floor(barCount));
	const peaks = new Array<number>(count).fill(0);
	const bucket = Math.max(1, Math.floor(samples.length / count));

	for (let i = 0; i < count; i++) {
		const start = i * bucket;
		const end = Math.min(samples.length, start + bucket);
		let peak = 0;
		for (let j = start; j < end; j++) {
			const v = Math.abs(samples[j] ?? 0);
			if (v > peak) peak = v;
		}
		peaks[i] = peak;
	}

	// Normalize so quiet dialogue still reads on the timeline.
	let max = 0;
	for (const p of peaks) if (p > max) max = p;
	if (max < 1e-6) return peaks.map(() => 0.04);

	const gain = 1 / max;
	return peaks.map((p) => Math.max(0.04, Math.min(1, p * gain)));
}

/** Resample peak bars to match a pixel width (keeps zoomed-out waveforms from looking chunky). */
export function resamplePeaks(peaks: number[], targetCount: number): number[] {
	const n = Math.max(8, Math.floor(targetCount));
	if (!peaks.length) return new Array(n).fill(0.04);
	if (peaks.length === n) return peaks;

	const out = new Array<number>(n);
	for (let i = 0; i < n; i++) {
		const start = Math.floor((i / n) * peaks.length);
		const end = Math.max(start + 1, Math.floor(((i + 1) / n) * peaks.length));
		let peak = 0;
		for (let j = start; j < end && j < peaks.length; j++) {
			const v = peaks[j] ?? 0;
			if (v > peak) peak = v;
		}
		out[i] = peak;
	}
	return out;
}

/**
 * Extract waveform peaks from a local media File (typically the source video).
 * Uses Web Audio `decodeAudioData` — works for most MP4/WebM audio in Chromium/WebView2.
 */
export async function extractWaveformFromFile(
	file: File,
	barCount = 360
): Promise<WaveformExtractResult> {
	const ctx = new AudioContext();
	try {
		const arrayBuffer = await file.arrayBuffer();
		// decodeAudioData may detach the buffer — pass a copy.
		const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
		const mono = mixDown(audioBuffer);
		const peaks = peaksFromChannelData(mono, barCount);
		return {
			peaks,
			durationMs: Math.round(audioBuffer.duration * 1000),
			sampleRate: audioBuffer.sampleRate
		};
	} finally {
		await ctx.close().catch(() => undefined);
	}
}

/**
 * Extract waveform peaks from a media URL (`convertFileSrc`, blob:, http(s):).
 */
export async function extractWaveformFromUrl(
	url: string,
	barCount = 360
): Promise<WaveformExtractResult> {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`Could not load audio (${res.status}).`);
	const arrayBuffer = await res.arrayBuffer();
	const ctx = new AudioContext();
	try {
		const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
		const mono = mixDown(audioBuffer);
		const peaks = peaksFromChannelData(mono, barCount);
		return {
			peaks,
			durationMs: Math.round(audioBuffer.duration * 1000),
			sampleRate: audioBuffer.sampleRate
		};
	} finally {
		await ctx.close().catch(() => undefined);
	}
}
