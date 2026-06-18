## MODIFIED Requirements

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
- `session_start` — fired to open a capture session. Payload `{deviceId, sessionId (UUID v4), userId (nullable string), sampleRate (positive int), codec (enum: linear16 | opus), mode? (enum: regular | continuous)}`.
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
- `overlay_update` — drives the interactive overlay. Payload `{seq (positive int, monotonic per device per connection), state: { kind, hint?, caption?, sound? }}`. The `state.kind` field SHALL be one of `idle`, `listening`, `capturing`, `thinking`, `processing`, `success`, `error`, `view`. The `state.sound` field, when present, SHALL be one of `endpoint`, `error`, `ack_done`, `ack_continue`, `ack_thinking`, `ack_success`, `ack_error`, `ack_unknown` (the `wake` cue is local-only and never appears here).
- `list_view_update` — drives a generic list-view surface. Payload `{seq (positive int, monotonic per device per connection on its own channel), view: { title?, items: [{id, label, done}], open }}`. The Ear renders the `items` array verbatim; `done` items render struck-through.
- `session_mode` — forward-compat mode hint for an active session. Payload `{sessionId, mode}`.
- `arm_capture` — backend-initiated capture trigger. Payload `{mode}`.
- `session_end` — Core-initiated end of session. Payload `{sessionId, reason (enum: endpoint | timeout | stt_error | user), detail? (string)}`.

`wake_ack.action` SHALL be `proceed` in the MVP; the `yield` value exists in the enum so a future coordination change can use it without renegotiation.

Every `overlay_update` SHALL carry a complete state record; there is no patch form. The `seq` on `overlay_update` and `list_view_update` is independent per channel: each SHALL maintain its own per-device monotonic counter starting at `1`. Both SHALL allow the Ear to drop out-of-order delivery within their own channel (last-writer-wins).

The Swift decoder SHALL tolerate unknown `state.kind`, `state.sound`, `arm_capture.mode`, and `session_mode.mode` values by surfacing them as `.unknown*` rather than disconnecting.

#### Scenario: `overlay_update` accepts every kind including `view`

- **WHEN** the validator is given an `overlay_update` whose `state.kind` is any of `idle`, `listening`, `capturing`, `thinking`, `processing`, `success`, `error`, `view`
- **THEN** validation SHALL succeed

#### Scenario: `list_view_update` accepts an open snapshot with items

- **WHEN** the validator is given an event payload `{ "seq": 1, "view": { "title": "Список покупок", "items": [{ "id": "a", "label": "молоко 1 л", "done": false }], "open": true } }`
- **THEN** validation SHALL succeed

#### Scenario: `arm_capture` opens a fresh session

- **WHEN** the Ear receives an `arm_capture` event with payload `{ "mode": "continuous" }`
- **THEN** the Ear SHALL open a new capture session under `continuous` mode without waiting for a wake-word
- **AND** the Ear SHALL play the `ack_continue` cue
- **AND** the Ear SHALL emit `session_start` with `mode: "continuous"`

### Requirement: Wire encoding

All control events SHALL travel as socket.io events over a WebSocket transport (no long-polling fallback). socket.io text packets SHALL carry the per-event JSON payload; the `audio_frame` event SHALL ship the PCM/OPUS buffer as a socket.io binary attachment alongside the `sessionId` text arg. No additional framing header is required; the Ear and Core SHALL NOT layer custom binary headers on top of socket.io's transport.

#### Scenario: Binary attachment routes to the correct session

- **WHEN** Core receives an `audio_frame` event with `sessionId = X` and a binary attachment of `N` bytes
- **THEN** Core SHALL forward the `N`-byte buffer to the Deepgram session bound to `sessionId = X`
- **AND** SHALL drop the buffer if no active session matches

## REMOVED Requirements

### Requirement: Raw WebSocket framing (`binary-frame.ts` + 8-byte sessionShortId header)

**Reason**: Replaced by socket.io's transport. socket.io's binary attachments carry the audio buffer; the `sessionId` arrives as the first text arg of the `audio_frame` event. There is no longer a need for a 64-bit `sessionShortIdFromUuid` shortcut or the 8-byte little-endian header.

**Migration**: Delete `packages/ear-protocol/src/binary-frame.ts` and all references to `encodeAudioFrame`, `decodeAudioFrame`, `sessionShortIdFromUuid` on both sides. Replace audio dispatch with `socket.emit("audio_frame", sessionId, buffer)` on the Ear and a `@SubscribeMessage("audio_frame")` handler whose signature is `(sessionId: string, buffer: Buffer)` on Core. Swift mirror: drop `AudioFrame.encode/decode/headerSize/sessionShortId`.
