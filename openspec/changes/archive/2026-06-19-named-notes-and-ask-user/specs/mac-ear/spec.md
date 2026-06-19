## ADDED Requirements

### Requirement: Ask-mode session handling

The Mac Ear SHALL handle Core-initiated ask-sessions in addition to `regular` and `continuous`. An ask-session SHALL be entered only via `arm_capture { mode: "ask", captureMs? }`. The Ear SHALL NOT enter ask-mode in response to a wake event.

When an ask-session is entered the Ear SHALL:

- Allocate a fresh `sessionId` and send `session_start` carrying `mode: "ask"`.
- Play the `cue_listen` cue locally on entry (no waiting for Core).
- Capture audio with the same PCM pipeline as `regular`/`continuous` sessions.
- Suppress its local silence-based endpoint (no `session_end` reason `vad` SHALL be emitted during an ask-session) so a brief one-word answer is not cut by adaptive VAD.
- Run a local safety cap matching the `captureMs` value from `arm_capture` (default `8000` ms when absent). When the cap fires the Ear SHALL emit `session_end` reason `timeout` and SHALL play the endpoint cue.
- Treat a user tap on the status item as cancellation: emit `session_end` reason `user`, stop capturing, and play the endpoint cue.
- Honour Core's `session_end` reason `endpoint` as the normal completion path (first STT final arrived on Core's side); the Ear SHALL stop capturing and return to `idle`.

The overlay surface during an ask-session SHALL be driven by Core's `overlay_update` messages (Core will set `{ kind: "listening", caption: <question>, hint: <hint>, sound: "cue_listen" }` before arming and `{ kind: "idle" }` after the session resolves). The Ear SHALL render the caption verbatim under the orb as it already does for any other overlay update.

#### Scenario: arm_capture opens a fresh ask-session

- **WHEN** the Ear receives `{ "type": "arm_capture", "mode": "ask", "captureMs": 8000 }` and no session is active
- **THEN** the Ear SHALL allocate a new sessionId, play `cue_listen`, and send `session_start` with `mode: "ask"`
- **AND** the new session SHALL run with the local VAD endpoint suppressed and an 8 000 ms safety cap

#### Scenario: ask-session ends by Core endpoint after first final

- **WHEN** the user speaks "идея проекта" and Core sends `session_end` of reason `endpoint`
- **THEN** the Ear SHALL play the endpoint cue and return to `idle`
- **AND** the local VAD SHALL NOT have fired during the ask-session

#### Scenario: ask-session times out without an answer

- **WHEN** an ask-session is opened with `captureMs: 8000` and no `session_end` arrives from Core within 8 000 ms
- **THEN** the Ear SHALL emit `session_end` reason `timeout` locally
- **AND** SHALL play the endpoint cue and return to `idle`

#### Scenario: user cancels ask-session via tap

- **WHEN** an ask-session is active and the user clicks the menu-bar status item
- **THEN** the Ear SHALL emit `session_end` reason `user`
- **AND** SHALL play the endpoint cue and return to `idle`

### Requirement: arm_capture decoder accepts the ask mode

The Ear's Codable decoding of `arm_capture` SHALL accept the `mode` value `"ask"` and decode an optional `captureMs` integer alongside it. An unknown mode value SHALL still surface as `.unknown` per the existing tolerance requirement.

#### Scenario: arm_capture ask decodes with captureMs

- **WHEN** the Ear receives `{ "type": "arm_capture", "mode": "ask", "captureMs": 8000 }`
- **THEN** Codable decoding SHALL succeed
- **AND** the resulting in-memory value SHALL expose `mode = .ask` and `captureMs = 8000`

#### Scenario: arm_capture ask decodes without captureMs

- **WHEN** the Ear receives `{ "type": "arm_capture", "mode": "ask" }`
- **THEN** Codable decoding SHALL succeed
- **AND** the resulting `captureMs` SHALL be `nil`, falling back to the documented 8 000 ms default at runtime
