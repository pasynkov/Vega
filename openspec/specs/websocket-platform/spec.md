# websocket-platform Specification

## Purpose

The socket.io-based wire between Vega Core and any Vega Ear client — namespace, adapter, gateway pattern, event catalog policy, validation pipeline, and reconnect semantics. Per-event payload schemas live in `ear-protocol`; this capability owns the platform contract that ferries them.

## Requirements

### Requirement: socket.io is the wire between Vega Core and any Ear client

Vega Core SHALL expose its Ear-facing wire as a socket.io server, not a raw WebSocket server. The implementation SHALL use the NestJS adapter `@nestjs/platform-socket.io` plus the `@nestjs/websockets` decorator stack (`@WebSocketGateway`, `@SubscribeMessage`, `@WebSocketServer`, `@ConnectedSocket`, `@MessageBody`). All Ear clients SHALL use a socket.io-compatible client (`socket-io-client-swift` on mac-ear).

The server SHALL run on a single namespace `/ear` configured with `transports: ['websocket']` (no long-polling fallback). The Vega Core daemon SHALL otherwise keep its bind defaults (`127.0.0.1:7777`).

#### Scenario: Ear connects via socket.io and the namespace handshake succeeds

- **WHEN** a mac-ear binary boots and connects to `ws://127.0.0.1:7777/ear` using `socket-io-client-swift`
- **THEN** the socket.io handshake SHALL complete on the `/ear` namespace using the WebSocket transport (no polling)
- **AND** Core SHALL register the connection and call the Ear-side `connect` handler

#### Scenario: Wrong transport is rejected

- **WHEN** a client attempts to connect using the long-polling fallback transport
- **THEN** the server SHALL refuse the handshake
- **AND** the Ear binary SHALL never attempt long-polling in any production build

### Requirement: EarIoAdapter sets server-level socket.io options

Vega Core SHALL provide a `EarIoAdapter extends IoAdapter` (`@nestjs/platform-socket.io`) and SHALL register it at boot via `app.useWebSocketAdapter(new EarIoAdapter(app))`. The adapter SHALL configure:

- `pingInterval` and `pingTimeout` long enough to survive ordinary mac sleep/wake cycles without false disconnects.
- A per-connection `id` generator backed by `ulid` so socket ids are stable for log correlation across reconnect.
- The default socket.io memory adapter (no Redis / external store) — the MVP is single-process.

#### Scenario: Adapter installs custom id generation

- **WHEN** the adapter is registered and a new connection arrives
- **THEN** the socket `id` SHALL be a `ulid` rather than the socket.io default 20-character random id
- **AND** the `id` SHALL appear unchanged in subsequent log lines for that connection

### Requirement: Inbound events catalog (Ear → Core)

The gateway SHALL declare `@SubscribeMessage` handlers for the following Ear → Core events; each handler SHALL validate its payload through the corresponding `ear-protocol` Zod schema and SHALL log + reject (without disconnecting) any payload that fails validation:

- `register` — payload `{deviceId, deviceName, capabilities}`. The handler SHALL register the connection in `EarRegistry` and SHALL emit `ack {deviceId}` back to the same socket.
- `wake_detected` — payload `{deviceId, score, timestamp}`. The handler SHALL run the wake policy and SHALL emit `wake_ack {action}` back to the same socket.
- `session_start` — payload `{deviceId, sessionId, userId, sampleRate, codec, mode?}`. The handler SHALL hand the message to `SessionService.start`.
- `session_end` — payload `{sessionId, reason}`. The handler SHALL hand the message to `SessionService.endFromEar`.
- `audio_frame` — first arg is the `sessionId` (string), second arg is the binary buffer. The handler SHALL route the buffer to `SessionService.forwardAudio`.

Any unhandled event name SHALL be logged at debug level and ignored (no disconnect).

#### Scenario: Malformed payload is rejected without disconnect

- **WHEN** the Ear emits `wake_detected` with `score: "high"` (string instead of number)
- **THEN** validation SHALL fail
- **AND** Core SHALL log the validation error at warn level
- **AND** the socket SHALL remain connected

#### Scenario: audio_frame routes the binary buffer to the session

- **WHEN** the Ear emits `socket.emit("audio_frame", "<sessionId>", <PCM buffer>)`
- **THEN** Core SHALL receive the buffer as a `Buffer` argument
- **AND** SHALL forward it to `SessionService.forwardAudio(sessionId, buffer)`

### Requirement: Outbound events catalog (Core → Ear)

Core SHALL emit the following events to a single Ear socket using `socket.emit(event, payload)` (no `io.to(room)` in this iteration — rooms come later):

- `ack {deviceId}` — response to `register`.
- `wake_ack {action}` — response to `wake_detected`.
- `partial_transcript {sessionId, text, isFinal: false}` — streaming STT interim.
- `final_transcript {sessionId, text}` — STT terminal.
- `overlay_update {seq, state: { kind, hint?, caption?, sound? }}` — drives the overlay orb. Payload semantics unchanged from the `ear-protocol` spec.
- `list_view_update {seq, view: { title?, items, open }}` — drives the list-view surface. Payload semantics unchanged.
- `session_mode {sessionId, mode}` — forward-compat mode hint.
- `arm_capture {mode}` — backend-initiated capture trigger.
- `session_end {sessionId, reason, detail?}` — terminate session.

Each outbound event SHALL carry the exact same payload shape it carried as a `ws` text frame previously; the change is the transport, not the semantics.

#### Scenario: overlay_update reaches the registered socket

- **WHEN** `OverlayService.set(deviceId, {kind: "listening"})` is called for a registered device
- **THEN** the corresponding socket SHALL receive a socket.io event named `overlay_update`
- **AND** the payload SHALL match the `OverlayUpdateMessageSchema` shape

### Requirement: EarRegistry stores socket.io sockets

`EarRegistry` SHALL track per-device socket.io `Socket` references (not raw `ws.WebSocket`). The registry SHALL replace any prior socket for the same `deviceId` and SHALL disconnect the superseded socket. Disconnect on either side SHALL remove the entry. Outbound paths SHALL call into a small `emitTo(deviceId, event, ...args)` helper exposed by the registry so service code never reaches for the socket directly.

#### Scenario: Reconnect supersedes the prior socket

- **WHEN** an Ear with `deviceId: X` is already registered and a second socket sends `register` for the same `deviceId`
- **THEN** the prior socket SHALL be disconnected
- **AND** the new socket SHALL replace it in the registry

### Requirement: Validation pipeline at the gateway

Inbound `@SubscribeMessage` handlers SHALL validate payloads through the corresponding `ear-protocol` Zod schema. Validation failures SHALL log a warning and drop the message; they SHALL NOT crash or disconnect the socket. The `AlwaysAckInterceptor` pattern from balancy is OUT of scope for this iteration; it MAY be added later if real ack semantics are needed for specific outbound flows.

#### Scenario: A handler validation fails

- **WHEN** an inbound `wake_detected` arrives with a non-numeric `score`
- **THEN** the Zod schema SHALL reject it
- **AND** Core SHALL log a warn-level message naming the validation issue
- **AND** the socket SHALL stay connected

### Requirement: socket.io built-in reconnect replaces custom backoff

`mac-ear` SHALL drop its hand-rolled exponential backoff in `EarSocket.swift` and SHALL rely on the socket.io-client-swift built-in reconnect, configured to match the prior behaviour:

- initial reconnect delay ≈ 1 s
- doubling backoff up to a cap of 30 s
- ±25 % jitter
- backoff counter SHALL reset only after a successful handshake + `ack` from Core (i.e. only after the new `register` round-trip completes)

#### Scenario: Reconnect after a transient Core restart

- **WHEN** Core restarts and the Ear's socket.io client reconnects within 60 s
- **THEN** the client SHALL re-handshake via socket.io reconnect
- **AND** SHALL re-emit `register` on the new connection
- **AND** the reconnect-delay counter SHALL reset only after Core's `ack` response arrives
