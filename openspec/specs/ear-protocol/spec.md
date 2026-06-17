# ear-protocol Specification

## Purpose

Defines the WebSocket message contract between any Vega Ear client (Mac menu-bar app, future Pi/iOS edges) and Vega Core. The schema lives in a single source-of-truth package consumed by both sides so wire compatibility is enforced at build time rather than discovered at runtime.

## Requirements

### Requirement: Shared WebSocket message schema

The repository SHALL define a single source of truth for the Ear ↔ Core message schema in `packages/ear-protocol/`. The package SHALL export TypeScript types and runtime validators (Zod or equivalent) consumed by Core. The package SHALL also produce a Swift mirror — Codable structs with matching field names — consumed by Mac Ear.

The TypeScript and Swift representations of every message SHALL agree on field names, types, and required-vs-optional designation. A test in the package SHALL verify that an example payload of each message type round-trips through both representations identically.

#### Scenario: TypeScript and Swift agree on message shapes

- **WHEN** the package's round-trip test suite runs
- **THEN** every message type defined in the schema SHALL have at least one example payload
- **AND** that payload SHALL parse and re-serialize identically through both the TypeScript validator and the Swift Codable decoder

### Requirement: Message catalog — Ear to Core

The protocol SHALL define the following message types sent from Ear to Core:

- `register`: sent once per WebSocket connection immediately after open. Fields: `type`, `deviceId` (string, UUID v4), `deviceName` (string), `capabilities` (string array; subset of `mic`, `wake`, `speaker`, `display`).
- `wake_detected`: sent whenever the Ear's wake-word detector fires. Fields: `type`, `deviceId`, `score` (number, 0..1), `timestamp` (ISO-8601 string).
- `session_start`: sent to open a capture session. Fields: `type`, `deviceId`, `sessionId` (string, UUID v4), `userId` (nullable string), `sampleRate` (integer, e.g. `48000`), `codec` (enum: `linear16`, `opus`).
- `audio_frame`: sent repeatedly during a session. Fields: `type`, `sessionId`, `data` (binary). For `linear16` the payload is little-endian signed 16-bit PCM samples; for `opus` the payload is a single OPUS packet.
- `session_end`: sent when the Ear decides to terminate the session locally. Fields: `type`, `sessionId`, `reason` (enum: `user`, `timeout`, `vad`).

The `userId` field SHALL be present in every `session_start` even though it is always `null` in the MVP. Removing or renaming `userId` later is a breaking change to the protocol.

#### Scenario: `register` validates a well-formed example

- **WHEN** the validator is given `{ "type": "register", "deviceId": "<uuid>", "deviceName": "MacBook Pro", "capabilities": ["mic","wake","speaker"] }`
- **THEN** validation SHALL succeed

#### Scenario: `session_start` requires `userId`

- **WHEN** the validator is given a `session_start` payload missing the `userId` field
- **THEN** validation SHALL fail with an error identifying the missing field

### Requirement: Message catalog — Core to Ear

The protocol SHALL define the following message types sent from Core to Ear:

- `ack`: response to `register`. Fields: `type`, `deviceId`.
- `wake_ack`: response to `wake_detected`. Fields: `type`, `action` (enum: `proceed`, `yield`).
- `partial_transcript`: interim STT result. Fields: `type`, `sessionId`, `text` (string), `isFinal` (boolean, always `false`).
- `final_transcript`: terminal STT result. Fields: `type`, `sessionId`, `text` (string).
- `play_cue`: instructs the Ear to play an audible cue. Fields: `type`, `cue` (enum: `wake`, `endpoint`, `error`).
- `session_end`: Core-initiated end of session. Fields: `type`, `sessionId`, `reason` (enum: `endpoint`, `timeout`, `stt_error`, `user`), `detail` (optional string).

`wake_ack.action` SHALL be `proceed` in the MVP; the `yield` value exists in the enum so a future coordination change can use it without renegotiation.

#### Scenario: `wake_ack` accepts the reserved `yield` action

- **WHEN** the validator is given `{ "type": "wake_ack", "action": "yield" }`
- **THEN** validation SHALL succeed
- **AND** Core MVP code SHALL never emit `yield`

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

All control messages (anything other than `audio_frame`) SHALL be sent as UTF-8 JSON text frames. `audio_frame` SHALL be sent as binary frames whose payload is preceded by an 8-byte little-endian unsigned integer header containing the `sessionId` short identifier as defined by the protocol package. For `linear16` sessions the remainder of the binary frame is raw PCM samples; for `opus` sessions it is a single OPUS packet.

#### Scenario: Binary frame routes by header

- **WHEN** Core receives a binary WebSocket frame
- **THEN** Core SHALL extract the 8-byte header to determine the `sessionId`
- **AND** SHALL forward the remainder to the Deepgram connection bound to that session
- **AND** SHALL drop the frame if no active session matches
