/**
 * Ensure a platform-specific FFmpeg binary exists for Tauri externalBin.
 * Downloads once into src-tauri/binaries/ffmpeg-<target-triple>[.exe]
 *
 * Usage: pnpm ffmpeg:download
 */
import { execFileSync, execSync } from 'node:child_process';
import {
	copyFileSync,
	createReadStream,
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
import { createGunzip } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const binariesDir = join(root, 'src-tauri', 'binaries');

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

function sidecarPath(triple) {
	const ext = process.platform === 'win32' ? '.exe' : '';
	return join(binariesDir, `ffmpeg-${triple}${ext}`);
}

async function download(url, dest) {
	console.log(`Downloading ${url}`);
	const res = await fetch(url, { redirect: 'follow' });
	if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
	await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

function findFileRecursive(dir, names) {
	const want = new Set(names);
	const stack = [dir];
	while (stack.length) {
		const cur = stack.pop();
		for (const ent of readdirSync(cur, { withFileTypes: true })) {
			const p = join(cur, ent.name);
			if (ent.isDirectory()) stack.push(p);
			else if (want.has(ent.name)) return p;
		}
	}
	return null;
}

async function ensureWindows(_triple, outPath) {
	const work = join(tmpdir(), `pdp-ffmpeg-${Date.now()}`);
	mkdirSync(work, { recursive: true });
	const zipPath = join(work, 'ffmpeg.zip');
	try {
		await download('https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip', zipPath);
		execFileSync(
			'powershell.exe',
			[
				'-NoProfile',
				'-Command',
				`Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${work}' -Force`
			],
			{ stdio: 'inherit' }
		);
		const exe = findFileRecursive(work, ['ffmpeg.exe']);
		if (!exe) throw new Error('ffmpeg.exe not found inside downloaded archive');
		copyFileSync(exe, outPath);
		console.log(`Installed bundled FFmpeg → ${outPath}`);
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

async function ensureGzipBinary(url, outPath) {
	const work = join(tmpdir(), `pdp-ffmpeg-${Date.now()}`);
	mkdirSync(work, { recursive: true });
	try {
		const gz = join(work, 'ffmpeg.gz');
		await download(url, gz);
		await pipeline(createReadStream(gz), createGunzip(), createWriteStream(outPath));
		execSync(`chmod +x "${outPath}"`);
		console.log(`Installed bundled FFmpeg → ${outPath}`);
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

async function main() {
	const triple = hostTriple();
	if (!triple) {
		console.error('Could not detect Rust host triple. Is rustc installed?');
		process.exit(1);
	}

	mkdirSync(binariesDir, { recursive: true });
	const outPath = sidecarPath(triple);

	if (existsSync(outPath) && statSync(outPath).size > 1_000_000) {
		console.log(`Bundled FFmpeg already present: ${outPath}`);
		return;
	}

	console.log(`Preparing FFmpeg sidecar for ${triple}…`);

	if (process.platform === 'win32') {
		await ensureWindows(triple, outPath);
	} else if (process.platform === 'darwin') {
		const url =
			triple === 'aarch64-apple-darwin'
				? 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/ffmpeg-darwin-arm64.gz'
				: 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/ffmpeg-darwin-x64.gz';
		await ensureGzipBinary(url, outPath);
	} else if (process.platform === 'linux') {
		const arch = triple.includes('aarch64') ? 'arm64' : 'x64';
		await ensureGzipBinary(
			`https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/ffmpeg-linux-${arch}.gz`,
			outPath
		);
	} else {
		console.error(`Unsupported platform: ${process.platform}`);
		process.exit(1);
	}

	if (!existsSync(outPath)) {
		console.error('FFmpeg sidecar was not created.');
		process.exit(1);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
