/**
 * Create a project-local Python venv and install FunASR (SenseVoice) + speaker diarization deps.
 *
 * Usage: pnpm funasr:setup
 *
 * Installs into: .venv-funasr/
 * First transcription may download SenseVoice / VAD weights from ModelScope.
 * First Detect Speakers may download SpeechBrain ECAPA (~100MB) from Hugging Face.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const diarizeMarker = join(venvDir, '.pdp-diarize-ready');
const DIARIZE_VERSION = '2';

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

function diarizeReady() {
	if (!existsSync(diarizeMarker)) return false;
	try {
		const raw = JSON.parse(readFileSync(diarizeMarker, 'utf8'));
		return raw?.version === DIARIZE_VERSION;
	} catch {
		return false;
	}
}

function installDiarizeDeps() {
	console.log('Installing speaker diarization deps (SpeechBrain ECAPA + librosa)…');
	runPython(pythonBin, [
		'-m',
		'pip',
		'install',
		'-U',
		'speechbrain==1.0.3',
		'librosa>=0.10.2',
		'scikit-learn>=1.6.0',
		'soundfile>=0.12.1',
		'huggingface_hub'
	]);
	writeFileSync(
		diarizeMarker,
		JSON.stringify(
			{
				version: DIARIZE_VERSION,
				readyAt: new Date().toISOString(),
				speechbrain: '1.0.3',
				note: 'First Detect Speakers downloads ECAPA weights (~100MB) from Hugging Face'
			},
			null,
			2
		),
		'utf8'
	);
}

function main() {
	mkdirSync(join(root, 'scripts', 'asr'), { recursive: true });

	const funasrReady = existsSync(pythonBin) && existsSync(marker);
	if (funasrReady && diarizeReady()) {
		console.log(`FunASR + diarization venv ready: ${pythonBin}`);
		console.log('To force reinstall, delete .venv-funasr and run again.');
		return;
	}

	if (funasrReady && !diarizeReady()) {
		console.log(`FunASR venv found — adding diarization packages…`);
		installDiarizeDeps();
		console.log('');
		console.log('Speaker diarization deps installed.');
		console.log('First Detect Speakers may download ECAPA weights (~100MB, one-time).');
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

	installDiarizeDeps();

	writeFileSync(
		marker,
		JSON.stringify(
			{
				readyAt: new Date().toISOString(),
				funasr: '1.3.29',
				defaultModel: 'iic/SenseVoiceSmall',
				python: pythonBin,
				diarize: DIARIZE_VERSION
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
	console.log('First Detect Speakers may download ECAPA speaker embeddings (~100MB).');
}

try {
	main();
} catch (err) {
	console.error(err);
	process.exit(1);
}
