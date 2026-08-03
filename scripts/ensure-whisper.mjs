/**
 * Ensure whisper.cpp CLI + Whisper GGML models exist for local transcription.
 * Downloads into:
 *   src-tauri/binaries/whisper-cli-<target-triple>[.exe] (+ Windows DLLs)
 *   src-tauri/models/ggml-small.bin  (default — better Chinese accuracy)
 *   src-tauri/models/ggml-base.bin   (fast fallback)
 *
 * Usage: pnpm whisper:download
 *        pnpm whisper:download -- --base-only
 */
import { execFileSync, execSync } from 'node:child_process';
import {
	chmodSync,
	copyFileSync,
	createWriteStream,
	existsSync,
	mkdirSync,
	readdirSync,
	rmSync,
	statSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const binariesDir = join(root, 'src-tauri', 'binaries');
const modelsDir = join(root, 'src-tauri', 'models');

const WHISPER_RELEASE = 'v1.9.1';
const MODELS = [
	{
		name: 'ggml-small.bin',
		url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin',
		minBytes: 200_000_000
	},
	{
		name: 'ggml-base.bin',
		url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
		minBytes: 50_000_000
	}
];

const baseOnly = process.argv.includes('--base-only');

function hostTriple() {
	try {
		return execSync('rustc --print host-tuple', { encoding: 'utf8' }).trim();
	} catch {
		return execSync('rustc -vV', { encoding: 'utf8' })
			.split('\n')
			.find((l) => l.startsWith('host:'))
			?.split(':')[1]
			?.trim();
	}
}

function cliOutPath(triple) {
	const ext = process.platform === 'win32' ? '.exe' : '';
	return join(binariesDir, `whisper-cli-${triple}${ext}`);
}

async function download(url, dest) {
	console.log(`Downloading ${url}`);
	const res = await fetch(url, { redirect: 'follow' });
	if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
	await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

function findBestWhisperCli(dir) {
	// Prefer the real binary (Release/whisper-cli.exe). Ignore tiny deprecation stubs
	// that print "use whisper-whisper-cli instead" (~27KB).
	const candidates = [];
	const stack = [dir];
	while (stack.length) {
		const cur = stack.pop();
		for (const ent of readdirSync(cur, { withFileTypes: true })) {
			const p = join(cur, ent.name);
			if (ent.isDirectory()) {
				stack.push(p);
				continue;
			}
			const lower = ent.name.toLowerCase();
			if (lower === 'whisper-cli.exe' || lower === 'whisper-cli') {
				candidates.push(p);
			}
		}
	}
	if (!candidates.length) return null;
	candidates.sort((a, b) => statSync(b).size - statSync(a).size);
	const best = candidates[0];
	if (statSync(best).size < 100_000) {
		throw new Error(
			`Found whisper-cli but it looks like a deprecation stub (${statSync(best).size} bytes).`
		);
	}
	return best;
}

function copyDlls(fromDir, toDir) {
	for (const ent of readdirSync(fromDir, { withFileTypes: true })) {
		if (!ent.isFile()) continue;
		const lower = ent.name.toLowerCase();
		if (!lower.endsWith('.dll')) continue;
		copyFileSync(join(fromDir, ent.name), join(toDir, ent.name));
		console.log(`Copied ${ent.name}`);
	}
}

async function ensureWindows(triple, outPath) {
	const work = join(tmpdir(), `pdp-whisper-${Date.now()}`);
	mkdirSync(work, { recursive: true });
	const zipPath = join(work, 'whisper.zip');
	try {
		await download(
			`https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_RELEASE}/whisper-bin-x64.zip`,
			zipPath
		);
		execFileSync(
			'powershell.exe',
			[
				'-NoProfile',
				'-Command',
				`Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${work}' -Force`
			],
			{ stdio: 'inherit' }
		);
		const exe = findBestWhisperCli(work);
		if (!exe) throw new Error('whisper-cli.exe not found in whisper-bin-x64.zip');
		copyFileSync(exe, outPath);
		copyDlls(dirname(exe), binariesDir);
		console.log(`Installed ${outPath} (${statSync(outPath).size} bytes)`);
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

async function ensureUnixTarGz(url, outPath) {
	const work = join(tmpdir(), `pdp-whisper-${Date.now()}`);
	mkdirSync(work, { recursive: true });
	const tarPath = join(work, 'whisper.tar.gz');
	try {
		await download(url, tarPath);
		execFileSync('tar', ['-xzf', tarPath, '-C', work], { stdio: 'inherit' });
		const bin = findBestWhisperCli(work);
		if (!bin) throw new Error('whisper-cli not found in archive');
		copyFileSync(bin, outPath);
		chmodSync(outPath, 0o755);
		console.log(`Installed ${outPath} (${statSync(outPath).size} bytes)`);
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

async function ensureModel({ name, url, minBytes }) {
	mkdirSync(modelsDir, { recursive: true });
	const dest = join(modelsDir, name);
	if (existsSync(dest) && statSync(dest).size > minBytes) {
		console.log(`Whisper model already present: ${dest}`);
		return dest;
	}
	await download(url, dest);
	const size = statSync(dest).size;
	if (size < minBytes) {
		rmSync(dest, { force: true });
		throw new Error(`Downloaded ${name} looks incomplete (${size} bytes)`);
	}
	console.log(`Installed model ${dest} (${(size / 1e6).toFixed(0)} MB)`);
	return dest;
}

async function main() {
	const triple = hostTriple();
	if (!triple) throw new Error('Could not detect rustc host triple');
	mkdirSync(binariesDir, { recursive: true });

	const outPath = cliOutPath(triple);
	const needsCli =
		!existsSync(outPath) ||
		statSync(outPath).size < 100_000; // rebuild if deprecation stub was installed
	if (!needsCli) {
		console.log(`whisper-cli already present: ${outPath}`);
	} else if (process.platform === 'win32') {
		await ensureWindows(triple, outPath);
	} else if (process.platform === 'linux') {
		const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
		await ensureUnixTarGz(
			`https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_RELEASE}/whisper-bin-ubuntu-${arch}.tar.gz`,
			outPath
		);
	} else if (process.platform === 'darwin') {
		console.warn(
			'No official macOS whisper-cli zip in this release. Install whisper-cli on PATH, or build whisper.cpp and copy to:',
			outPath
		);
	} else {
		throw new Error(`Unsupported platform: ${process.platform}`);
	}

	const wanted = baseOnly
		? MODELS.filter((m) => m.name === 'ggml-base.bin')
		: MODELS;
	for (const model of wanted) {
		await ensureModel(model);
	}
	console.log('Whisper setup complete.');
	if (!baseOnly) {
		console.log('Default Extract Subs model: ggml-small.bin (more accurate Chinese).');
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
