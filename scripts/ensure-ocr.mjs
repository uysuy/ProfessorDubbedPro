/**
 * Optional hardsub OCR deps (RapidOCR ONNX) in a project-local venv.
 *
 * Usage: pnpm ocr:setup
 *
 * Installs into: .venv-ocr/
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const venvDir = join(root, '.venv-ocr');
const isWin = process.platform === 'win32';
const pythonBin = isWin
	? join(venvDir, 'Scripts', 'python.exe')
	: join(venvDir, 'bin', 'python');
const marker = join(venvDir, '.pdp-ocr-ready');

function run(cmd, args) {
	console.log(`> ${cmd} ${args.join(' ')}`);
	execFileSync(cmd, args, { stdio: 'inherit' });
}

function resolveSystemPython() {
	const tries = isWin
		? [
				{ cmd: 'py', args: ['-3', '-c', 'import sys; print(sys.executable)'] },
				{ cmd: 'python', args: ['-c', 'import sys; print(sys.executable)'] }
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
			/* next */
		}
	}
	throw new Error(
		'Python 3.10+ not found. Install Python, then re-run: pnpm ocr:setup'
	);
}

function main() {
	if (existsSync(marker) && existsSync(pythonBin)) {
		console.log(`OCR venv already ready: ${venvDir}`);
		return;
	}

	mkdirSync(venvDir, { recursive: true });
	const sysPy = resolveSystemPython();
	if (!existsSync(pythonBin)) {
		run(sysPy, ['-m', 'venv', venvDir]);
	}
	run(pythonBin, ['-m', 'pip', 'install', '-U', 'pip', 'wheel']);
	run(pythonBin, [
		'-m',
		'pip',
		'install',
		'-U',
		'rapidocr-onnxruntime>=1.3.24',
		'opencv-python-headless>=4.8.0',
		'numpy>=1.24.0'
	]);
	writeFileSync(marker, JSON.stringify({ version: 1, at: new Date().toISOString() }, null, 2));
	console.log('Hardsub OCR ready. Toggle “OCR hardsubs” in Import from Link.');
}

main();
