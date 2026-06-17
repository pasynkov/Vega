## Why

Vega is a personal voice assistant. Before it can be useful, it needs an ear: a way to be invoked at any moment without a hotkey or window. The MVP foundation is an always-listening Mac client that wakes on a keyword, captures the spoken task as a Telegram-compatible voice file, streams it to a cloud STT service, and persists the transcript locally. This first slice validates the wake-word UX, the streaming-STT pipeline, the audio format choice (OGG/OPUS for future Telegram bot integration), and the client/brain split that everything else will be built on.

## What Changes

- Add `apps/mac-ear`: a Swift macOS menu-bar application that captures microphone audio, detects the wake word "Vega" via Porcupine, plays an audible "wake" cue, streams audio frames to the local NestJS daemon, and plays an audible "endpoint" cue when the daemon signals end-of-utterance.
- Add `apps/core`: a NestJS daemon that exposes a local WebSocket endpoint, accepts audio frames from any Ear client, relays them through Deepgram's streaming STT WebSocket, emits transcript and cue events back to the Ear, and persists session artifacts to disk.
- Add `packages/ear-protocol`: a shared schema (TypeScript types plus Swift Codable mirror) defining the WebSocket messages exchanged between any Ear client and Core. The protocol carries `deviceId`, `sessionId`, and an unused `userId` slot from day one so future multi-Ear and multi-user changes do not require renegotiation.
- Encode captured audio as OGG/OPUS (48 kHz mono) via ffmpeg-kit-macos so each saved file is directly accepted by the Telegram Bot API `sendVoice` endpoint in a future change.
- Persist each invocation as a session directory under `recordings/<ISO-timestamp>/` containing `audio.ogg`, `transcript.txt`, and `meta.json`. The `recordings/` directory is gitignored with a `.gitkeep`.
- Abstract the wake-word detector behind a `WakeWordDetector` protocol so the Porcupine implementation can be swapped (for OpenWakeWord or another engine) in a later change without touching the rest of the Ear.
- Configure secrets (`PICOVOICE_ACCESS_KEY`, `DEEPGRAM_API_KEY`) via `.env` for Core and a Keychain entry or `.env`-equivalent for the Ear. Secrets are not committed.

## Capabilities

### New Capabilities
- `mac-ear`: the macOS menu-bar listener — microphone capture, wake-word detection, OPUS encoding, audible cues, and Ear-protocol client.
- `vega-core`: the NestJS daemon — WebSocket server, Deepgram streaming client, session persistence, and event routing back to the Ear.
- `ear-protocol`: the WebSocket message contract between any Ear client and Core — message shapes, lifecycle, and reserved fields for future multi-device and multi-user work.

### Modified Capabilities
<!-- None — this is the first set of specs in the project. -->

## Impact

- Creates the initial monorepo layout: `apps/mac-ear/` (Swift / Xcode project), `apps/core/` (NestJS), `packages/ear-protocol/` (TypeScript + Swift mirror), `recordings/` (gitignored runtime data).
- Introduces external service dependencies: Picovoice (Porcupine wake-word, free tier — one device slot consumed) and Deepgram (streaming STT, pay-per-minute).
- Introduces native dependencies: Porcupine iOS/macOS SDK and ffmpeg-kit-macos in the Swift app; the standard NestJS stack plus a Deepgram SDK in Core.
- Adds runtime permission requirements on macOS: Microphone access for the Ear app.
- No production users, no existing APIs, no migrations — greenfield repo. The risk surface is contained to the new code.
