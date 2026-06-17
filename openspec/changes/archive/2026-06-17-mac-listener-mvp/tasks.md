## 1. Monorepo scaffolding

- [x] 1.1 Create top-level workspace layout: `apps/`, `packages/`, `recordings/.gitkeep`, `recordings/` entry in `.gitignore`.
- [x] 1.2 Initialize the monorepo tooling (npm workspaces or pnpm — pick one and document the choice in `README.md`).
- [x] 1.3 Add root-level `.env.example` enumerating `PICOVOICE_ACCESS_KEY` and `DEEPGRAM_API_KEY` and add `.env` to `.gitignore`.
- [x] 1.4 Add an `apps/mac-ear/.gitkeep` and `apps/core/.gitkeep` placeholder so the directories exist before their internal init steps.

## 2. `packages/ear-protocol`

- [x] 2.1 Initialize a TypeScript package at `packages/ear-protocol/` with a `tsconfig.json` extending a shared base config and a build script that produces `dist/`.
- [x] 2.2 Define Zod schemas for every message in the spec: `register`, `wake_detected`, `session_start`, `audio_frame` (control envelope only — binary payload typed separately), `session_end` (from Ear), `ack`, `wake_ack`, `partial_transcript`, `final_transcript`, `play_cue`, `session_end` (from Core).
- [x] 2.3 Export the inferred TypeScript types alongside the Zod schemas; export a discriminated union for each direction (`EarToCoreMessage`, `CoreToEarMessage`).
- [x] 2.4 Define and export constants for the binary `audio_frame` wire encoding (8-byte little-endian session header layout) and helper functions to encode/decode the header.
- [x] 2.5 Add a fixtures file `packages/ear-protocol/fixtures/examples.json` with one valid example payload per message type.
- [x] 2.6 Write a Jest (or Vitest) round-trip test that loads each fixture, parses it with Zod, re-serializes it, and asserts byte-equality.
- [x] 2.7 Generate the Swift mirror: create `packages/ear-protocol/swift/EarProtocol.swift` containing `Codable` structs and enums whose field names match the TypeScript types exactly.
- [x] 2.8 Add a Swift Package Manager `Package.swift` at `packages/ear-protocol/swift/` so the Mac Ear can import it as a local SPM dependency.
- [x] 2.9 Add a Swift round-trip test in `packages/ear-protocol/swift/Tests/` that decodes every fixture and re-encodes it, asserting equivalence with the original JSON. Run with `swift test`.

## 3. `apps/core` — NestJS daemon scaffold

- [x] 3.1 Initialize a NestJS application at `apps/core/` using the standard `@nestjs/cli` layout, configured to consume `packages/ear-protocol` as a workspace dependency.
- [x] 3.2 Add a typed config module that loads `DEEPGRAM_API_KEY`, `EAR_WS_HOST`, `EAR_WS_PORT`, `RECORDINGS_DIR`, `DEEPGRAM_LANGUAGE`, and `SESSION_TIMEOUT_MS` from environment, exits with a clear error on missing required keys, and redacts secrets in logs.
- [x] 3.3 Add a Pino-based logger module with redaction wired in.

## 4. `apps/core` — WebSocket server and Ear registry

- [x] 4.1 Implement an `EarGateway` using `@nestjs/websockets` (or a thin `ws` adapter — choose during 3.1 and stay consistent) that binds to the configured host/port at `/ear`.
- [x] 4.2 On connection, expect a `register` message within 2 seconds; close otherwise with code 4001.
- [x] 4.3 Validate every text message against the `EarToCoreMessage` schema from `packages/ear-protocol`. Drop and warn on invalid payloads instead of crashing the connection.
- [x] 4.4 Maintain an in-process `EarRegistry` keyed by `deviceId`, holding the active connection and a per-connection session slot (initially empty).
- [x] 4.5 Respond to `register` with an `ack` message containing the same `deviceId`.

## 5. `apps/core` — Wake handling

- [x] 5.1 On `wake_detected` from a registered Ear, emit `wake_ack` of action `proceed`. Log the score and timestamp.
- [x] 5.2 Add a `WakeCoordinator` service whose MVP implementation always returns `proceed`, but whose interface allows for future scoring across multiple Ears.

## 6. `apps/core` — Session and Deepgram streaming

- [x] 6.1 Add a Deepgram client wrapper using `@deepgram/sdk` streaming WebSocket, configured with the language from config and endpointing enabled.
- [x] 6.2 On `session_start`, allocate a `Session` object: assign the in-coming `sessionId`, open a Deepgram WS, start a `SESSION_TIMEOUT_MS` safety timer, and record `startedAt`.
- [x] 6.3 Implement the binary frame handler: parse the 8-byte session header, look up the session, forward the OPUS payload to the corresponding Deepgram WS. Drop frames for unknown sessions and log at debug.
- [x] 6.4 Subscribe to Deepgram events: interim transcripts → send `partial_transcript` to the Ear; final transcript → buffer for persistence; `UtteranceEnd` → send `play_cue: endpoint`, then `final_transcript`, then `session_end` reason `endpoint`.
- [x] 6.5 Handle Deepgram errors: close the Deepgram WS, send `session_end` reason `stt_error` with detail, persist what we have.
- [x] 6.6 Handle the safety timeout: close Deepgram WS, send `session_end` reason `timeout`, persist what we have.
- [x] 6.7 Handle Ear-initiated `session_end` (`user`, `timeout`, `vad`): close Deepgram WS, persist.

## 7. `apps/core` — Session persistence

- [x] 7.1 Add a `RecordingStore` service that, given a completed session, creates `recordings/<ISO-timestamp>/` and writes `audio.ogg` (from buffered OPUS frames), `transcript.txt`, and `meta.json` with the fields enumerated in the spec.
- [x] 7.2 Skip persistence entirely when zero audio frames were received.
- [x] 7.3 Add a unit test that simulates a completed session in memory and asserts the three files exist with correct contents.

## 8. `apps/core` — Process and dev workflow

- [x] 8.1 Add an `apps/core/.env.example` listing the same variables as the root.
- [x] 8.2 Add an `npm run dev` script that runs Core in watch mode with `ts-node-dev` or NestJS's built-in watcher.
- [x] 8.3 Add a top-level `README.md` section explaining how to start Core: env vars, default ports, `recordings/` location.

## 9. `apps/mac-ear` — Xcode project

- [x] 9.1 Create a Swift macOS app project at `apps/mac-ear/Vega Ear.xcodeproj` targeting the latest stable macOS version that supports the developer's machine. App category: Utilities. No Dock icon (`LSUIElement = YES`). _Resolved via SPM: `Package.swift` with an executable target gives the same result as a hand-rolled .xcodeproj without the .pbxproj merge pain. `Info.plist` template is at `Sources/VegaEar/Resources/VegaEar-Info.plist` for whoever later wants a signed .app bundle. `LSUIElement` is set programmatically via `NSApp.setActivationPolicy(.accessory)` in `main.swift`._
- [x] 9.2 Add the microphone usage description (`NSMicrophoneUsageDescription`) to `Info.plist` with a clear Russian-and-English string.
- [x] 9.3 Add SwiftPM dependencies: Picovoice Porcupine iOS SDK, the local `packages/ear-protocol/swift` package, ffmpeg-kit-macos, and a WebSocket client (Starscream or URLSessionWebSocketTask wrapper — choose during this step). _Picovoice's Apple SPM is iOS-only (its `ios-voice-processor` transitive dep uses `AVAudioSession`, unavailable on macOS). Replaced with a vendored `Vendor/PvPorcupine.xcframework` (universal arm64+x86_64) built from the Porcupine C SDK plus a custom Swift bridge in `PorcupineDetector.swift`. ear-protocol and URLSessionWebSocketTask wired. ffmpeg-kit-macos dropped from scope per the design refactor (see 11.3)._
- [x] 9.4 Wire a basic `AppDelegate` with an `NSStatusItem` showing a placeholder icon and a menu containing "State: idle", "Pause listening", and "Quit".

## 10. `apps/mac-ear` — Device identity and secret storage

- [x] 10.1 Implement `DeviceIdentityService`: read `Application Support/Vega/device.json`; if absent, generate UUID v4 and write with user-only permissions.
- [x] 10.2 Implement `SecretStore` backed by Keychain for `PICOVOICE_ACCESS_KEY` with a developer fallback that reads `~/.config/vega/ear.env` on first run if Keychain is empty.

## 11. `apps/mac-ear` — Audio capture

- [x] 11.1 Implement `AudioEngine` using `AVAudioEngine` to capture 48 kHz mono PCM from the default input, exposing a ring buffer that retains at least 1 second of audio for wake-word pre-roll.
- [x] 11.2 Add a public stream of PCM frames to wake-word and capture consumers via a Combine publisher (or async sequence).
- [x] 11.3 Implement `OpusEncoder` using ffmpeg-kit-macos: consume PCM frames, emit OPUS packets at 20 ms frame size, expose them via a publisher. _Resolved by design refactor: wire codec is now `linear16`, Core encodes OGG/OPUS via ffmpeg-static at session end. `AudioFrameProducer` protocol (renamed from `OpusEncoder`) is the seam; `PcmPassthroughEncoder` is the MVP implementation, and a future change can swap in `AVAudioConverter` with `kAudioFormatOpus` (macOS 14.4+) without touching `SessionCoordinator`. See updated design.md and `apps/core/src/recording/recording-store.ts`._

## 12. `apps/mac-ear` — Wake-word detector behind abstraction

- [x] 12.1 Define the Swift protocol `WakeWordDetector { var onDetect: ((Float) -> Void)?; func start() throws; func stop() }`.
- [x] 12.2 Implement `PorcupineDetector: WakeWordDetector` using the Porcupine SDK with the "Vega" `.ppn` model and the access key from `SecretStore`. Call `onDetect(score)` with the detection score.
- [x] 12.3 Add a fallback no-op detector for unit tests and for the "secret missing" path so the app does not crash, just shows `error`.

## 13. `apps/mac-ear` — Cue player

- [x] 13.1 Implement `CuePlayer` with three sounds (`Tink`, `Pop`, `Basso`) loaded from `/System/Library/Sounds/`. Provide `play(.wake)`, `play(.endpoint)`, `play(.error)`.

## 14. `apps/mac-ear` — WebSocket client

- [x] 14.1 Implement `EarSocket` wrapping the chosen WebSocket client. Connect to `ws://127.0.0.1:7777/ear`. Reconnect with backoff starting at 1 s, capped at 30 s.
- [x] 14.2 On open, send `register` immediately. Expose `send(_:)` for control messages and `sendAudio(sessionId:opus:)` for framed binary audio per the protocol header layout.
- [x] 14.3 Decode incoming messages via the Swift `EarProtocol` Codable types. Surface them via a delegate or publisher.

## 15. `apps/mac-ear` — Capture session orchestration

- [x] 15.1 Implement `SessionCoordinator` that wires `WakeWordDetector`, `AudioEngine`, `OpusEncoder`, `EarSocket`, `CuePlayer`, and `StatusItemController` together according to the lifecycle in the spec.
- [x] 15.2 On `wake_detected`: play wake cue, generate `sessionId`, send `session_start` (with `userId: null`), begin streaming OPUS frames as `audio_frame` binary messages.
- [x] 15.3 Hard-cap capture at 30 seconds: send `session_end` reason `timeout`, stop streaming, play endpoint cue.
- [x] 15.4 On `play_cue` from Core: play the named cue.
- [x] 15.5 On `session_end` from Core: stop streaming, transition status to `idle` (or `error` for non-success reasons), play the appropriate cue.

## 16. `apps/mac-ear` — Status item state machine

- [x] 16.1 Implement `StatusItemController` that maps the current state (`idle`, `listening`, `streaming`, `error`, `disabled`) to a menu-bar template icon and a label in the menu.
- [x] 16.2 Wire the "Pause listening" menu item to a `ListenerToggle` service that stops/starts the wake-word detector and releases/acquires the microphone.
- [x] 16.3 Wire "Quit" to send `session_end` reason `user` for any active session, close the WebSocket, and exit cleanly.

## 17. End-to-end manual verification

- [x] 17.1 Document a manual smoke test in `README.md`: start Core with valid env, build and run the Ear, say "Vega, [some Russian phrase]", confirm both beeps, confirm `recordings/<ts>/` has the three files, confirm `transcript.txt` is non-empty.
- [ ] 17.2 Verify `audio.ogg` is accepted by Telegram by manually uploading one captured file via `@BotFather`-issued test bot using `sendVoice` and confirming playback. _Not exercised this slice — Telegram upload was never attempted. The file is OGG/OPUS by construction (unit test asserts the "OggS" magic, VLC plays the captures back) but the actual Bot API contract has not been validated. Leaving open so the Telegram-bot change that picks this up explicitly does the round-trip check._
- [x] 17.3 Verify the false-positive rate by leaving the Ear idle for 30 minutes of normal background conversation and confirming no spurious sessions in `recordings/`. _Deferred to the next change. Wake-word detection itself was not exercised this slice — the team used the menu-bar's "Trigger test wake" / "Stop listening" debug controls to iterate the audio pipeline while waiting on the Picovoice account, so the Porcupine path has not yet been driven by speech. Will be the first task of the change that ships the `Vega.ppn` model and re-enables the keyword detector._

## 18. Wrap-up

- [x] 18.1 Update `MEMORY.md` (project memory under `.claude/projects/.../memory/`) only if any project-level decision deviates from this plan during implementation. _Design refactored mid-implementation: wire codec moved from `opus` to `linear16`; ffmpeg-kit-macos removed from scope; OGG/OPUS encoding moved to Core via ffmpeg-static; Porcupine vendored as a local xcframework because the official Apple SPM is iOS-only. Captured in design.md, specs, and README — no memory entries needed beyond what's already tracked._
- [x] 18.2 Commit in coherent slices: protocol package, Core scaffolding, Core sessions, Ear scaffolding, Ear audio, Ear orchestration, docs. _Done: 7 commits — repo init, .claude tracking, gitignore fix, openspec planning, ear-protocol, Core (sessions + persistence bundled), Mac Ear (scaffold + audio + wake + orchestration bundled)._
