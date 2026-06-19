## MODIFIED Requirements

### Requirement: Message catalog — Ear to Core

The protocol SHALL define the following socket.io events emitted by the Ear to Core:

- `register` — fired once per connection immediately after `connect`. Payload `{deviceId (UUID v4), deviceName (string), capabilities (array)}`.
- `wake_detected` — fired whenever the Ear's wake-word detector fires. Payload `{deviceId (UUID v4), score (number, 0..1), timestamp (ISO-8601 string)}`.
- `session_start` — fired to open a capture session. Payload `{deviceId, sessionId (UUID v4), userId (nullable string), sampleRate (positive int), codec (enum: linear16 | opus), mode? (enum: regular | continuous | ask)}`.
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

#### Scenario: `session_start` accepts `mode: "ask"`

- **WHEN** the validator is given a `session_start` payload whose `mode` is `"ask"`
- **THEN** validation SHALL succeed

### Requirement: Message catalog — Core to Ear

The protocol SHALL define the following socket.io events emitted by Core to the Ear:

- `ack` — response to `register`. Payload `{deviceId}`.
- `wake_ack` — response to `wake_detected`. Payload `{action (enum: proceed | yield)}`.
- `partial_transcript` — interim STT result. Payload `{sessionId, text (string), isFinal: false}`.
- `final_transcript` — terminal STT result. Payload `{sessionId, text (string)}`.
- `overlay_update` — drives the interactive overlay. Payload `{seq (positive int, monotonic per device per connection), state: { kind, hint?, caption?, sound? }}`. The `state.kind` field SHALL be one of `idle`, `listening`, `capturing`, `thinking`, `processing`, `success`, `error`, `view`. The `state.sound` field, when present, SHALL be one of `endpoint`, `error`, `ack_done`, `ack_continue`, `ack_thinking`, `ack_success`, `ack_error`, `ack_unknown`, `cue_listen` (the `wake` cue is local-only and never appears here).
- `list_view_update` — drives a generic list-view surface. Payload `{seq (positive int, monotonic per device per connection on its own channel), view: { title?, items: [{id, label, done}], open }}`. The Ear renders the `items` array verbatim; `done` items render struck-through.
- `session_mode` — forward-compat mode hint for an active session. Payload `{sessionId, mode}`.
- `arm_capture` — backend-initiated capture trigger. Payload `{mode (enum: regular | continuous | ask), captureMs? (positive int)}`. When `mode` is `"ask"` the Ear SHALL open a single-final ask session and the `captureMs` value, if present, SHALL bound the session locally as a safety cap.
- `session_end` — Core-initiated end of session. Payload `{sessionId, reason (enum: endpoint | timeout | stt_error | user), detail? (string)}`.

`wake_ack.action` SHALL be `proceed` in the MVP; the `yield` value exists in the enum so a future coordination change can use it without renegotiation.

Every `overlay_update` SHALL carry a complete state record; there is no patch form. The `seq` on `overlay_update` and `list_view_update` is independent per channel: each SHALL maintain its own per-device monotonic counter starting at `1`. Both SHALL allow the Ear to drop out-of-order delivery within their own channel (last-writer-wins).

The Swift decoder SHALL tolerate unknown `state.kind`, `state.sound`, `arm_capture.mode`, and `session_mode.mode` values by surfacing them as `.unknown*` rather than disconnecting.

#### Scenario: `wake_ack` accepts the reserved `yield` action

- **WHEN** the validator is given `{ "type": "wake_ack", "action": "yield" }`
- **THEN** validation SHALL succeed
- **AND** Core MVP code SHALL never emit `yield`

#### Scenario: `overlay_update` accepts every kind including `view`

- **WHEN** the validator is given an `overlay_update` whose `state.kind` is any of `idle`, `listening`, `capturing`, `thinking`, `processing`, `success`, `error`, `view`
- **THEN** validation SHALL succeed

#### Scenario: `overlay_update.state.sound` rejects `wake`

- **WHEN** the validator is given an `overlay_update` with `state.sound: "wake"`
- **THEN** validation SHALL fail; `wake` is a local-Ear cue and never flows over the wire in `overlay_update`

#### Scenario: `overlay_update.state.sound` accepts `cue_listen`

- **WHEN** the validator is given an `overlay_update` with `state.sound: "cue_listen"`
- **THEN** validation SHALL succeed; the cue is played by the Ear when entering an ask-session listening state

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

#### Scenario: `arm_capture` opens an ask session with a cap

- **WHEN** the Ear receives `{ "type": "arm_capture", "mode": "ask", "captureMs": 8000 }`
- **THEN** the Ear SHALL open a new capture session under `ask` mode without waiting for a wake-word
- **AND** the Ear SHALL play the `cue_listen` cue locally
- **AND** the Ear SHALL send `session_start` carrying `mode: "ask"`
- **AND** the local safety cap SHALL terminate the session with `session_end` reason `timeout` after 8 000 ms if no `session_end` from Core arrives first

## ADDED Requirements

### Requirement: Ask session mode

The protocol SHALL define a third session `mode` — `ask` — used by Core to gather a single user reply on behalf of a domain (e.g. asking for a note name before opening a long-note session). An ask-session SHALL:

- Be opened only by Core via `arm_capture { mode: "ask", captureMs? }`. The Ear SHALL NOT spontaneously enter ask-mode in response to a wake event.
- Carry `mode: "ask"` in its `session_start`.
- Terminate with `session_end` reason `endpoint` as soon as Core receives the first `final_transcript`. Core SHALL NOT wait for additional finals on an ask-session.
- Terminate locally with `session_end` reason `timeout` if the `captureMs` cap elapses on the Ear before Core ends the session.
- Terminate locally with `session_end` reason `user` if the user taps the status item during the ask-session.

Ask-mode is orthogonal to wake. The Ear's wake-word detector SHALL remain suppressed for the duration of an ask-session exactly as it is during `regular`/`continuous` sessions (one session at a time per Ear). VAD SHALL run normally and MAY end the session early via `session_end` reason `vad`; Core SHALL treat a `vad`-ended ask-session as `cancelled`.

#### Scenario: First final ends the ask-session

- **WHEN** Core opens an ask-session and Deepgram emits a `final_transcript` for that sessionId
- **THEN** Core SHALL emit `session_end` reason `endpoint`
- **AND** the final SHALL be delivered to the kernel handle that opened the ask-session, NOT to `handleTurn`

#### Scenario: Capture cap fires on silence

- **WHEN** an ask-session is opened with `captureMs: 8000` and no `final_transcript` is received within 8 000 ms on either side
- **THEN** the Ear SHALL emit `session_end` reason `timeout`
- **AND** Core SHALL surface this as a `timeout` outcome to the kernel handle

#### Scenario: User taps to cancel ask

- **WHEN** an ask-session is active and the user taps the menu-bar status item
- **THEN** the Ear SHALL emit `session_end` reason `user`
- **AND** Core SHALL surface this as a `cancelled` outcome to the kernel handle
