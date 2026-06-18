## MODIFIED Requirements

### Requirement: Message catalog — Core to Ear

The protocol SHALL define the following message types sent from Core to Ear:

- `ack`: response to `register`. Fields: `type`, `deviceId`.
- `wake_ack`: response to `wake_detected`. Fields: `type`, `action` (enum: `proceed`, `yield`).
- `partial_transcript`: interim STT result. Fields: `type`, `sessionId`, `text` (string), `isFinal` (boolean, always `false`).
- `final_transcript`: terminal STT result. Fields: `type`, `sessionId`, `text` (string).
- `overlay_update`: drives the interactive overlay (visual state + optional cue sound). Fields: `type`, `seq` (integer, monotonic per device, starting at `1` per connection), `state` (object: `{ kind, hint?, caption?, sound? }`). Replaces the deprecated `play_cue`. The `state.kind` field SHALL be one of `idle`, `listening`, `capturing`, `thinking`, `processing`, `success`, `error`. The `state.sound` field, when present, SHALL be one of the cue identifiers `endpoint`, `error`, `ack_done`, `ack_continue`, `ack_thinking`, `ack_success`, `ack_error`, `ack_unknown` (the `wake` cue is local-only and never appears in `state.sound`).
- `session_mode`: forward-compat mode hint for an active session. Fields: `type`, `sessionId`, `mode` (enum: `regular`, `continuous`). Reserved; the MVP does not emit it (mode is set per-session at `session_start`).
- `arm_capture`: backend-initiated capture trigger. Fields: `type`, `mode` (enum: `regular`, `continuous`). Instructs the Ear to open a fresh capture session under the given mode without a wake-word.
- `session_end`: Core-initiated end of session. Fields: `type`, `sessionId`, `reason` (enum: `endpoint`, `timeout`, `stt_error`, `user`), `detail` (optional string).

`wake_ack.action` SHALL be `proceed` in the MVP; the `yield` value exists in the enum so a future coordination change can use it without renegotiation.

Every `overlay_update` SHALL carry a complete state record; there is no patch form. Omitted optional fields (`hint`, `caption`, `sound`) SHALL be treated as cleared. The `seq` field is strictly monotonic per device per connection and SHALL allow the Ear to drop any out-of-order delivery (last-writer-wins).

The Swift decoder SHALL tolerate unknown `state.kind`, `state.sound`, `arm_capture.mode`, and `session_mode.mode` values by surfacing them as `.unknown*` rather than aborting the WebSocket connection.

#### Scenario: `wake_ack` accepts the reserved `yield` action

- **WHEN** the validator is given `{ "type": "wake_ack", "action": "yield" }`
- **THEN** validation SHALL succeed
- **AND** Core MVP code SHALL never emit `yield`

#### Scenario: `overlay_update` accepts every kind

- **WHEN** the validator is given an `overlay_update` whose `state.kind` is any of `idle`, `listening`, `capturing`, `thinking`, `processing`, `success`, `error`
- **THEN** validation SHALL succeed

#### Scenario: `overlay_update.state.sound` rejects `wake`

- **WHEN** the validator is given an `overlay_update` with `state.sound: "wake"`
- **THEN** validation SHALL fail; `wake` is a local-Ear cue and never flows over the wire in `overlay_update`

#### Scenario: `arm_capture` opens a fresh session

- **WHEN** the Ear receives `{ "type": "arm_capture", "mode": "continuous" }`
- **THEN** the Ear SHALL open a new capture session under `continuous` mode without waiting for a wake-word
- **AND** the Ear SHALL play the `ack_continue` cue
- **AND** the Ear SHALL send `session_start` carrying `mode: "continuous"`

## REMOVED Requirements

### Requirement: `play_cue` message type (formerly part of "Message catalog — Core to Ear")

**Reason**: Replaced by `overlay_update`, which carries the cue inside `state.sound` together with the visual overlay state. Splitting cue and visual produced double-bookkeeping in domain code and a race window on the wire; collapsing them into one atomic message fixes both. The Ear continues to play `wake` and `ack_continue` locally (wake-word detection and `arm_capture` respectively); every other cue now arrives via `overlay_update`.

**Migration**: Replace any `{ type: "play_cue", cue: <C> }` Core emit site with an `OverlayService` call carrying `sound: <C>` (and an appropriate overlay state). Delete the `PlayCueMessage` schema entry, the `play_cue` branch in the Ear-side message handler, and any tests asserting on `play_cue` payloads. Domains MUST NOT introduce new emitters that bypass `OverlayService`.
