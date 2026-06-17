## MODIFIED Requirements

### Requirement: Long-note mode silence cap and termination

A session opened under `long_note` mode (Ear sent `session_start` with `mode: "long_note"`) SHALL run with a ~60 second silence cap measured from the last partial OR final transcript, and with the per-session VAD-driven `core:vad` termination suppressed. The Core-side silence cap, the Ear-side safety cap, and the `tool-driven-ear-sessions` owner safety cap together act as backstops.

A new termination initiator label `core:tool_release` SHALL be used when an owned session is terminated because the owning sub-agent returned a `{ release: true }` tool result. The earlier `core:long_note_end` label is retired (no notes-domain tool terminates the session by name any more — termination flows through `tool-driven-ear-sessions`).

The `notes` domain SHALL expose a `begin_dictation` tool that, instead of mutating the active regular session, calls `EarSessionRouter.arm({ ownerSpec: notesAgentSpec, mode: "long_note" })`, which dispatches `arm_capture` to the connected Ear so a fresh long-note session is opened and bound to the notes sub-agent. The original short utterance terminates normally via its own VAD / silence cap.

Core's Deepgram-final fanout SHALL consult `EarSessionRouter.ownerOf(sessionId)` for every final and every Ear-initiated `session_end`. When an owner is present, the final SHALL be delivered to the owning sub-agent runner instead of the post-endpoint `handleTurn` path.

#### Scenario: long-note session uses the relaxed cap from start

- **WHEN** the Ear sends `session_start` with `mode: "long_note"`
- **THEN** Core SHALL set the session's silence cap to ~60 seconds
- **AND** Core SHALL suppress the per-session VAD-driven `core:vad` termination for the lifetime of the session

#### Scenario: long-note end via owning sub-agent

- **WHEN** the notes sub-agent calls `finalize_note(cleanText)` on an active long-note session
- **THEN** Core SHALL terminate the session with reason `endpoint` and initiator `core:tool_release`
- **AND** Core SHALL send the standard endpoint cue and `session_end` to the Ear

#### Scenario: Finals on owned sessions skip handleTurn

- **WHEN** Deepgram delivers a `final_transcript` for a session bound to an owner in `EarSessionRouter`
- **THEN** Core SHALL forward the final to the owning sub-agent runner
- **AND** Core SHALL NOT invoke the post-endpoint `handleTurn` flow for that final
