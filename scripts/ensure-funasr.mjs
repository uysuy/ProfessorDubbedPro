/**
 * Create a project-local Python venv and install FunASR (SenseVoice) for Chinese ASR.
 *
 * Usage: pnpm funasr:setup
 *
 * Installs into: .venv-funasr/
 * First transcription may download SenseVoice / VAD weights from ModelScope.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const venvDir = join(root, '.venv-funasr');
const isWin = process.platform === 'win32';
const pythonBin = isWin
	? join(venvDir, 'Scripts', 'python.exe')
	: join(venvDir, 'bin', 'python');
const marker = join(venvDir, '.pdp-funasr-ready');

function runPython(pythonExe, args) {
	console.log(`> ${pythonExe} ${args.join(' ')}`);
	execFileSync(pythonExe, args, { stdio: 'inherit' });
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
		'Python 3.10+ not found. Install Python from python.org (enable “Add to PATH”), then re-run: pnpm funasr:setup'
	);
}

function main() {
	mkdirSync(join(root, 'scripts', 'asr'), { recursive: true });

	if (existsSync(pythonBin) && existsSync(marker)) {
		console.log(`FunASR venv already ready: ${pythonBin}`);
		console.log('To force reinstall, delete .venv-funasr and run again.');
		return;
	}

	const systemPy = resolveSystemPython();
	console.log(`System Python: ${systemPy}`);

	if (!existsSync(pythonBin)) {
		console.log('Creating FunASR virtualenv…');
		if (existsSync(venvDir)) {
			rmSync(venvDir, { recursive: true, force: true });
		}
		runPython(systemPy, ['-m', 'venv', venvDir]);
	}

	if (!existsSync(pythonBin)) {
		throw new Error(
			`venv python missing at ${pythonBin}. Try deleting .venv-funasr and re-running.`
		);
	}

	console.log('Upgrading pip…');
	runPython(pythonBin, ['-m', 'pip', 'install', '-U', 'pip', 'setuptools', 'wheel']);

	console.log('Installing PyTorch (CPU) + FunASR…');
	runPython(pythonBin, [
		'-m',
		'pip',
		'install',
		'-U',
		'torch',
		'torchaudio',
		'--index-url',
		'https://download.pytorch.org/whl/cpu'
	]);
	runPython(pythonBin, ['-m', 'pip', 'install', '-U', 'funasr==1.3.29', 'modelscope']);

	writeFileSync(
		marker,
		JSON.stringify(
			{
				readyAt: new Date().toISOString(),
				funasr: '1.3.29',
				defaultModel: 'iic/SenseVoiceSmall',
				python: pythonBin
			},
			null,
			2
		),
		'utf8'
	);

	console.log('');
	console.log('FunASR setup complete.');
	console.log(`Python: ${pythonBin}`);
	console.log('Default Chinese engine: SenseVoice-Small (FunASR).');
	console.log('First Extract Subs may download model weights (one-time).');
}

try {
	main();
} catch (err) {
	console.error(err);
	process.exit(1);
}
