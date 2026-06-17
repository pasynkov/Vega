## Context

Vega is a brand-new personal-assistant project. The repository contains no application code yet. The first concrete goal is to validate the end-to-end pipeline `mic → wake word → streamed STT → persisted artifact` on a single Mac. Downstream work — LLM routing, Telegram bot, multi-Ear coordination, on-device Pi listener — is deliberately out of scope but its presence shapes several decisions here.

The user is the sole developer and the sole end-user. The Mac in question is a development MacBook with a single built-in microphone; the user typically wears headphones, so echo cancellation is not an immediate concern. The codebase will live in `/Users/pasynkov/dev/Vega`.

## Goals / Non-Goals

**Goals:**
- End-to-end working slice from "user says Vega" to "transcript saved on disk".
- Two clearly separated processes: a Mac-specific Ear and a portable Core.
- Audio file format that the Telegram Bot API can consume verbatim later (OGG/OPUS).
- Wake-word component behind an interface so it can be swapped without churn elsewhere.
- Streaming STT so future cost stays low and future UX (live partial text, fast endpointing) is possible without re-plumbing.
- Protocol fields (`deviceId`, `userId`) reserved for future multi-Ear and multi-user scenarios without committing to them now.

**Non-Goals:**
- LLM call on the transcript, Telegram bot send, TTS reply, or any "action" downstream of the transcript.
- Multi-Ear coordination logic (loudest-wins, zone routing). The protocol carries `wake_detected` events but Core's MVP behavior is always "proceed".
- Voice biometrics, user identification, per-user wake words.
- Authentication between Ear and Core. The local WS endpoint is trusted within the developer's machine.
- Acoustic echo cancellation, beamforming, mic-array support.
- Raspberry Pi / Linux Ear implementation.
- A polished menu-bar UI (preferences, history viewer, etc.) — the menu bar is just a presence indicator and a quit button for MVP.

## Decisions

### Two processes, not one: Swift Ear + NestJS Core

The Mac client is a Swift menu-bar app. The brain is a separate NestJS process running on `localhost`. They communicate over a WebSocket using the shared `ear-protocol` schema.

**Why:**
- The user's stated direction is NestJS for "the brain" so it can later host LLM routing, persistent state, Telegram bot, cron, and other server-shaped concerns. Bundling these into a single Swift binary would couple the assistant logic to macOS and to the Ear lifecycle.
- The user expects additional Ear types later (a Raspberry-Pi smart speaker, possibly an iOS Ear). Drawing the boundary at the WS protocol now means new Ears are additive and never touch Core's logic.
- API keys (Picovoice, Deepgram, later OpenAI/Anthropic/Telegram) live in Core's environment, not bundled inside the Swift app. The Swift app needs only one secret of its own (the Picovoice key for the wake-word model).

**Alternatives considered:**
- Monolith Swift app calling Deepgram directly. Rejected: paints the project into a macOS corner and gives no path to share logic with future Ears.
- Monolith NestJS with no Swift app, using a CLI mic recorder. Rejected: native always-on mic access plus low-CPU wake-word detection is the part Swift/AVFoundation actually does well, and there is no clean macOS daemon path that avoids permission re-prompts.

### Wake word: Porcupine, behind a `WakeWordDetector` abstraction

The MVP wake word is "Vega", detected by Picovoice Porcupine via its native Swift SDK. The detector is hidden behind a `WakeWordDetector` Swift protocol so that a future change can swap in OpenWakeWord or another engine without changing audio capture, encoding, or the WS client.

**Why:**
- Porcupine ships a ready-made wake-word model in roughly a minute via the Picovoice web console. No dataset collection, no custom training, no week of accuracy tuning before the first beep.
- The free tier permits three device slots per access key, which is sufficient for one developer's Mac plus headroom (one more Mac, an iPhone Ear, etc.). The next change to introduce a Pi Ear or a third Mac will choose between consuming another slot or migrating to OpenWakeWord, and either path is cheap because of the abstraction.
- Accuracy and CPU footprint in this class of solution are the best available for an MVP. Battery hit on the developer's Mac is negligible.

**Alternatives considered:**
- OpenWakeWord (Apache-2 ONNX). Rejected for MVP because no pre-trained "Vega" model exists; producing one requires synthetic-dataset generation and a training pass, which delays the first working slice. Kept as the most likely migration target.
- Apple Sound Analysis + Create ML. Rejected because it is Mac-only by design and would have to be redone for the future Pi Ear.
- PocketSphinx / Vosk keyword spotting. Rejected for inferior accuracy and integration cost.
- Whisper.cpp running continuously and matching the word "vega" in transcripts. Rejected: constant transcription is wasteful CPU for an always-on listener.

### STT: Deepgram streaming WebSocket

After wake-word detection the Ear opens a session with Core; Core opens a Deepgram WebSocket and streams the user's audio frames as PCM. Deepgram returns interim and final transcripts plus an `UtteranceEnd` event that Core uses as the authoritative endpoint signal.

**Why:**
- Streaming is materially cheaper than file-based Whisper (~$0.0043/min vs ~$0.006/min) and additionally avoids the round-trip of "stop recording, upload file, wait for response".
- Server-side endpointing is more reliable than a hand-rolled RMS VAD across varying mic gains and ambient noise.
- Russian is well supported by Deepgram's current general models.
- The provider is not Russian-hosted, which the user explicitly preferred.

**Alternatives considered:**
- Whisper API (OpenAI). Rejected: batch only, no streaming, higher per-minute cost.
- Yandex SpeechKit. Rejected by user (data-residency preference).
- AssemblyAI Streaming. Comparable price; deferred as a possible future swap if Deepgram disappoints on Russian accuracy.
- Apple SFSpeechRecognizer on the Ear. Rejected because the design goal is to keep STT in Core so any Ear (including a future Pi) gets the same pipeline.

### Audio format: PCM linear16 over the wire, OGG/OPUS saved by Core

Captured audio is sent over the WebSocket as raw linear PCM (signed 16-bit little-endian) at 48 kHz mono. Core forwards those PCM frames to Deepgram (`encoding: linear16`). At session end, Core invokes ffmpeg to encode the accumulated PCM into `recordings/<ts>/audio.ogg` as OGG/OPUS, which is what Telegram's `sendVoice` accepts.

**Why:**
- The persisted artifact requirement (Telegram-compatible OGG/OPUS) does not require OPUS on the wire. Encoding once at session end on Core satisfies the Telegram contract with strictly less work than streaming OPUS frames from the Ear.
- It keeps the Ear small and free of native codec dependencies: no ffmpeg-kit XCFramework, no hand-rolled libopus bridge, no codec licensing surface. A future Pi Ear, an iOS Ear, or any other client only has to be able to capture PCM and open a WebSocket.
- It centralizes the "convert to Telegram format" responsibility in Core, where the future Telegram-bot integration will live anyway. Adding multiple persistence formats later (e.g. AAC for iOS, FLAC for archival) is a Core-only change.
- LAN bandwidth is not a constraint: 48 kHz mono int16 PCM is ~96 KB/s. Even on Wi-Fi between a Pi and a NAS this is trivial.

**Alternatives considered:**
- OPUS encoded on the Ear via ffmpeg-kit-macos. Rejected: ffmpeg-kit's API is built around file-in / file-out batch transcoding, not real-time PCM-frame → OPUS-frame streaming, so the integration would either copy through temp files (wrong) or import most of ffmpeg-kit's runtime for a job it is not designed for. Its XCFramework (~300 MB; the earlier "~30 MB" estimate was wrong) is also heavy for an Ear, and the upstream repo is archived as of 2025.
- Native macOS `AVAudioConverter` with `kAudioFormatOpus`. The Opus codec is supported on macOS 14.4+, but the converter emits raw OPUS packets only; OGG muxing would still have to be written. This is the right migration target if the user later wants OPUS on the wire — interface stays the same.
- libopus via a Swift/C bridging header. Same OGG-muxing problem, plus a hand-written bridge. Rejected for MVP.

The protocol's `codec` field reflects this: it carries the wire codec used in this session. The MVP value is `linear16`; the enum reserves `opus` so a future Ear can negotiate without protocol churn.

### Storage layout: one directory per session

Each invocation produces `recordings/<ISO-timestamp>/` containing `audio.ogg`, `transcript.txt`, and `meta.json`. The top-level `recordings/` directory is gitignored with a `.gitkeep`.

**Why:**
- Per-session directories let related artifacts (audio, transcript, metadata, future thumbnails or LLM responses) stay co-located.
- ISO timestamps sort lexically and are unambiguous.
- Persisting raw audio plus transcript makes it possible to revisit a wake-word false positive or a Deepgram misrecognition without re-recording.

**Alternatives considered:**
- Flat files keyed by timestamp. Rejected because additional per-session sidecars (LLM response, Telegram message ID, error traces) are likely in the next changes and a flat directory becomes noisy.

### Protocol carries `deviceId` and `userId` from day one

The `ear-protocol` messages always include `deviceId` (stable per Ear install) and `userId` (nullable, unused in MVP). `wake_detected` is sent as a separate event rather than being implied by `session_start`, so future multi-Ear coordination can intercept it.

**Why:**
- The user's stated end state includes multiple Ears in a household and multiple people interacting. Renaming or restructuring messages later is more painful than carrying a few nullable fields now.
- `wake_detected` as its own event lets Core (in a future change) compare scores across Ears and tell only one of them to actually open a session.

**Alternatives considered:**
- Skip the fields, add them when needed. Rejected because every other client and persisted-session record would then need a migration.

## Risks / Trade-offs

- **Porcupine free-tier device slot exhaustion** — Three slots per access key. If reformatting or additional Macs eat slots faster than expected, the user is blocked on wake-word. Mitigation: detector abstraction; OpenWakeWord migration path is documented; one slot of headroom is preserved consciously.
- **Deepgram Russian accuracy unknown in this microphone setup** — Provider is not Russian-language-first. Mitigation: persistent `audio.ogg` lets us re-evaluate offline; future change can A/B against AssemblyAI or whisper.cpp without touching the rest of the stack.
- **Always-on microphone capture on a battery-powered Mac** — Wake-word DNN runs on every audio frame. Mitigation: Porcupine's per-frame inference is well under 5% of one core on Apple Silicon; menu-bar app has a kill switch.
- **WebSocket between Ear and Core has no authentication** — Acceptable while both run on the same user's laptop; explicitly listed as a Phase-2 concern.
- **ffmpeg-kit binary size (~30 MB)** — User-accepted trade-off. Re-evaluate if the Ear is ever distributed beyond the developer.
- **`audio.ogg` retains raw user speech on disk** — Privacy implication. `recordings/` is gitignored. No upload happens beyond Deepgram. A future change should add retention/cleanup.
- **macOS may revoke microphone permission silently after an OS update** — Detect at startup and surface clearly through the menu-bar icon and a one-shot notification; do not silently fail.

## Open Questions

- ~~Should the Ear encode OPUS frames once and stream the same encoded frames to Core, or stream PCM and encode-to-file separately?~~ Resolved during implementation. The Ear streams PCM (`linear16`); Core encodes to OGG/OPUS at `session_end` via ffmpeg. Rationale captured in the "Audio format" decision above.
- What is the safety-cap recording length when Deepgram's `UtteranceEnd` is delayed or never arrives? Default proposed: 30 seconds, surfaced as a configurable constant in Core.
- Where does the Ear keep its Picovoice access key on disk? Default proposed: Keychain entry created on first launch, fall back to `~/.config/vega/ear.env` if the user prefers plain text. Decide during `apps/mac-ear` task work.
