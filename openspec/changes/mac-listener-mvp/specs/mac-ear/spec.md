## ADDED Requirements

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

The Ear SHALL play a system sound on wake-word detection ("wake cue") and a different system sound on end-of-utterance signaled by Core ("endpoint cue").

The wake cue SHALL be `/System/Library/Sounds/Tink.aiff`. The endpoint cue SHALL be `/System/Library/Sounds/Pop.aiff`. A third "error cue" using `/System/Library/Sounds/Basso.aiff` SHALL be played when a session ends with a non-success reason.

#### Scenario: Successful capture cycle

- **WHEN** the user says "Vega, write down to buy milk"
- **THEN** `Tink.aiff` SHALL play once at wake-word detection
- **AND** `Pop.aiff` SHALL play once when Core signals `final_transcript` or `play_cue` of `endpoint`
- **AND** no other cue SHALL play during the cycle

#### Scenario: Session ends with error

- **WHEN** Core closes the session with a `session_end` reason other than `vad` or `endpoint`, or the WebSocket disconnects mid-session
- **THEN** `Basso.aiff` SHALL play once
- **AND** the status item SHALL transition back to `idle` (or `error` if the disconnect persists)

### Requirement: Audio capture and OPUS encoding

After a `wake_detected` event the Ear SHALL begin capturing 48 kHz mono PCM (signed 16-bit little-endian) from the default input device. Captured audio SHALL be streamed unencoded to Core as `audio_frame` binary messages with the protocol's session header; the `session_start` message SHALL declare `codec: "linear16"`. Encoding the persisted artifact to OGG/OPUS is Core's responsibility, not the Ear's.

The Ear SHALL NOT itself perform speech-to-text. The Ear SHALL NOT itself implement end-of-utterance detection beyond a hard safety cap.

#### Scenario: Wake triggers capture

- **WHEN** a `wake_detected` event is emitted and the WebSocket to Core is open
- **THEN** within 200 ms the Ear SHALL send a `session_start` message with a freshly generated `sessionId`
- **AND** audio capture SHALL begin from the same buffer that fed the wake-word detector, including a pre-roll of approximately 300 ms preceding the detection

#### Scenario: Audio frames are sent while user speaks

- **WHEN** capture is active
- **THEN** the Ear SHALL emit `audio_frame` binary messages with `linear16` PCM payloads at a steady cadence of at least 10 frames per second
- **AND** each frame SHALL include the active `sessionId` via the protocol's binary header

#### Scenario: Hard safety cap on capture length

- **WHEN** capture has been active for 30 seconds without a `session_end` from Core
- **THEN** the Ear SHALL send `session_end` with reason `timeout`
- **AND** SHALL stop sending audio frames
- **AND** SHALL play the endpoint cue

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

The Ear SHALL connect to Core's WebSocket endpoint at a configurable URL (default `ws://127.0.0.1:7777/ear`) and SHALL reconnect with exponential backoff on disconnect.

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
