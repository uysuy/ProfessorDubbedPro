# ProfessorDubbedPro

**Free & open-source desktop studio for Chinese → Khmer video dubbing.**

Open a Chinese video, extract spoken dialogue, translate into natural Khmer, generate timed Edge-TTS voice, edit on a timeline, and export subtitles or subtitled video — all on your machine.

> Built so creators, teachers, and small studios in Cambodia (and anyone who needs ZH→KM dubs) can work without expensive cloud dubbing suites.  
> **Free for everyone.** Use it, share it, fork it, improve it.

---

## Why this project exists

Chinese short video, drama, and training content is everywhere — but **Khmer dubbing tools** are scarce, expensive, or locked into SaaS quotas.

ProfessorDubbedPro is a **Windows-first desktop app** that keeps the core loop local where it matters:

1. **Listen to the audio** (not burned-in AI captions) → extract Chinese script  
2. **Translate** to spoken Khmer (Fast MT or High Quality LLM + slang glossary)  
3. **Speak** with Microsoft Edge Khmer voices, fitted gently to cue timing  
4. **Edit & export** SRT / soft subs / burn-in video  

The goal is a practical studio for real Khmer audiences — not a demo that dies behind a paywall.

---

## Features

| Step | What you get |
|------|----------------|
| **Extract Subs** | Local ASR from the **spoken audio track** (FunASR SenseVoice for Chinese by default, Whisper.cpp fallback) |
| **Translate** | ZH → KM — Fast (Azure / Google) or High Quality (DeepSeek / Qwen / Gemini) with slang-aware glossary |
| **Generate TTS** | Microsoft Edge Read Aloud Khmer voices; lip-sync mode uses mild speed-up and extends cues instead of chipmunk audio |
| **Studio** | Timeline, preview, subtitle table, project save |
| **Export** | `.srt`, soft-sub video, or burn-in subtitled video (FFmpeg) |

**Honest status (v0.1):** the Extract → Translate → TTS → edit → subtitle export loop works. A full **mixed dubbed master** (replace original dialogue with Khmer audio bed) is still on the roadmap.

---

## Stack

- **Tauri 2** (Rust) — desktop shell, FFmpeg, ASR orchestration, TTS, export  
- **SvelteKit 2 + Svelte 5 + TypeScript** — studio UI  
- **Tailwind CSS v4** + shadcn-svelte (bits-ui)  
- **pnpm** workspace  

Optional sidecars:

- **FFmpeg** — auto-downloaded for your host  
- **whisper.cpp** — local Whisper fallback  
- **FunASR (Python)** — SenseVoice Chinese ASR (recommended)

---

## Requirements

| Tool | Notes |
|------|--------|
| **Windows 10/11** (x64) | Primary target today |
| **Node.js 20+** | Tested with Node 22 |
| **pnpm 10+** | `corepack enable` then `corepack prepare pnpm@10.28.0 --activate` |
| **Rust (stable)** | [rustup](https://rustup.rs/) — needed for `tauri:dev` / `tauri:build` |
| **WebView2** | Usually already on Windows 10/11 |
| **Python 3.10+** | Only if you want FunASR (`pnpm funasr:setup`) |
| **Internet** | Edge TTS voices; first FunASR model download; optional cloud translate/LLM |

---

## Quick start

```bash
# 1. Clone
git clone git@github.com:uysuy/ProfessorDubbedPro.git
cd ProfessorDubbedPro

# 2. Install JS deps
pnpm install

# 3. Fetch FFmpeg + Whisper sidecars (first run may take a few minutes)
pnpm ffmpeg:download
pnpm whisper:download

# 4. (Recommended) Chinese ASR via FunASR SenseVoice
pnpm funasr:setup

# 5. Run the desktop app
pnpm tauri:dev
```

The first FunASR Extract Subs may download SenseVoice / VAD weights from ModelScope (~hundreds of MB, cached under your user profile). Later runs use the cache.

### Frontend only (UI without native features)

```bash
pnpm install
pnpm dev
```

ASR, TTS, and export need the full Tauri app (`pnpm tauri:dev`).

---

## Typical workflow

1. **Open / drop** a Chinese video into the studio.  
2. **Extract Subs** — listens to spoken audio (ignores burned-in captions).  
3. **Translate** — Fast for draft; High Quality + LLM key for natural Khmer (slang glossary for 小三 / 保底 / 高手 / …).  
4. **Generate** Khmer Edge-TTS for selected cues (Lip sync TTS on by default — mild speed, listenable).  
5. **Edit** timings / text on the table or timeline.  
6. **Export** SRT or subtitled video from the toolbar.

Settings (voice, ASR engine, translate quality, API keys) live in **Project settings / Settings**. Keys stay in local preferences on your machine.

---

## Optional API keys

| Purpose | Where |
|---------|--------|
| **Fast translate** | Azure Translator key + region *(else unofficial Google gtx)* |
| **High Quality translate** | DeepSeek / Qwen / Gemini API key in Settings |

No key is required to open a video, extract with local ASR, or trial Edge TTS (Edge needs network).

---

## Build a release installer

```bash
pnpm install
pnpm ffmpeg:download
pnpm whisper:download
pnpm tauri:build
```

Artifacts appear under `src-tauri/target/release/bundle/` (NSIS / MSI on Windows, depending on Tauri config).

---

## Scripts

| Command | Description |
|---------|-------------|
| `pnpm tauri:dev` | Desktop app in development |
| `pnpm tauri:build` | Production desktop build |
| `pnpm dev` | Vite / SvelteKit only |
| `pnpm ffmpeg:download` | Ensure FFmpeg sidecar |
| `pnpm whisper:download` | Ensure whisper.cpp + models |
| `pnpm funasr:setup` | Create `.venv-funasr` + install FunASR |
| `pnpm check` | `svelte-check` |
| `pnpm lint` / `pnpm format` | ESLint / Prettier |

---

## Repository layout

```
ProfessorDubbedPro/
├── src/                      # SvelteKit UI
│   ├── lib/components/       # layout + studio + ui
│   ├── lib/stores/           # project, prefs, ASR, translate, …
│   ├── lib/tts/              # Edge-TTS helpers
│   ├── lib/utils/            # time, fit, export, I/O
│   └── routes/               # studio, projects, settings
├── src-tauri/                # Tauri 2 + Rust
│   ├── src/                  # transcribe, translate, tts, export, FunASR runner
│   ├── binaries/             # FFmpeg (gitignored — downloaded)
│   └── models/               # Whisper models (gitignored — downloaded)
├── scripts/                  # ensure-ffmpeg / whisper / funasr, ASR Python
└── README.md
```

---

## Contributing

Issues, ideas, and PRs are welcome — especially:

- Better ZH→KM glossary / translation quality  
- macOS / Linux packaging  
- Dubbed-master audio mix export  
- ASR accuracy on noisy short-video audio  

Please keep changes focused and match existing TypeScript / Rust style.

---

## License

This project is released under the **[MIT License](./LICENSE)** — free for personal and commercial use, modification, and redistribution, with attribution.

---

## Credits

- [Tauri](https://tauri.app/), [SvelteKit](https://kit.svelte.dev/), [FunASR / SenseVoice](https://github.com/modelscope/FunASR), [whisper.cpp](https://github.com/ggerganov/whisper.cpp), [FFmpeg](https://ffmpeg.org/), Microsoft Edge Read Aloud  

Made for Khmer creators. **Free for everyone.**
