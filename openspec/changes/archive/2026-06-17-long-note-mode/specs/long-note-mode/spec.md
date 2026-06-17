## ADDED Requirements

### Requirement: Long-note session mode

The system SHALL support a session mode `long_note` distinct from the default `regular` mode. Each session is created under exactly one mode at start and SHALL NOT transition modes mid-session. A wake-word event always opens a `regular` session. Long-note sessions are opened by Core via the `arm_capture` message after the original short utterance has closed and an LLM-decided tool fires.

Detailed contracts (exact silence cap milliseconds, exact safety cap milliseconds, exact LLM prompts, idempotency keys) are intentionally left to implementation. The values below are anchors; implementation MAY tighten them but SHALL preserve their relative ordering and intent.

#### Scenario: Wake opens a regular session

- **WHEN** a wake event fires on the Ear
- **THEN** the Ear SHALL send `session_start` with `mode: "regular"` (or no mode field for backward compatibility)
- **AND** Core SHALL treat the session as `regular` with the default silence cap and VAD endpoint behaviour

#### Scenario: Long-note session is opened by Core via arm_capture

- **WHEN** the `enable_long_note_mode` tool runs successfully (because the supervisor decided the user wants to dictate a long note)
- **THEN** Core SHALL send an `arm_capture` message to the connected Ear with `mode: "long_note"`
- **AND** the Ear SHALL play the `ack_continue` cue (Submarine)
- **AND** the Ear SHALL open a FRESH capture session under `long_note` mode (no wake event required)
- **AND** the new session's `session_start` SHALL carry `mode: "long_note"` so Core arms the right cap and suppresses Core-side VAD endpoint from the start

#### Scenario: Mode is immutable per session

- **WHEN** a long-note session is in progress
- **THEN** no tool, no message, and no transcript content SHALL transition the session back to `regular` mode
- **AND** the only valid exits from `long_note` SHALL be termination via `end_long_note_mode`, the long-note safety cap, or an unhandled transport error

### Requirement: In-session LLM hook for intent and stop decisions

Core SHALL host a service (working name `SessionWatcher`) that subscribes to the Deepgram final-transcript stream of every active session. On the FIRST final of a session, the service SHALL invoke a cheap LLM (target: Anthropic Haiku) to decide whether the session is a long-form note. In `long_note` mode, on EVERY new final the service SHALL invoke the same class of LLM to decide whether the user has finished. Both decisions SHALL be expressed via a tool call routed through the orchestration graph by default.

The service SHALL NOT trigger LLM calls on partial transcripts. The service SHALL be idempotent against duplicate finals: re-invoking the intent check after long-note mode is already active SHALL be a no-op at the tool layer.

#### Scenario: First final triggers intent check

- **WHEN** Deepgram delivers the first `final_transcript` for a session in `regular` mode
- **THEN** `SessionWatcher` SHALL invoke the intent classifier with the final's text
- **AND** if the classifier decides long-note, the graph SHALL be invoked so the supervisor can route to `enableLongNoteMode`

#### Scenario: Stop check runs only in long-note

- **WHEN** Deepgram delivers a `final_transcript` for a session in `long_note` mode
- **THEN** `SessionWatcher` SHALL invoke the stop classifier with the rolling concatenation of finals so far
- **AND** if the classifier decides "done", the graph SHALL be invoked so the supervisor can route to `endLongNoteMode` with a cleaned-up text

#### Scenario: Stop check never runs in regular mode

- **WHEN** a session remains in `regular` mode for its entire lifetime
- **THEN** `SessionWatcher` SHALL NOT invoke the stop classifier
- **AND** any save action SHALL come from the existing post-endpoint `handleTurn` flow

### Requirement: Notes domain tools

The notes domain (created in this change, since `llm-orchestration-mvp` shipped only `memory`) SHALL expose three tools to the supervisor:

- `save_short_note(text)`: persist a short note in the post-endpoint flow. Side effect: writes to disk under `output/notes/`. Returned cue: `ack_done`.
- `enable_long_note_mode()`: arm the Ear to open a fresh capture session under `long_note` mode by sending the `arm_capture` message. Returns success/failure of the arm dispatch. The Submarine cue is played by the Ear on receipt of `arm_capture`.
- `end_long_note_mode(cleanText)`: persist the long note and terminate the active long-note session with reason `endpoint` and initiator `core:long_note_end`. The Ear plays the standard endpoint cue.

Persistence path SHALL be `output/notes/YYYY-MM-DD_HH-mm-ss.md` with one file per note. The directory SHALL be created lazily on first save and SHALL be excluded from version control.

#### Scenario: Short-note path

- **WHEN** the supervisor routes a short utterance through `saveShortNote`
- **THEN** a file SHALL be written under `output/notes/`
- **AND** the Ear SHALL play the `ack_done` cue

#### Scenario: Long-note enable is idempotent

- **WHEN** `enableLongNoteMode` is invoked for a session already in `long_note` mode
- **THEN** the tool SHALL succeed without re-mutating the silence cap
- **AND** the tool SHALL NOT emit a second `ack_continue` cue

#### Scenario: Long-note end persists and terminates

- **WHEN** `endLongNoteMode(cleanText)` runs for an active long-note session
- **THEN** a file containing `cleanText` SHALL be written under `output/notes/`
- **AND** the session SHALL terminate with reason `endpoint`
- **AND** the Ear SHALL play the standard endpoint cue

### Requirement: Long-note safety cap

A session in `long_note` mode SHALL terminate after a configurable hard cap (target: ~60s) measured from the last partial OR final transcript, regardless of whether the stop classifier ever returns "done". This SHALL be enforced by BOTH the Ear safety timer and the Core silence cap; either firing SHALL end the session.

#### Scenario: Hard cap fires on stuck classifier

- **WHEN** the long-note stop classifier returns "not done" continuously and no transcript arrives for the configured cap duration
- **THEN** the session SHALL terminate with reason `timeout` or `endpoint` depending on which side fired first
- **AND** whatever transcript was accumulated SHALL be saved as a note via `endLongNoteMode` if reachable, or by a fallback persister at termination time

### Requirement: In-session graph invocation pattern

The orchestration graph SHALL support being invoked mid-session by `SessionWatcher`, in addition to the post-endpoint `handleTurn` entry point established by `llm-orchestration-mvp`. The graph SHALL be agnostic to which entry point fired; the distinction SHALL be encoded in the inputs supplied (e.g., a hint flag), not in the graph topology.

The default tool path for in-session invocations SHALL be the same supervisor-routed path used by post-endpoint turns. A direct-path alternative (`SessionWatcher` invoking a tool handler via dependency injection, bypassing the supervisor) SHALL be documented as a future option for when supervisor-routed latency becomes user-visible, but SHALL NOT be implemented in this change.

#### Scenario: SessionWatcher invokes the graph mid-session

- **WHEN** `SessionWatcher` decides to run an LLM check (intent or stop) on an active session
- **THEN** it SHALL invoke the same compiled graph used by `handleTurn`
- **AND** it SHALL serialise per-session invocations to avoid concurrent graph executions for the same session

#### Scenario: Direct-path alternative is documented but not wired

- **WHEN** an implementer examines the change's design.md
- **THEN** the document SHALL describe the direct-path alternative and the condition under which it would be revisited
- **AND** no code in this change SHALL invoke notes-domain tools outside the graph
