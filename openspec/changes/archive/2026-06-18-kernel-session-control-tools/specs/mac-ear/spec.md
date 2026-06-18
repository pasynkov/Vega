## MODIFIED Requirements

### Requirement: Long-note mode handling

The Ear SHALL recognise a per-session `mode` field on `session_start` and a Core-initiated `arm_capture` message. The two modes are `regular` (default; existing behaviour) and `continuous` (no-VAD-endpoint, ~60-second silence cap, used for any long-running dictation or capture flow).

When in `continuous` mode the Ear SHALL:
- Suppress the local VAD endpoint decision (the detector keeps running for logs but never fires `session_end` of reason `vad`).
- Reschedule its safety capture cap to ~60 seconds, reset on every incoming partial or final transcript event.
- Play the `ack_continue` cue (Submarine) when the mode is entered via `arm_capture`.

When the Ear receives `arm_capture` it SHALL open a fresh capture session under the requested mode without requiring a wake-word, and SHALL emit a `session_start` carrying the same `mode` field.

#### Scenario: arm_capture opens a fresh continuous session

- **WHEN** the Ear receives `{ "type": "arm_capture", "mode": "continuous" }` and no session is active
- **THEN** the Ear SHALL allocate a new sessionId, play `ack_continue`, and send `session_start` with `mode: "continuous"`
- **AND** the new session SHALL run with the VAD endpoint suppressed and a ~60 second safety cap

#### Scenario: continuous session ends by Core endpoint, not local VAD

- **WHEN** the user finishes dictating and Core sends `session_end` of reason `endpoint`
- **THEN** the Ear SHALL play the endpoint cue and return to `idle`
- **AND** the local VAD SHALL NOT have fired during the continuous session
