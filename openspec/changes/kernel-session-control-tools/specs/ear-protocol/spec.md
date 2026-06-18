## MODIFIED Requirements

### Requirement: Message catalog — Core to Ear

The protocol SHALL define the following message types sent from Core to Ear:

- `ack`: response to `register`. Fields: `type`, `deviceId`.
- `wake_ack`: response to `wake_detected`. Fields: `type`, `action` (enum: `proceed`, `yield`).
- `partial_transcript`: interim STT result. Fields: `type`, `sessionId`, `text` (string), `isFinal` (boolean, always `false`).
- `final_transcript`: terminal STT result. Fields: `type`, `sessionId`, `text` (string).
- `play_cue`: instructs the Ear to play an audible cue. Fields: `type`, `cue` (enum: `wake`, `endpoint`, `error`, `ack_done`, `ack_continue`, `ack_thinking`, `ack_success`, `ack_error`).
- `session_mode`: forward-compat mode hint for an active session. Fields: `type`, `sessionId`, `mode` (enum: `regular`, `continuous`). Reserved; the MVP does not emit it (mode is set per-session at `session_start`).
- `arm_capture`: backend-initiated capture trigger. Fields: `type`, `mode` (enum: `regular`, `continuous`). Instructs the Ear to open a fresh capture session under the given mode without a wake-word.
- `session_end`: Core-initiated end of session. Fields: `type`, `sessionId`, `reason` (enum: `endpoint`, `timeout`, `stt_error`, `user`), `detail` (optional string).

`wake_ack.action` SHALL be `proceed` in the MVP; the `yield` value exists in the enum so a future coordination change can use it without renegotiation.

The expanded `cue` enum is additive: `wake`, `endpoint`, and `error` retain their original semantics. Only `ack_done` (Tink) and `ack_continue` (Submarine) have Ear-side handler wiring today; the remaining `ack_*` values are reserved for future tools and SHALL be ignored by Ear builds that do not yet wire them.

The Swift decoder SHALL tolerate unknown `cue` and `session_mode.mode` values by surfacing them as `.unknownCue` / `.unknownSessionMode` rather than aborting the WebSocket connection.

#### Scenario: `wake_ack` accepts the reserved `yield` action

- **WHEN** the validator is given `{ "type": "wake_ack", "action": "yield" }`
- **THEN** validation SHALL succeed
- **AND** Core MVP code SHALL never emit `yield`

#### Scenario: `play_cue` accepts every ack value

- **WHEN** the validator is given a `play_cue` message whose `cue` field is any of `ack_done`, `ack_continue`, `ack_thinking`, `ack_success`, or `ack_error`
- **THEN** validation SHALL succeed
- **AND** an Ear without a handler for the value SHALL ignore the cue without raising an error

#### Scenario: `arm_capture` opens a fresh session

- **WHEN** the Ear receives `{ "type": "arm_capture", "mode": "continuous" }`
- **THEN** the Ear SHALL open a new capture session under `continuous` mode without waiting for a wake-word
- **AND** the Ear SHALL play the `ack_continue` cue
- **AND** the Ear SHALL send `session_start` carrying `mode: "continuous"`
