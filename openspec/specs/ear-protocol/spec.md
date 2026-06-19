# ear-protocol Specification

## Purpose

Defines the socket.io event catalog and payload schemas between any Vega Ear client (Mac menu-bar app, future Pi/iOS edges) and Vega Core. The schema lives in a single source-of-truth package consumed by both sides so wire compatibility is enforced at build time rather than discovered at runtime.

## Requirements

### Requirement: Shared WebSocket message schema

The repository SHALL define a single source of truth for the Ear ↔ Core wire protocol in `packages/ear-protocol/`. The package SHALL export TypeScript types and runtime validators (Zod) consumed by Core, plus a Swift mirror — Codable structs with matching field names — consumed by Mac Ear.

The wire SHALL be socket.io. Each message type SHALL be a separate socket.io event with its own payload schema; the package SHALL export both the event name and the corresponding Zod schema / Swift Codable struct. The TypeScript and Swift representations of every event SHALL agree on field names, types, and required-vs-optional designation. A test in the package SHALL verify that an example payload of each event type round-trips through both representations identically.

The historical raw-`ws` discriminated unions (`EarToCoreMessageSchema`, `CoreToEarMessageSchema`) SHALL be removed; the discriminator is now the socket.io event name and the union shape no longer applies.

#### Scenario: TypeScript and Swift agree on event payload shapes

- **WHEN** the package's round-trip test suite runs
- **THEN** every event declared in the package SHALL have at least one example payload
- **AND** that payload SHALL parse and re-serialize identically through both the TypeScript validator and the Swift Codable decoder

### Requirement: Message catalog — Ear to Core

The protocol SHALL define the following socket.io events emitted by the Ear to Core:

- `register` — fired once per connection immediately after `connect`. Payload `{deviceId (UUID v4), deviceName (string), capabilities (array)}`.
- `wake_detected` — fired whenever the Ear's wake-word detector fires. Payload `{deviceId (UUID v4), score (number, 0..1), timestamp (ISO-8601 string)}`.
- `session_start` — fired to open a capture session. Payload `{deviceId, sessionId (UUID v4), userId (nullable string), sampleRate (positive int), codec (enum: linear16 | opus), mode? (enum: regular | continuous | ask | immersive)}`.
- `audio_frame` — fired repeatedly during a session. Payload SHALL be emitted as `socket.emit("audio_frame", sessionId, buffer)`: first arg is the `sessionId` string, second arg is the binary buffer (PCM bytes for `linear16`, OPUS packet for `opus`). socket.io SHALL ship the buffer as a binary attachment.
- `session_end` — fired when the Ear decides to terminate the session locally. Payload `{sessionId, reason (enum: user | timeout | vad)}`.

The `userId` field SHALL be present in every `session_start` even when it is null in the MVP. Removing or renaming `userId` later is a breaking change to the protocol.

The 8-byte `sessionShortId` binary header used by the previous raw-WebSocket transport SHALL NOT be used. The socket.io binary-attachment mechanism replaces it; `binary-frame.ts` and `sessionShortIdFromUuid` are removed from the package.

#### Scenario: `register` validates a well-formed example

- **WHEN** the validator is given `{ "deviceId": "<uuid>", "deviceName": "MacBook Pro", "capabilities": ["mic","wake","speaker"] }`
- **THEN** validation SHALL succeed

#### Scenario: `session_start` requires `userId`

- **WHEN** the validator is given a `session_start` payload missing the `userId` field
- **THEN** validation SHALL fail with an error identifying the missing field

#### Scenario: `audio_frame` emits the buffer as a binary attachment

- **WHEN** the Ear emits `socket.emit("audio_frame", "<sessionId>", <PCM buffer>)`
- **THEN** Core SHALL receive the event with the buffer as a `Buffer` argument
- **AND** the buffer SHALL NOT be prefixed by the legacy 8-byte sessionShortId header

### Requirement: Message catalog — Core to Ear

The protocol SHALL define the following socket.io events emitted by Core to the Ear:

- `ack` — response to `register`. Payload `{deviceId}`.
- `wake_ack` — response to `wake_detected`. Payload `{action (enum: proceed | yield)}`.
- `partial_transcript` — interim STT result. Payload `{sessionId, text (string), isFinal: false}`.
- `final_transcript` — terminal STT result. Payload `{sessionId, text (string)}`.
- `overlay_update` — drives the interactive overlay. Payload `{seq (positive int, monotonic per device per connection), state: { kind, hint?, caption?, sound? }}`. The `state.kind` field SHALL be one of `idle`, `listening`, `capturing`, `thinking`, `processing`, `success`, `error`, `view`, `immersive`. The `state.sound` field, when present, SHALL be one of `endpoint`, `error`, `ack_done`, `ack_continue`, `ack_thinking`, `ack_success`, `ack_error`, `ack_unknown` (the `wake` cue is local-only and never appears here).
- `list_view_update` — drives a generic list-view surface. Payload `{seq (positive int, monotonic per device per connection on its own channel), view: { title?, items: [{id, label, done}], open }}`. The Ear renders the `items` array verbatim; `done` items render struck-through.
- `session_mode` — forward-compat mode hint for an active session. Payload `{sessionId, mode}`.
- `arm_capture` — backend-initiated capture trigger. Payload `{mode}`.
- `session_end` — Core-initiated end of session. Payload `{sessionId, reason (enum: endpoint | timeout | stt_error | user), detail? (string)}`.

`wake_ack.action` SHALL be `proceed` in the MVP; the `yield` value exists in the enum so a future coordination change can use it without renegotiation.

Every `overlay_update` SHALL carry a complete state record; there is no patch form. The `seq` on `overlay_update` and `list_view_update` is independent per channel: each SHALL maintain its own per-device monotonic counter starting at `1`. Both SHALL allow the Ear to drop out-of-order delivery within their own channel (last-writer-wins).

The Swift decoder SHALL tolerate unknown `state.kind`, `state.sound`, `arm_capture.mode`, and `session_mode.mode` values by surfacing them as `.unknown*` rather than disconnecting.

#### Scenario: `wake_ack` accepts the reserved `yield` action

- **WHEN** the validator is given `{ "type": "wake_ack", "action": "yield" }`
- **THEN** validation SHALL succeed
- **AND** Core MVP code SHALL never emit `yield`

#### Scenario: `overlay_update` accepts every kind including `view` and `immersive`

- **WHEN** the validator is given an `overlay_update` whose `state.kind` is any of `idle`, `listening`, `capturing`, `thinking`, `processing`, `success`, `error`, `view`, `immersive`
- **THEN** validation SHALL succeed

#### Scenario: `overlay_update.state.sound` rejects `wake`

- **WHEN** the validator is given an `overlay_update` with `state.sound: "wake"`
- **THEN** validation SHALL fail; `wake` is a local-Ear cue and never flows over the wire in `overlay_update`

#### Scenario: `list_view_update` accepts an open snapshot with items

- **WHEN** the validator is given `{ "type": "list_view_update", "seq": 1, "view": { "title": "Список покупок", "items": [{ "id": "a", "label": "молоко 1 л", "done": false }, { "id": "b", "label": "яйца", "done": true }], "open": true } }`
- **THEN** validation SHALL succeed

#### Scenario: `list_view_update` accepts a close message

- **WHEN** the validator is given `{ "type": "list_view_update", "seq": 4, "view": { "items": [], "open": false } }`
- **THEN** validation SHALL succeed

#### Scenario: `arm_capture` opens a fresh session

- **WHEN** the Ear receives `{ "type": "arm_capture", "mode": "continuous" }`
- **THEN** the Ear SHALL open a new capture session under `continuous` mode without waiting for a wake-word
- **AND** the Ear SHALL play the `ack_continue` cue
- **AND** the Ear SHALL send `session_start` carrying `mode: "continuous"`

### Requirement: Session lifecycle

A capture session SHALL begin with a `session_start` message from the Ear and end with a `session_end` message sent by whichever side ends the session first. After the session-ending message both sides SHALL stop sending `audio_frame`, `partial_transcript`, and `final_transcript` for that `sessionId`.

A `final_transcript` SHALL be sent by Core no later than its `session_end` of reason `endpoint` for the same `sessionId`.

Only one session per Ear SHALL be active at a time in the MVP.

#### Scenario: Audio frames after `session_end` are ignored

- **WHEN** Core has sent `session_end` for a `sessionId` and the Ear sends an additional `audio_frame` for the same `sessionId`
- **THEN** Core SHALL drop the frame and SHALL log the event at debug level
- **AND** Core SHALL NOT reopen the Deepgram connection for that `sessionId`

#### Scenario: Wake during an active session

- **WHEN** the Ear emits `wake_detected` while it has an active session
- **THEN** the Ear SHALL NOT emit a new `session_start`
- **AND** Core SHALL respond with `wake_ack` of action `yield`

### Requirement: Wire encoding

All control events SHALL travel as socket.io events over a WebSocket transport (no long-polling fallback). socket.io text packets SHALL carry the per-event JSON payload; the `audio_frame` event SHALL ship the PCM/OPUS buffer as a socket.io binary attachment alongside the `sessionId` text arg. No additional framing header is required; the Ear and Core SHALL NOT layer custom binary headers on top of socket.io's transport.

#### Scenario: Binary attachment routes to the correct session

- **WHEN** Core receives an `audio_frame` event with `sessionId = X` and a binary attachment of `N` bytes
- **THEN** Core SHALL forward the `N`-byte buffer to the Deepgram session bound to `sessionId = X`
- **AND** SHALL drop the buffer if no active session matches

### Requirement: Immersive session-mode wire variant

The `session_start.mode` enum SHALL accept `immersive` in addition to `regular`, `continuous`, and `ask`. The `arm_capture.mode` enum SHALL also accept `immersive`. The `session_mode.mode` enum SHALL accept `immersive` (forward-compat hint for an active session). The Swift decoder SHALL surface unknown mode values as `.unknown` rather than disconnecting (already the rule); the new `immersive` value SHALL decode as a first-class variant on both TypeScript and Swift sides.

#### Scenario: session_start validates immersive mode

- **WHEN** the validator is given `session_start` with `mode: "immersive"`
- **THEN** validation SHALL succeed on both TypeScript and Swift sides

#### Scenario: arm_capture dispatches immersive mode

- **WHEN** the Ear receives `{ "type": "arm_capture", "mode": "immersive" }`
- **THEN** the Ear SHALL open a new capture session under `immersive` mode without waiting for a wake-word
- **AND** the Ear SHALL play the `ack_continue` cue (same as continuous — the same "long session opened" auditory signal)
- **AND** the Ear SHALL send `session_start` carrying `mode: "immersive"`

#### Scenario: round-trip fixture for immersive

- **WHEN** the package's round-trip test suite runs
- **THEN** at least one fixture per `session_start`, `arm_capture`, and `session_mode` event SHALL carry `mode: "immersive"`
- **AND** that fixture SHALL parse identically through TypeScript and Swift representations

### Requirement: Immersive overlay kind

The `overlay_update.state.kind` enum SHALL accept `immersive` in addition to `idle`, `listening`, `capturing`, `thinking`, `processing`, `success`, `error`, `view`. `immersive` SHALL render an Ear-side UI variant that visually combines the static `view` surface (live list / caption) with a "live listening" indicator (waveform / pulsing border). The state record may carry `caption` and `hint` like other kinds.

#### Scenario: overlay_update accepts immersive kind

- **WHEN** the validator is given an `overlay_update` whose `state.kind` is `immersive`
- **THEN** validation SHALL succeed
- **AND** Swift decoding SHALL succeed and surface the kind as `.immersive`

#### Scenario: round-trip fixture for immersive overlay kind

- **WHEN** the package's round-trip test suite runs
- **THEN** at least one `overlay_update` fixture SHALL carry `state.kind: "immersive"`
