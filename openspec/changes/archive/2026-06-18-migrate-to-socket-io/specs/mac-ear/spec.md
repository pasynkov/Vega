## MODIFIED Requirements

### Requirement: WebSocket connection to Core

The Ear SHALL connect to Core's socket.io server at a configurable URL (default `ws://127.0.0.1:7777`) on the `/ear` namespace using the WebSocket transport only (no long-polling fallback). The Ear SHALL adopt `socket-io-client-swift` (~v16) as the client library; the prior `URLSessionWebSocketTask`-based `EarSocket` SHALL be replaced.

The Ear SHALL configure socket.io-client-swift's built-in reconnect to match the legacy backoff behaviour: initial delay 1 s, doubling up to a cap of 30 s, ±25 % jitter. The Ear SHALL reset the reconnect-delay counter only after Core has acknowledged the `register` event (i.e. only after the `ack` arrives), so a tight handshake-reject loop remains impossible.

On a successful `connect` event the Ear SHALL immediately `emit("register", { deviceId, deviceName, capabilities })`. The Ear SHALL register `socket.on(eventName, handler)` for each Core → Ear event listed in the protocol catalog.

The Ear SHALL drop its custom `scheduleReconnect` / `openTask` loop and SHALL NOT layer its own retry logic on top of socket.io-client-swift. The status-item state SHALL be driven from socket.io's connection events (`.connect`, `.disconnect`, `.reconnect`, `.reconnectAttempt`, `.error`).

#### Scenario: Core is reachable at startup

- **WHEN** the app launches and Core accepts the socket.io handshake on `/ear`
- **THEN** the Ear SHALL emit a `register` event within 1 second of the `.connect` callback
- **AND** SHALL transition the status item to `idle` once the wake-word detector is also ready

#### Scenario: Core is unreachable

- **WHEN** the handshake fails or the connection is closed by Core
- **THEN** the status item SHALL show `error`
- **AND** socket.io-client-swift's built-in reconnect SHALL retry with backoff starting at 1 second and capped at 30 seconds, ±25 % jitter
- **AND** the Ear SHALL emit no `wake_detected` events while the connection is down

#### Scenario: Backoff resets only after `ack`

- **WHEN** Core repeatedly accepts the handshake but rejects the `register` payload without sending `ack`
- **THEN** the reconnect-delay counter SHALL continue to grow (not reset)
- **AND** the Ear SHALL NOT busy-loop the handshake at the initial delay

### Requirement: Audio capture

After a `wake_detected` event the Ear SHALL begin capturing mono PCM (signed 16-bit little-endian) from the user's chosen input device at that device's native sample rate. Captured audio SHALL be streamed unencoded to Core as `audio_frame` socket.io events with the binary buffer shipped as a socket.io attachment alongside the `sessionId` text arg. The `session_start` event SHALL declare `codec: "linear16"` and SHALL report the actual `sampleRate`.

The Ear SHALL NOT layer a custom binary header on the audio buffer; the legacy 8-byte `sessionShortId` header used by the raw-WebSocket transport SHALL NOT be sent. Audio dispatch becomes `socket.emit("audio_frame", sessionId, pcmData)`.

A pre-roll buffer SHALL retain approximately the last one second of audio (sized in bytes relative to the live sample rate) and SHALL be prepended to the session when a wake event fires.

The Ear SHALL NOT itself perform speech-to-text.

The Ear SHALL expose a "Microphone" submenu in the menu-bar item that lists every audio input device discovered via CoreAudio plus a "System default" entry. Picking a device SHALL retarget capture without changing the macOS system-wide default. The chosen device SHALL be persisted in `Application Support/Vega/preferences.json` and restored on next launch.

#### Scenario: Wake triggers capture

- **WHEN** a `wake_detected` event is emitted and the socket.io connection is healthy
- **THEN** within 200 ms the Ear SHALL emit a `session_start` event with a freshly generated `sessionId`
- **AND** audio capture SHALL begin from the same buffer that fed the wake-word detector, including the pre-roll preceding the detection

#### Scenario: Audio frames are sent while user speaks

- **WHEN** capture is active
- **THEN** the Ear SHALL `socket.emit("audio_frame", sessionId, pcmBuffer)` at a steady cadence of at least 10 events per second
- **AND** each event SHALL carry the active `sessionId` as its first text argument and the PCM payload as its second binary attachment

#### Scenario: Hard safety cap on capture length

- **WHEN** capture has been active for 30 seconds without a `session_end` from Core
- **THEN** the Ear SHALL emit a `session_end` event with reason `timeout`
- **AND** SHALL stop emitting `audio_frame` events
- **AND** SHALL play the endpoint cue
