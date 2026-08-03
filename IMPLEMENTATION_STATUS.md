# ProfessorDubbedPro — Implementation Status & Review Brief

> **Purpose:** Hand this document to another AI (e.g. Grok) for analysis, critique, and product/engineering suggestions.  
> **Product:** Desktop Chinese → Khmer video dubbing studio.  
> **Stack:** Tauri 2 (Rust) + SvelteKit 2 / Svelte 5 + TypeScript + Tailwind v4 + shadcn-svelte (bits-ui).  
> **Version context:** Local app `v0.1.0`, mid-development (studio loop works; dubbed-master export not done).  
> **Date of this brief:** 2026-08-02.

---

## 1. One-sentence pitch

A Windows-first desktop app where a user opens a Chinese video, extracts Chinese subtitles with local Whisper, translates to Khmer (Fast MT or High Quality LLM), generates Edge TTS Khmer voice timed to the video cues (lip-sync rate fit), edits on a timeline, and exports **subtitles / subtitled video** — but **not yet** a final dubbed audio mix.

---

## 2. Architecture overview

```
┌─────────────────────────────────────────────────────────────┐
│  SvelteKit SPA (SSR off) — studio UI, stores, Web Audio TTS │
│  routes: / (studio), /projects, /settings                   │
└──────────────────────────┬──────────────────────────────────┘
                           │ Tauri IPC (invoke / events)
┌──────────────────────────▼──────────────────────────────────┐
│  Rust (professor-dubbed-pro)                                │
│  • transcribe_video / cancel_transcription (Whisper CLI)    │
│  • translate_texts (Azure / Google / DeepSeek / Qwen / Gemini)│
│  • synthesize_edge_tts / list_edge_voices (msedge-tts)      │
│  • export_project (SRT / soft subs / burn-in via FFmpeg)    │
│  • staged file helpers for large video drops                │
└──────────────────────────┬──────────────────────────────────┘
                           │ sidecars / APIs
        FFmpeg · whisper-cli · Edge Read Aloud · LLM/MT HTTP
```

### Key folders

| Area | Path |
|------|------|
| Studio UI | `src/lib/components/studio/`, `src/lib/components/layout/` |
| Stores | `src/lib/stores/` (`project`, `preferences`, `transcription`, `translation`, `theme`, …) |
| TTS JS | `src/lib/tts/` |
| Utils | `src/lib/utils/` (`tts-fit`, `tts-playback`, `transcribe`, `translate`, `export`, `project-io`) |
| Rust | `src-tauri/src/{lib,transcribe,translate,tts,export}.rs` |
| Sidecar scripts | `scripts/ensure-ffmpeg.mjs`, `scripts/ensure-whisper.mjs` |
| Models / binaries | `src-tauri/models/`, `src-tauri/binaries/` |

---

## 3. What is implemented (working)

### 3.1 Extract Subs (local Whisper)

- **Flow:** Video → FFmpeg 16 kHz mono WAV (speech EQ + dynaudnorm, with plain fallback) → whisper.cpp CLI → JSON + SRT merge → sentence split → subtitle cues (`source` = Chinese, `translation` empty).
- **Language:** Forced `zh` (auto-detect was abandoned: long Chinese videos often stalled ~30s into the file).
- **Models:** Pref `small` (`ggml-small.bin`, preferred) or `base`; download via `pnpm whisper:download`.
- **Decode knobs:** beam `-bs 5`, temp `0`, no-speech `0.45`, Mandarin initial prompt, longer segments then punctuation split.
- **Long audio:** Manual 30s chunks with 6s overlap (Whisper native long-form seek was incomplete).
- **UI:** Progress events, cancel, junk-placeholder filtering.

### 3.2 Translate Chinese → Khmer

| Mode | Engine | Notes |
|------|--------|--------|
| **Fast** (default) | Azure Translator if key set, else unofficial Google `gtx` | Reliable enough; Google is fragile / rate-sensitive |
| **High Quality** | LLM: DeepSeek / Qwen / Gemini | Natural spoken Khmer; numbered batch parse; prompt asks for **concise lip-sync-friendly** lines |

- **Gemini default model:** `gemini-2.5-pro` (paid/Pro oriented), with fallback cascade if a model ID is 404 / blocked for new users.
- **Failure policy:** High Quality → Fast fallback; Azure → Google; soft 429 retries; hard quota fails fast.
- **API keys:** Stored in `localStorage` preferences (not encrypted).

### 3.3 TTS (Microsoft Edge Read Aloud)

- Rust `msedge-tts` → MP3 under app data.
- Live voice list + offline Khmer fallbacks (Sreymom / Piseth).
- Khmer Unicode in text forces a Khmer voice (hard error if mismatch).
- Only engine wired today: Edge (online required).

### 3.4 Lip sync (timing fit — not facial tracking)

Default pref **`ttsLipSync: true`**:

1. Measure natural TTS duration vs cue window.
2. Re-synthesize with Edge rate up to **2×**.
3. If still long, store `fitPlaybackRate` (Web Audio squeeze up to **~1.85×**).
4. **Keep `startMs`/`endMs` locked** to the video cue (do not push neighbor cues).

Alternate **Preserve** mode: milder speed-up; may extend cues when speech still overflows.

Playback mixer (`tts-playback.ts`) maps video time → audio buffer with fit rate so dub finishes with the picture window.

### 3.5 Studio UI / timeline

- Custom frameless window, resizable sidebars, theme (system/light/dark).
- Video preview + transport; multi-lane timeline (picture, dialogue, dub, original audio).
- Subtitle table edit; per-cue pitch/speed/volume/voice.
- DnD / assign TTS clips; undo/redo (~80 snapshots).
- Autosave + recovery document; `.dubproj` project format.
- Large video staging via chunked Tauri writes.

### 3.6 Export (subtitle-centric)

| Mode | Output |
|------|--------|
| `srt` | UTF-8 SRT (Khmer text) |
| `videoSoftSubs` | MP4 stream-copy + soft `mov_text` + companion SRT |
| `videoBurnedIn` | Re-encode burn-in (Khmer UI font, Windows-oriented) |

**Important:** Original video **audio is unchanged**. There is **no** “export dubbed mix” that replaces dialogue with TTS.

---

## 4. What is not completed / missing

| Gap | Status |
|-----|--------|
| **Export dubbed master** (mux TTS → new audio track / replace dialogue) | Not started |
| Duck / mute original dialogue under dub | Preview ducks video volume only; not in export |
| Offline / local TTS (no Edge dependency) | Not started |
| True lip sync (phoneme / viseme / face) | Not started — rate fit only |
| Speaker diarization | Manual `speaker` field only |
| VAD / silence-based cue boundaries | Not used (Whisper thresholds only) |
| Music / SFX stem workflow | Track roles exist; no tools |
| Script / ADR panel | Placeholder UI, not wired |
| Re-link missing video path on project open | Fragile — user often re-opens video |
| Encrypted / secure API key storage | Keys in clear `localStorage` |
| Automated tests | None found |
| CI (GitHub Actions, etc.) | None found |
| Whisper CLI/models in Tauri `externalBin` / installer story | FFmpeg is; Whisper is path-discovered |
| Cross-platform polish (macOS whisper zip, fonts) | Weak; Windows-first |
| Cloud sync / accounts / licensing | None |
| Batch project queue / render farm | None |

---

## 5. Known fragile areas & workarounds (history)

1. **Whisper incomplete extract (~00:28 on long videos)** → forced `zh` + manual chunking.
2. **Whisper accuracy** → upgraded default `ggml-base` → `ggml-small` + better decode flags + audio EQ.
3. **TTS panic (rustls CryptoProvider)** → rustls no-provider + install ring at startup (`msedge-tts` conflict).
4. **TTS “chopped” mid-sentence** → was ending playback at old `endMs` while MP3 longer → then extend policy → then lip-sync lock + rate squeeze.
5. **Gemini 429 quota / free tier** → fail-fast on hard quota; suggest Fast or paid Pro.
6. **Gemini 404 “model no longer available to new users”** → model cascade (`2.5-pro`, `3.1-pro-preview`, flash variants…).
7. **Edge rate vs UI** → UI allowed 2×; synthesizer mapping previously capped 1.5× — lipsync path now allows up to 2× Edge rate.
8. **paneforge** → patched locally (`patches/paneforge@1.0.2.patch`).

---

## 6. Data model (condensed)

### SubtitleCue
- Timing: `startMs`, `endMs`
- Text: `source` (Chinese), `translation` (Khmer)
- Voice: `voiceId`, `pitch`, `speed`, `volume`, `speaker`, `status`
- Audio: `assignedAudio` (`filePath`, `url`, `durationMs`, `fitPlaybackRate`, `engine`, …)

### Project (`.dubproj`)
- Languages, fps, duration, assets, tracks, cues, metadata
- Session extras: playhead, global voice params; recovery may store `videoPath`

### Preferences (`localStorage`)
- Default voice/language, autosave interval, export mode
- Azure Translator, LLM provider/key/model, translation quality
- Whisper model size, **ttsLipSync**

---

## 7. Current user workflow vs ideal

### Today
1. Open Chinese video  
2. Extract Subs (Whisper)  
3. Translate (Fast or High Quality)  
4. Generate TTS with lip-sync fit  
5. Edit timings / text / voice  
6. Export SRT or video **with subtitles** (original audio remains)

### Ideal (product target)
1. Accurate timed Chinese cues (VAD + better ASR / optional imported SRT)  
2. Duration-aware Khmer translation (length budget per cue)  
3. High-quality TTS or voice clone, duration-aware synth  
4. Optional quality-preserving time-stretch (FFmpeg `atempo` / rubberband) instead of harsh Web Audio squeeze  
5. Mix: duck/mute original dialogue + bed music  
6. **Export muxed dubbed video** (+ optional subtitles)  
7. QC tools (waveform align, loudness, missed cues)  
8. Reliable installer with bundled FFmpeg + Whisper + fonts  

---

## 8. Strengths

- End-to-end **local-first ASR** (no Whisper cloud dependency).
- Dual translation paths (cheap Fast + quality LLM) with sensible fallbacks.
- Real studio UX: timeline, preview, undo, autosave, project file.
- Lip-sync **timing** policy that prefers video lock over drifting cue cascade.
- Desktop-native performance for FFmpeg/Whisper sidecars.
- Clear ZH→KM niche focus (Khmer voices, fonts, prompts).

---

## 9. Weaknesses & gaps (honest)

| Area | Weakness |
|------|----------|
| **Shipping deliverable** | Preview dub ≠ exportable dubbed master |
| **ASR** | Offline Whisper `small` still errs on noisy/BGM/overlap; no diarization |
| **MT** | Google gtx unofficial; Azure optional; LLM cost/quota/model churn |
| **TTS** | Online-only Edge; Khmer neural voices limited; rate squeeze can sound rushed |
| **Lip sync** | Time compression only — mouths / phonemes not modeled |
| **Translation length** | Still often longer than Chinese → forces aggressive speedup |
| **Security** | API keys in plaintext localStorage |
| **Quality gates** | No tests, no CI, weak packaging of Whisper |
| **Portability** | Burn-in font / whisper download oriented to Windows |
| **Project reopen** | Video asset path often breaks |
| **Script panel** | Dead / placeholder surface |

---

## 10. Suggestions & ideas (for external AI to critique / expand)

### P0 — Product-critical
1. **Dubbed audio export:** FFmpeg mix timeline TTS clips onto video (replace or duck original dialogue); optional dual-audio track.
2. **Persist video path / re-link dialog** when opening `.dubproj`.
3. **Installer completeness:** ship whisper-cli + at least `ggml-small` (or first-run download with progress UI).

### P1 — Quality
4. **Translation length budget:** pass cue duration (sec) into LLM/Fast post-edit; reject or rewrite lines that exceed budget before TTS.
5. **FFmpeg `atempo` residual stretch** after Edge (better quality than stacking Web Audio rate).
6. **Import existing SRT** (Chinese or bilingual) to skip ASR when user already has subs.
7. **Whisper medium / quantized options** for accuracy vs speed.
8. **Per-cue “fit preview”** meter: natural duration vs window vs applied rates.

### P2 — Polish & scale
9. Secure secret storage (OS keychain) for API keys.
10. Offline TTS path (e.g. local ONNX / Piper / commercial offline SDK) for air-gapped use.
11. Simple QC report: uncovered gaps, overlapping TTS, extreme fit rates, empty translations.
12. Tests for `tts-fit`, SRT round-trip, translate numbered parse, chunk merge.
13. CI: `pnpm check` + `cargo test` + smoke build.
14. macOS/Linux sidecar docs or CI artifacts.

### Product / UX ideas
15. One-click pipeline button: Extract → Translate → Generate (with progress wizard).
16. Glossary / character name lock for consistent Khmer names.
17. Speaker colors + optional simple clustering.
18. Compare modes: A/B Fast vs High Quality on selected cues.
19. “Preserve speech” vs “Lock lips” clearly labeled on generate (already a pref — surface in toolbar).
20. Export presets: “Subtitle pack”, “Review burn-in”, “Dubbed master (when ready)”.

### Research / advanced (optional later)
21. Voice cloning for consistent character timbre.
22. Forced alignment (e.g. WhisperX-style) for tighter cue boundaries.
23. Viseme / Rhubarb-style lip data for animated content (overkill for live-action unless needed).
24. GPU Whisper / DirectML for speed.

---

## 11. Open questions for reviewers

1. For Khmer film/drama dubbing, is **Edge TTS + rate fit** good enough as v1, or is offline/local TTS a hard requirement?
2. Should export v1 prioritize **dual audio** (original + dub) or **replace dialogue**?
3. Is the primary user workflow **full ASR** or mostly **import Chinese SRT → translate → TTS**?
4. How aggressive should lip-sync be before quality collapses (max Edge rate, max atempo)?
5. Prefer **Gemini Pro** as default High Quality, or cheaper DeepSeek for volume jobs?
6. Target platforms beyond Windows?

---

## 12. Commands cheat sheet

```bash
pnpm install
pnpm ffmpeg:download
pnpm whisper:download          # small + base models
pnpm tauri:dev                 # daily development
pnpm tauri:build               # packaged app
```

---

## 13. Ask to Grok (suggested prompt)

Copy everything above, then add:

> Please analyze this dubbing studio implementation. Prioritize:
> 1) The shortest path to a shippable **dubbed video export**.
> 2) How to improve **ZH→KM timing** (translation length + TTS fit) without sounding robotic.
> 3) Architecture risks (sidecars, keys, model deprecations, no tests).
> 4) A realistic 2-week and 6-week roadmap.
> Challenge weak assumptions and propose concrete algorithms / FFmpeg graphs / data-model changes where useful.

---

*End of brief. Generated for external review; reflects codebase intent and known gaps as of 2026-08-02.*
