/**
 * Create a project-local Python venv and install VoxCPM2 for optional local TTS.
 *
 * Usage: pnpm voxcpm:setup
 *
 * Installs into: .venv-voxcpm/
 * First Generate with VoxCPM downloads model weights from Hugging Face (~5GB).
 * Needs NVIDIA GPU for usable speed (RTX 1070 8GB is tight for VoxCPM2).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const venvDir = join(root, '.venv-voxcpm');
const isWin = process.platform === 'win32';
const pythonBin = isWin
	? join(venvDir, 'Scripts', 'python.exe')
	: join(venvDir, 'bin', 'python');
const marker = join(venvDir, '.pdp-voxcpm-ready');

function runPython(pythonExe, args) {
	console.log(`> ${pythonExe} ${args.join(' ')}`);
	execFileSync(pythonExe, args, { stdio: 'inherit', env: process.env });
}

function resolveSystemPython() {
	const tries = isWin
		? [
				{ cmd: 'py', args: ['-3', '-c', 'import sys; print(sys.executable)'] },
				{ cmd: 'python', args: ['-c', 'import sys; print(sys.executable)'] },
				{ cmd: 'python3', args: ['-c', 'import sys; print(sys.executable)'] }
			]
		: [
				{ cmd: 'python3', args: ['-c', 'import sys; print(sys.executable)'] },
				{ cmd: 'python', args: ['-c', 'import sys; print(sys.executable)'] }
			];

	for (const t of tries) {
		try {
			const out = execFileSync(t.cmd, t.args, { encoding: 'utf8' }).trim();
			if (out && existsSync(out)) return out;
		} catch {
			/* try next */
		}
	}
	throw new Error(
		'Python 3.10+ not found. Install Python from python.org (enable “Add to PATH”), then re-run: pnpm voxcpm:setup'
	);
}

function main() {
	mkdirSync(join(root, 'scripts', 'tts'), { recursive: true });

	if (existsSync(pythonBin) && existsSync(marker)) {
		console.log(`VoxCPM venv already ready: ${pythonBin}`);
		console.log('To force reinstall, delete .venv-voxcpm and run again.');
		return;
	}

	const systemPy = resolveSystemPython();
	console.log(`System Python: ${systemPy}`);

	if (!existsSync(pythonBin)) {
		console.log('Creating VoxCPM virtualenv…');
		if (existsSync(venvDir)) {
			rmSync(venvDir, { recursive: true, force: true });
		}
		runPython(systemPy, ['-m', 'venv', venvDir]);
	}

	if (!existsSync(pythonBin)) {
		throw new Error(
			`venv python missing at ${pythonBin}. Try deleting .venv-voxcpm and re-running.`
		);
	}

	console.log('Upgrading pip…');
	runPython(pythonBin, ['-m', 'pip', 'install', '-U', 'pip', 'setuptools', 'wheel']);

	// cu118 still supports Pascal (GTX 10-series / RTX 1070).
	console.log('Installing PyTorch (CUDA 11.8) + VoxCPM…');
	runPython(pythonBin, [
		'-m',
		'pip',
		'install',
		'-U',
		'torch',
		'torchaudio',
		'--index-url',
		'https://download.pytorch.org/whl/cu118'
	]);
	runPython(pythonBin, ['-m', 'pip', 'install', '-U', 'voxcpm', 'soundfile', 'numpy']);

	writeFileSync(
		marker,
		JSON.stringify(
			{
				readyAt: new Date().toISOString(),
				model: 'openbmb/VoxCPM2',
				torchIndex: 'cu118',
				python: pythonBin,
				note: 'First synthesize downloads ~5GB weights. VRAM ~8GB for VoxCPM2.'
			},
			null,
			2
		),
		'utf8'
	);

	console.log('');
	console.log('VoxCPM setup complete.');
	console.log(`Python: ${pythonBin}`);
	console.log('In the app: Settings → TTS engine → VoxCPM2 (local).');
	console.log('First Generate downloads openbmb/VoxCPM2 (~5GB, one-time).');
	console.log('Edge TTS remains the default (no GPU / no download).');
}

try {
	main();
} catch (err) {
	console.error(err);
	process.exit(1);
}
