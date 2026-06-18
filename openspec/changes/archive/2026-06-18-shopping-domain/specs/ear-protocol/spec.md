## MODIFIED Requirements

### Requirement: Message catalog — Core to Ear

The protocol SHALL define the following message types sent from Core to Ear:

- `ack`: response to `register`. Fields: `type`, `deviceId`.
- `wake_ack`: response to `wake_detected`. Fields: `type`, `action` (enum: `proceed`, `yield`).
- `partial_transcript`: interim STT result. Fields: `type`, `sessionId`, `text` (string), `isFinal` (boolean, always `false`).
- `final_transcript`: terminal STT result. Fields: `type`, `sessionId`, `text` (string).
- `overlay_update`: drives the interactive overlay (visual state + optional cue sound). Fields: `type`, `seq` (integer, monotonic per device, starting at `1` per connection), `state` (object: `{ kind, hint?, caption?, sound? }`). Replaces the removed `play_cue` message. The `state.kind` field SHALL be one of `idle`, `listening`, `capturing`, `thinking`, `processing`, `success`, `error`, `view`. The `state.sound` field, when present, SHALL be one of the cue identifiers `endpoint`, `error`, `ack_done`, `ack_continue`, `ack_thinking`, `ack_success`, `ack_error`, `ack_unknown` (the `wake` cue is local-only and never appears in `state.sound`).
- `list_view_update`: drives a generic list-view surface rendered below the orb. Fields: `type`, `seq` (integer, monotonic per device, starting at `1` per connection), `view` (object: `{ title?, items, open }`). `items` SHALL be an array of `{ id (string), label (string), done (boolean) }`. `open` SHALL be a boolean — `true` opens (or refreshes) the surface, `false` collapses it. The Ear SHALL render the `items` array verbatim; `done` items SHALL be rendered struck-through; an empty `items` array MAY be rendered as a placeholder (e.g. "(пусто)").
- `session_mode`: forward-compat mode hint for an active session. Fields: `type`, `sessionId`, `mode` (enum: `regular`, `continuous`). Reserved; the MVP does not emit it (mode is set per-session at `session_start`).
- `arm_capture`: backend-initiated capture trigger. Fields: `type`, `mode` (enum: `regular`, `continuous`). Instructs the Ear to open a fresh capture session under the given mode without a wake-word.
- `session_end`: Core-initiated end of session. Fields: `type`, `sessionId`, `reason` (enum: `endpoint`, `timeout`, `stt_error`, `user`), `detail` (optional string).

`wake_ack.action` SHALL be `proceed` in the MVP; the `yield` value exists in the enum so a future coordination change can use it without renegotiation.

Every `overlay_update` SHALL carry a complete state record; there is no patch form. Omitted optional fields (`hint`, `caption`, `sound`) SHALL be treated as cleared. The `seq` field on `overlay_update` and `list_view_update` is independent per channel: each SHALL maintain its own per-device monotonic counter starting at `1`. Both SHALL allow the Ear to drop out-of-order delivery within their own channel (last-writer-wins).

Every `list_view_update` SHALL carry a complete snapshot of `items`; there is no patch form. The Ear SHALL replace its rendered list with the array verbatim on every update.

The Swift decoder SHALL tolerate unknown `state.kind`, `state.sound`, `arm_capture.mode`, and `session_mode.mode` values by surfacing them as `.unknown*` rather than aborting the WebSocket connection.

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
