/**
 * Ensure a platform-specific yt-dlp binary for URL media import.
 * Downloads once into src-tauri/binaries/yt-dlp-<target-triple>[.exe]
 *
 * Usage: pnpm ytdlp:download
 */
import { execSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, chmodSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const binariesDir = join(root, 'src-tauri', 'binaries');

function hostTriple() {
	try {
		return execSync('rustc -vV', { encoding: 'utf8' })
			.split('\n')
			.find((l) => l.startsWith('host:'))
			?.split(':')[1]
			?.trim();
	} catch {
		return null;
	}
}

function releaseAssetName() {
	const plat = process.platform;
	const arch = process.arch;
	if (plat === 'win32' && arch === 'x64') return 'yt-dlp.exe';
	if (plat === 'win32' && arch === 'arm64') return 'yt-dlp_arm64.exe';
	if (plat === 'darwin' && arch === 'arm64') return 'yt-dlp_macos';
	if (plat === 'darwin' && arch === 'x64') return 'yt-dlp_macos';
	if (plat === 'linux' && arch === 'x64') return 'yt-dlp_linux';
	if (plat === 'linux' && arch === 'arm64') return 'yt-dlp_linux_aarch64';
	return 'yt-dlp';
}

function sidecarPath(triple) {
	const ext = process.platform === 'win32' ? '.exe' : '';
	return join(binariesDir, `yt-dlp-${triple}${ext}`);
}

async function download(url, dest) {
	console.log(`Downloading ${url}`);
	const res = await fetch(url, {
		redirect: 'follow',
		headers: { 'User-Agent': 'ProfessorDubbedPro-ytdlp-setup' }
	});
	if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
	await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
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
		console.log(`Bundled yt-dlp already present: ${outPath}`);
		return;
	}

	const asset = releaseAssetName();
	const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`;
	console.log(`Preparing yt-dlp sidecar for ${triple}…`);
	await download(url, outPath);
	if (process.platform !== 'win32') {
		chmodSync(outPath, 0o755);
	}
	console.log(`Installed bundled yt-dlp → ${outPath}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
