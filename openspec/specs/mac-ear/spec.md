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

The Ear SHALL continuously stream microphone audio through a wake-word detector that emits a `wake_detected` event when the configured keyword is recognized.

The wake-word detector SHALL be accessed only through a `WakeWordDetector` Swift protocol. The MVP implementation behind this protocol SHALL use Porcupine with the keyword "Vega" and a Picovoice access key loaded from secure storage. No call site outside the implementation type SHALL reference Porcupine APIs directly.

The Ear SHALL also expose a debug "Trigger test wake" / "Stop listening" menu-bar item that synthesises a `wake_detected` event without going through the keyword detector. This lets the developer drive the rest of the pipeline (capture → Core → Deepgram → recordings) before a `Vega.ppn` model has been provisioned. The menu item's label flips based on whether a session is active.

#### Scenario: Wake word is spoken

- **WHEN** the user speaks "Vega" within microphone range while the app is `idle`
- **THEN** within 400 ms a `wake_detected` event SHALL be sent to Core over the WebSocket
- **AND** the status item SHALL transition to `listening`
- **AND** the configured wake cue SHALL be played

#### Scenario: Non-wake speech is ignored

- **WHEN** the user speaks for at least 5 seconds without uttering the wake word
- **THEN** no `wake_detected` event SHALL be emitted
- **AND** no audio frames SHALL be sent to Core

#### Scenario: Wake-word engine fails to initialize

- **WHEN** the Porcupine engine fails to initialize (invalid access key, missing model file, device slot exhausted)
- **THEN** the status item SHALL show `error`
- **AND** the menu SHALL surface a human-readable description of the failure
- **AND** the app SHALL retry initialization no more often than once per 30 seconds

### Requirement: Audible feedback cues

The Ear SHALL play a system sound on wake-word detection ("wake cue") and a different system sound on end-of-utterance ("endpoint cue").

The wake cue SHALL be a short, distinct system sound (the MVP ships `Purr.aiff`, chosen after Tink/Glass/Bottle were rejected by the developer as too sharp). The endpoint cue SHALL be `/System/Library/Sounds/Pop.aiff`. A third "error cue" using `/System/Library/Sounds/Basso.aiff` SHALL be played when a session ends with a non-success reason. All three sounds are loaded from `/System/Library/Sounds/`; the choice is a one-line constant and may evolve without re-spec.

#### Scenario: Successful capture cycle

- **WHEN** the user says "Vega, write down to buy milk"
- **THEN** the wake cue SHALL play once at wake-word detection
- **AND** the endpoint cue SHALL play once when the local VAD endpoints or Core signals `play_cue` of `endpoint`
- **AND** no other cue SHALL play during the cycle

#### Scenario: Session ends with error

- **WHEN** Core closes the session with a `session_end` reason other than `vad` or `endpoint`, or the WebSocket disconnects mid-session
- **THEN** the error cue SHALL play once
- **AND** the status item SHALL transition back to `idle` (or `error` if the disconnect persists)

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

The Ear SHALL recognise a per-session `mode` field on `session_start` and a Core-initiated `arm_capture` message. The two modes are `regular` (default; existing behaviour) and `long_note`.

When in `long_note` mode the Ear SHALL:
- Suppress the local VAD endpoint decision (the detector keeps running for logs but never fires `session_end` of reason `vad`).
- Reschedule its safety capture cap to ~60 seconds, reset on every incoming partial or final transcript event.
- Play the `ack_continue` cue (Submarine) when the mode is entered via `arm_capture`.

When the Ear receives `arm_capture` it SHALL open a fresh capture session under the requested mode without requiring a wake-word, and SHALL emit a `session_start` carrying the same `mode` field.

#### Scenario: arm_capture opens a fresh long-note session

- **WHEN** the Ear receives `{ "type": "arm_capture", "mode": "long_note" }` and no session is active
- **THEN** the Ear SHALL allocate a new sessionId, play `ack_continue`, and send `session_start` with `mode: "long_note"`
- **AND** the new session SHALL run with the VAD endpoint suppressed and a ~60 second safety cap

#### Scenario: long-note session ends by Core endpoint, not local VAD

- **WHEN** the user finishes dictating and Core sends `session_end` of reason `endpoint`
- **THEN** the Ear SHALL play the endpoint cue and return to `idle`
- **AND** the local VAD SHALL NOT have fired during the long-note session
