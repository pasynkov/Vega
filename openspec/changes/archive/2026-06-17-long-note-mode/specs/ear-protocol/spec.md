## MODIFIED Requirements

### Requirement: Message catalog — Core to Ear

The protocol SHALL define the following message types sent from Core to Ear:

- `ack`: response to `register`. Fields: `type`, `deviceId`.
- `wake_ack`: response to `wake_detected`. Fields: `type`, `action` (enum: `proceed`, `yield`).
- `partial_transcript`: interim STT result. Fields: `type`, `sessionId`, `text` (string), `isFinal` (boolean, always `false`).
- `final_transcript`: terminal STT result. Fields: `type`, `sessionId`, `text` (string).
- `play_cue`: instructs the Ear to play an audible cue. Fields: `type`, `cue` (enum: `wake`, `endpoint`, `error`, `ack_done`, `ack_continue`, `ack_thinking`, `ack_success`, `ack_error`).
- `session_mode`: signals a mode hint for the active session. Fields: `type`, `sessionId`, `mode` (enum: `regular`, `long_note`). Reserved for forward-compat; the MVP does not use it (mode is now set per-session at `session_start`).
- `arm_capture`: backend-initiated capture trigger. Fields: `type`, `mode` (enum: `regular`, `long_note`). On receipt the Ear opens a fresh capture session with the requested mode without requiring a wake-word, plays the mode-appropriate cue, and sends its normal `session_start` carrying the same `mode` field.
- `session_end`: Core-initiated end of session. Fields: `type`, `sessionId`, `reason` (enum: `endpoint`, `timeout`, `stt_error`, `user`), `detail` (optional string).

`wake_ack.action` SHALL be `proceed` in the MVP; the `yield` value exists in the enum so a future coordination change can use it without renegotiation.

The expanded `cue` enum is additive: the existing values (`wake`, `endpoint`, `error`) retain their MVP semantics. The new values (`ack_done`, `ack_continue`, `ack_thinking`, `ack_success`, `ack_error`) are present so future changes can wire them without re-bumping the schema. Only `ack_done` and `ack_continue` SHALL have handler wiring in this change; the remaining values SHALL be valid for protocol purposes but emitting them is reserved for future work.

The Swift decoder of the protocol SHALL tolerate unknown `cue` enum values from a newer Core build by ignoring the play instruction rather than aborting the connection. This is a forward-compatibility shim — once an Ear build knows about every emitted cue, the tolerance is harmless.

#### Scenario: `wake_ack` accepts the reserved `yield` action

- **WHEN** the validator is given `{ "type": "wake_ack", "action": "yield" }`
- **THEN** validation SHALL succeed
- **AND** Core MVP code SHALL never emit `yield`

#### Scenario: `play_cue` accepts every ack value

- **WHEN** the validator is given a `play_cue` message whose `cue` field is any of `ack_done`, `ack_continue`, `ack_thinking`, `ack_success`, or `ack_error`
- **THEN** validation SHALL succeed
- **AND** an Ear without a handler for the value SHALL ignore the cue without raising an error

#### Scenario: `session_mode` validates and is forwards-compatible

- **WHEN** the validator is given `{ "type": "session_mode", "sessionId": "...", "mode": "long_note" }`
- **THEN** validation SHALL succeed
- **AND** an Ear that lacks knowledge of the message SHALL log it at debug level and ignore it without breaking the session
