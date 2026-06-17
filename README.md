# Vega

Personal voice assistant. Two processes:

- `apps/mac-ear` — Swift macOS menu-bar app: microphone capture, "Vega" wake-word detection (Porcupine), OPUS encoding, audible cues.
- `apps/core` — NestJS daemon: WebSocket server for any Ear client, Deepgram streaming STT, persisted sessions.

Shared schema lives in `packages/ear-protocol` (TypeScript + Swift mirror).

## Layout

```
.
├─ apps/
│   ├─ core/           NestJS daemon
│   └─ mac-ear/        Swift menu-bar app (SPM)
├─ packages/
│   └─ ear-protocol/   shared WS protocol (TS + Swift)
├─ recordings/         runtime session artifacts (gitignored)
└─ openspec/           spec-driven planning artifacts
```

## Requirements

- Node.js 20+
- npm 10+
- Xcode 15+ (for `apps/mac-ear`)
- Picovoice access key (https://console.picovoice.ai/) — free tier
- Deepgram API key (https://console.deepgram.com/)

## Setup

```bash
cp .env.example .env
# Fill in PICOVOICE_ACCESS_KEY and DEEPGRAM_API_KEY in .env
npm install
```

## Running Core

```bash
npm run core:dev
```

Core binds `ws://127.0.0.1:7777/ear` by default. Override via `EAR_WS_HOST` and `EAR_WS_PORT`. Recordings are written to `<repo>/recordings/<ISO-timestamp>/` (override via `RECORDINGS_DIR`). Default STT language is Russian (`DEEPGRAM_LANGUAGE=ru`). Session safety cap is 30 seconds (`SESSION_TIMEOUT_MS`).

Required: `DEEPGRAM_API_KEY`. Core exits with a clear error if it is missing.

## Running Mac Ear

```bash
cd apps/mac-ear
open Package.swift   # opens in Xcode
# Run the VegaEar scheme (⌘R)
```

On first launch:

1. macOS prompts for microphone permission. Grant it.
2. The Ear looks for `PICOVOICE_ACCESS_KEY` in Keychain, then falls back to `~/.config/vega/ear.env`.
3. The menu-bar icon shows the listening state (`idle`, `listening`, `streaming`, `error`, `disabled`).

## Manual smoke test

1. Start Core (`npm run core:dev`). Confirm it logs the bound WS address.
2. Launch the Mac Ear. Confirm the menu-bar icon enters `idle`.
3. Say **"Vega"** followed by any phrase (e.g. "Vega, напомни купить молоко").
4. Hear the `Tink` cue at wake, `Pop` cue at end-of-utterance.
5. Check `recordings/<ISO-timestamp>/` for `audio.ogg`, `transcript.txt`, `meta.json`.
6. Verify `transcript.txt` is non-empty.

## Telegram-compatibility check

`audio.ogg` is encoded as OGG/OPUS mono so it is accepted by the Telegram Bot API `sendVoice` endpoint. To verify, upload one captured file via your test bot:

```bash
curl -F voice=@recordings/<ts>/audio.ogg \
     "https://api.telegram.org/bot<TOKEN>/sendVoice?chat_id=<YOUR_CHAT_ID>"
```

## OpenSpec workflow

Changes are tracked under `openspec/changes/`. See `openspec/changes/mac-listener-mvp/` for the proposal, design, specs, and task breakdown for this slice.

## Subprojects

- [apps/core](apps/core/README.md)
- [apps/mac-ear](apps/mac-ear/README.md)
- [packages/ear-protocol](packages/ear-protocol/README.md)
