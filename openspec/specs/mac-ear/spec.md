# mac-ear Specification

## Purpose

The Vega Ear for macOS — a menu-bar app that always-listens for a wake word, captures the user's task as PCM, streams it to Vega Core, plays audible cues at session boundaries, and persists the user's input device choice. The Ear owns microphone capture and the user-facing UI; Core owns STT and persistence.

## Requirements

### Requirement: Menu-bar presence and lifecycle

The Mac Ear SHALL run as a macOS menu-bar application with no Dock icon, no main window on launch, and a single status item indicating the current listening state.

The status item icon SHALL reflect one of these states: `idle` (listening for wake word), `listening` (between wake-word detection and end of utterance), `streaming` (actively forwarding audio to Core), `error` (Core unreachable, microphone permission denied, wake-word engine failed, or other unrecoverable condition), and `disabled` (user explicitly paused listening).

The status item menu SHALL include at minimum: a label showing the current state, a toggle to pause/resume listening, and a "Quit" item.

#### Scenario: App launches into idle state

- **WHEN** the user launches `Vega Ear.app` and microphone permission has already been granted
- **THEN** a menu-bar icon SHALL appear within 2 seconds
- **AND** no window or Dock icon SHALL appear
- **AND** the status item SHALL show the `idle` state
- **AND** the wake-word detector SHALL be running and consuming microphone audio

#### Scenario: User pauses listening

- **WHEN** the user opens the status-item menu and selects "Pause listening"
- **THEN** the wake-word detector SHALL stop processing audio
- **AND** the microphone input SHALL be released
- **AND** the status item SHALL show the `disabled` state
- **AND** no `wake_detected` event SHALL be emitted until listening is resumed

#### Scenario: User quits the app

- **WHEN** the user selects "Quit" from the status-item menu
- **THEN** any in-flight session SHALL be closed with a `session_end` event of reason `user`
- **AND** the WebSocket connection to Core SHALL be closed cleanly
- **AND** the process SHALL exit within 2 seconds

### Requirement: Microphone permission handling

The Ear SHALL request microphone access on first launch and SHALL not enter the `idle` state without it.

#### Scenario: First launch with no prior permission

- **WHEN** the user launches the app for the first time
- **THEN** the standard macOS microphone permission prompt SHALL appear
- **AND** the status item SHALL show `error` until the user grants permission
- **AND** the status item menu SHALL include a label explaining that microphone access is required

#### Scenario: Permission revoked between launches

- **WHEN** the app launches and `AVCaptureDevice.authorizationStatus(for: .audio)` returns `.denied` or `.restricted`
- **THEN** the status item SHALL show `error`
- **AND** the menu SHALL surface a "Microphone access denied — open Settings" option that deep-links to `System Settings → Privacy & Security → Microphone`

### Requirement: Always-on wake-word detection

The Ear SHALL continuously stream microphone audio through a wake-word detector that emits a `wake_detected` event when any of the configured wake-word candidates is recognized.

The wake-word detector SHALL be accessed only through a `WakeWordDetector` Swift protocol. The implementation behind this protocol SHALL use OpenWakeWord (ONNX). It SHALL load the OpenWakeWord shared front-end (`melspectrogram.onnx`, `embedding_model.onnx`) plus a configurable list of classifier-head model files from the app bundle's `Resources/` directory; no remote download SHALL occur at runtime. The MVP candidate set SHALL be `["Janet", "edna"]`, both as 200 KB community-trained ONNX classifier heads. No call site outside the implementation type SHALL reference OpenWakeWord or ONNX Runtime APIs directly.

For every chunk of captured audio the detector SHALL run the shared front-end exactly once and then run each candidate classifier head against the resulting embedding. The detector SHALL emit a `wake_detected` event when at least one candidate's per-frame confidence score crosses the user-configurable threshold described in the "Tunable wake-word sensitivity" requirement. The winning candidate name and score SHALL be recorded in the app log on every detection so the user can compare candidates offline.

The Ear SHALL also expose a debug "Trigger test wake" / "Stop listening" menu-bar item that synthesises a `wake_detected` event without going through the keyword detector. This lets the developer drive the rest of the pipeline (capture → Core → Deepgram → recordings) end to end. The menu item's label flips based on whether a session is active.

#### Scenario: Wake word candidate is spoken

- **WHEN** the user speaks one of the configured candidate wake words ("Janet" or "Edna") within microphone range while the app is `idle`
- **THEN** within 400 ms a `wake_detected` event SHALL be sent to Core over the WebSocket
- **AND** the status item SHALL transition to `listening`
- **AND** the configured wake cue SHALL be played
- **AND** the app log SHALL include the winning candidate name and confidence score

#### Scenario: Non-wake speech is ignored

- **WHEN** the user speaks for at least 5 seconds without uttering any configured candidate wake word
- **THEN** no `wake_detected` event SHALL be emitted
- **AND** no audio frames SHALL be sent to Core

#### Scenario: Confidence below the configured threshold is ignored

- **WHEN** every candidate classifier produces a per-frame score below the user-configured threshold
- **THEN** no `wake_detected` event SHALL be emitted
- **AND** the status item SHALL remain `idle`

#### Scenario: Wake-word engine fails to initialize

- **WHEN** the OpenWakeWord detector fails to initialize (any required bundled ONNX resource is missing, or ONNX Runtime initialization errors out)
- **THEN** the status item SHALL show `error`
- **AND** the menu SHALL surface a human-readable description of the failure
- **AND** the app SHALL retry initialization no more often than once per 30 seconds

### Requirement: Tunable wake-word sensitivity

The Ear SHALL allow the user to configure the wake-word confidence threshold without editing source. The threshold SHALL be persisted in `Application Support/Vega/preferences.json` alongside the chosen microphone device and SHALL be restored on next launch. The default threshold SHALL be `0.5`. Valid values SHALL be in the open interval `(0.0, 1.0)`. The same threshold SHALL apply uniformly to every configured candidate classifier.

The status-item menu SHALL expose a "Wake sensitivity" submenu with at least the presets `Low (0.3)`, `Default (0.5)`, `High (0.7)`, and `Very High (0.85)`. Selecting a preset SHALL update the threshold immediately for subsequent wake-detection decisions without requiring an app restart.

#### Scenario: User raises sensitivity to "High"

- **WHEN** the user selects `High (0.7)` from the "Wake sensitivity" submenu while the app is `idle`
- **THEN** the threshold SHALL be persisted to `preferences.json`
- **AND** subsequent wake-word evaluations SHALL require a model score of at least 0.7 to emit `wake_detected`
- **AND** no app restart SHALL be required

#### Scenario: Threshold restored on relaunch

- **WHEN** the user previously set the wake sensitivity to `Very High (0.85)` and quits the app
- **AND** the user relaunches the app
- **THEN** the detector SHALL initialize with threshold 0.85
- **AND** the "Wake sensitivity" submenu SHALL show `Very High (0.85)` as the active option

#### Scenario: Missing or invalid threshold value

- **WHEN** the app launches and `preferences.json` is missing, unreadable, or contains a wake-threshold value outside `(0.0, 1.0)`
- **THEN** the detector SHALL initialize with the default threshold 0.5
- **AND** the next successful preference write SHALL persist the default

### Requirement: Audible feedback cues

The Ear SHALL play a system sound on wake-word detection ("wake cue") locally — without waiting on any Core message. The Ear SHALL play a different system sound when entering `continuous` capture via `arm_capture` (`ack_continue` / Submarine) locally, also without waiting on a separate cue message. Every other audible cue SHALL be driven by the `state.sound` field of `overlay_update` messages: when present, the Ear SHALL play the named cue exactly once at the moment the update is rendered.

The MVP cue assets: `wake` → `Purr.aiff`; `endpoint` → `/System/Library/Sounds/Pop.aiff`; `error` → `/System/Library/Sounds/Basso.aiff`; the `ack_*` family uses the existing macOS system sounds. The choice is a one-line constant per cue and may evolve without re-spec.

The Ear SHALL NOT handle a `play_cue` message; that message type has been removed from the protocol.

#### Scenario: Successful capture cycle

- **WHEN** the user says "Vega, write down to buy milk"
- **THEN** the wake cue SHALL play once at wake-word detection (local)
- **AND** an `overlay_update` carrying `state.sound: "ack_done"` (or `"endpoint"` on a non-domain-handled flow) SHALL play exactly once when received
- **AND** no other cue SHALL play during the cycle

#### Scenario: Session ends with error

- **WHEN** Core closes the session with a `session_end` reason other than `vad` or `endpoint`, or the WebSocket disconnects mid-session
- **THEN** the error cue SHALL play if Core supplied it via an `overlay_update` before the disconnect (`state.sound: "error"`), or the Ear's local disconnect handler SHALL play `error` locally
- **AND** the status item SHALL transition back to `idle` (or `error` if the disconnect persists)
- **AND** the overlay SHALL hide

### Requirement: Audio capture

After a `wake_detected` event the Ear SHALL begin capturing mono PCM (signed 16-bit little-endian) from the user's chosen input device at that device's native sample rate. Captured audio SHALL be streamed unencoded to Core as `audio_frame` binary messages with the protocol's session header; the `session_start` message SHALL declare `codec: "linear16"` and report the actual `sampleRate` so Core configures Deepgram and ffmpeg accordingly. Encoding the persisted artifact to OGG/OPUS is Core's responsibility, not the Ear's.

The Ear SHALL expose a "Microphone" submenu in the menu-bar item that lists every audio input device discovered via CoreAudio plus a "System default" entry. Picking a device SHALL retarget capture without changing the macOS system-wide default. The chosen device SHALL be persisted in `Application Support/Vega/preferences.json` and restored on next launch.

A pre-roll buffer SHALL retain approximately the last one second of audio (sized in bytes relative to the live sample rate, so a Bluetooth-HFP capture at 16 kHz holds the same wall-clock duration as a 48 kHz built-in capture) and SHALL be prepended to the session when a wake event fires.

The Ear SHALL NOT itself perform speech-to-text.

#### Scenario: Wake triggers capture

- **WHEN** a `wake_detected` event is emitted and the WebSocket to Core is open
- **THEN** within 200 ms the Ear SHALL send a `session_start` message with a freshly generated `sessionId`
- **AND** audio capture SHALL begin from the same buffer that fed the wake-word detector, including the pre-roll preceding the detection

#### Scenario: Audio frames are sent while user speaks

- **WHEN** capture is active
- **THEN** the Ear SHALL emit `audio_frame` binary messages with `linear16` PCM payloads at a steady cadence of at least 10 frames per second
- **AND** each frame SHALL include the active `sessionId` via the protocol's binary header

#### Scenario: Hard safety cap on capture length

- **WHEN** capture has been active for 30 seconds without a `session_end` from Core
- **THEN** the Ear SHALL send `session_end` with reason `timeout`
- **AND** SHALL stop sending audio frames
- **AND** SHALL play the endpoint cue

### Requirement: Local silence-based endpoint

The Ear SHALL run a streaming RMS-based silence detector on the captured PCM and SHALL terminate a session locally when sustained silence follows observed speech. The detector SHALL self-calibrate per session: the first ~600 ms of capture SHALL be treated as ambient and the 75th-percentile RMS over that window SHALL become the session's noise floor. Speech SHALL be declared when RMS rises sufficiently above the floor; sustained silence (RMS sitting near the floor for ~3 seconds after speech was observed) SHALL fire the endpoint.

On endpoint the Ear SHALL play the endpoint cue locally, send `session_end` with reason `vad`, and return its menu-bar state to `idle` without waiting for Core's echo. This SHALL be the primary end-of-session signal in normal use; Core's own VAD and the safety timer are fallbacks.

#### Scenario: Adaptive endpoint fires after a phrase

- **WHEN** the user speaks a complete phrase and then stops
- **THEN** the Ear SHALL log the calibration result, the moment speech was detected, the moment silence started, and the endpoint
- **AND** SHALL emit `session_end` with reason `vad` within ~3 seconds of the user falling silent
- **AND** SHALL play the endpoint cue without waiting on Core

### Requirement: Stable device identity

The Ear SHALL identify itself to Core with a stable `deviceId` generated on first launch and persisted across restarts.

The `deviceId` SHALL be a UUID v4 written to `Application Support/Vega/device.json` on first launch. The Ear SHALL also send a human-readable `deviceName` derived from the macOS host name.

#### Scenario: First launch generates device identity

- **WHEN** the app launches and no `device.json` exists in Application Support
- **THEN** a new UUID v4 SHALL be generated and written to `device.json`
- **AND** the file SHALL be created with user-only permissions

#### Scenario: Existing identity is reused

- **WHEN** the app launches and a valid `device.json` already exists
- **THEN** the persisted `deviceId` SHALL be reused
- **AND** no new identity SHALL be written

### Requirement: WebSocket connection to Core

The Ear SHALL connect to Core's WebSocket endpoint at a configurable URL (default `ws://127.0.0.1:7777/ear`) and SHALL reconnect with exponential backoff with ±25 % jitter, starting at 1 s and doubling up to a cap of 30 s. The backoff SHALL reset to 1 s only after Core has acknowledged the `register` message, so a tight loop is impossible when Core is reachable but immediately rejects the handshake.

On a successful connect the Ear SHALL immediately send a `register` message containing `deviceId`, `deviceName`, and the capabilities the Ear supports (at minimum `mic`, `wake`, `speaker`).

#### Scenario: Core is reachable at startup

- **WHEN** the app launches and Core accepts the WebSocket handshake
- **THEN** the Ear SHALL send a `register` message within 1 second of the open event
- **AND** SHALL transition the status item to `idle` once the wake-word detector is also ready

#### Scenario: Core is unreachable

- **WHEN** the WebSocket handshake fails or the connection is closed by Core
- **THEN** the status item SHALL show `error`
- **AND** the Ear SHALL attempt reconnection with backoff starting at 1 second and capped at 30 seconds
- **AND** no `wake_detected` events SHALL be emitted while the connection is down

### Requirement: Long-note mode handling

The Ear SHALL recognise a per-session `mode` field on `session_start` and a Core-initiated `arm_capture` message. The two modes are `regular` (default; existing behaviour) and `continuous`.

When in `continuous` mode the Ear SHALL:
- Suppress the local VAD endpoint decision (the detector keeps running for logs but never fires `session_end` of reason `vad`).
- Reschedule its safety capture cap to ~60 seconds, reset on every incoming partial or final transcript event.
- Play the `ack_continue` cue (Submarine) when the mode is entered via `arm_capture`.

When the Ear receives `arm_capture` it SHALL open a fresh capture session under the requested mode without requiring a wake-word, and SHALL emit a `session_start` carrying the same `mode` field.

#### Scenario: arm_capture opens a fresh long-note session

- **WHEN** the Ear receives `{ "type": "arm_capture", "mode": "continuous" }` and no session is active
- **THEN** the Ear SHALL allocate a new sessionId, play `ack_continue`, and send `session_start` with `mode: "continuous"`
- **AND** the new session SHALL run with the VAD endpoint suppressed and a ~60 second safety cap

#### Scenario: long-note session ends by Core endpoint, not local VAD

- **WHEN** the user finishes dictating and Core sends `session_end` of reason `endpoint`
- **THEN** the Ear SHALL play the endpoint cue and return to `idle`
- **AND** the local VAD SHALL NOT have fired during the long-note session

### Requirement: Interactive overlay window

The Mac Ear SHALL render an interactive overlay window driven by `overlay_update` messages from Core. The overlay SHALL be implemented as an `NSPanel` with:

- `styleMask` containing `.borderless` and `.nonactivatingPanel`
- `level` set to `.floating`
- `backgroundColor = .clear`, `isOpaque = false`, `hasShadow = false`
- `ignoresMouseEvents = true` at all times (the overlay is purely informational; cancelling a session is done by going silent, not by clicking)
- `collectionBehavior` allowing it to appear on every Space and stay above fullscreen apps

The overlay SHALL anchor under the menu-bar status item: its top-right corner sits ≈6 pt below the status icon's bottom-right corner (clamped to the screen), so it reads as a dropdown from the tray icon. When the status-item frame is not available yet, the overlay SHALL fall back to the top-right corner of the screen containing the menu-bar item. Its content SHALL be a SwiftUI view composed of:

- An orb visual (SwiftUI `Canvas` or shape with state-driven gradient + pulse animation) sized ~96 pt, plus an SF Symbol glyph centered inside the orb that uniquely identifies the current `kind` (`mic.fill` for listening, `waveform` for capturing, `sparkle` for thinking, `gearshape.fill` for processing, `checkmark` for success, `exclamationmark` for error).
- An optional top text section showing `state.hint` (collapses if absent).
- An optional bottom text section showing `state.caption` (collapses if absent).
- A rounded-rect background using `.ultraThinMaterial` with `cornerRadius: 22`.
- Fade-in/scale-up appearance and fade-out/scale-down disappearance, animated over ~200 ms. Content transitions (kind/hint/caption) SHALL apply instantly, without crossfade, so the visual matches the cue sound that arrived with the same update.

The overlay SHALL be visible whenever the current `state.kind` is not `idle`. On `idle` it SHALL hide. The Ear SHALL NOT hide the overlay in response to `session_end` (Core- or Ear-initiated); the overlay is intentionally decoupled from session lifecycle so the user keeps seeing a `thinking` / `capturing` state while the orchestrator dispatches between sessions. The overlay SHALL hide only on (a) receipt of an `overlay_update` with `state.kind == idle`, (b) WebSocket disconnect from Core, (c) user-initiated pause or app shutdown.

#### Scenario: Overlay appears on first non-idle update

- **WHEN** the Ear receives `{ type: "overlay_update", seq: 1, state: { kind: "listening" } }` and the overlay is currently hidden
- **THEN** the overlay window SHALL fade in within ~200 ms with the listening orb visual
- **AND** no top or bottom text section SHALL be rendered

#### Scenario: Overlay shows hint and caption together

- **WHEN** the Ear receives `{ type: "overlay_update", seq: 7, state: { kind: "processing", hint: "Сохраняю заметку…", caption: "купи молоко" } }`
- **THEN** the overlay SHALL render the processing orb, the hint above, and the caption below

#### Scenario: Overlay survives session_end (bridge state during dispatch)

- **WHEN** the Ear has a visible overlay (e.g. `thinking`) and receives `{ type: "session_end", sessionId: <S>, reason: "endpoint" }` for the active session
- **THEN** the overlay SHALL stay visible with its current state
- **AND** the next `overlay_update` Core emits (e.g. `arm_capture` follow-up `capturing`, domain `success`, or implicit `idle`) SHALL drive the transition

#### Scenario: Overlay collapses on idle update

- **WHEN** the Ear receives `{ type: "overlay_update", seq: N, state: { kind: "idle" } }`
- **THEN** the overlay SHALL fade out and hide
- **AND** the next visible overlay SHALL require a new non-idle update from Core

### Requirement: Overlay state model parser tolerates unknown values

The Ear SHALL decode `overlay_update.state.kind` and `overlay_update.state.sound` via Codable. Unknown enum values SHALL be surfaced as `.unknown` without aborting the WebSocket connection. An `overlay_update` whose `kind` is `.unknown` SHALL render the default `listening`-style orb with whatever text fields decoded successfully, and SHALL be logged at debug level so the schema gap is visible offline.

#### Scenario: Unknown kind falls back to listening visual

- **WHEN** the Ear receives `{ type: "overlay_update", seq: 3, state: { kind: "wat", hint: "x" } }`
- **THEN** the overlay SHALL render the listening-style orb with hint `"x"`
- **AND** the WebSocket SHALL stay open
- **AND** the app log SHALL include a debug entry naming the unknown kind
