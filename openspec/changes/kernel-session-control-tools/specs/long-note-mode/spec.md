## MODIFIED Requirements

### Requirement: Long-note session mode

The system SHALL support a session mode `continuous` distinct from the default `regular` mode. Each session is created under exactly one mode at start and SHALL NOT transition modes mid-session. A wake-word event always opens a `regular` session. Continuous sessions are opened by Core via the `arm_capture` message after the original short utterance has closed and an LLM-decided tool fires.

Detailed contracts (exact silence cap milliseconds, exact safety cap milliseconds, exact LLM prompts, idempotency keys) are intentionally left to implementation. The values below are anchors; implementation MAY tighten them but SHALL preserve their relative ordering and intent.

NOTE: the capability folder on disk is `openspec/specs/long-note-mode/` for historical reasons (it was introduced before the mode was generalized beyond notes). A future change MAY rename the folder; the requirements inside this file are the source of truth.

#### Scenario: Wake opens a regular session

- **WHEN** a wake event fires on the Ear
- **THEN** the Ear SHALL send `session_start` with `mode: "regular"` (or no mode field for backward compatibility)
- **AND** Core SHALL treat the session as `regular` with the default silence cap and VAD endpoint behaviour

#### Scenario: Continuous session is opened by Core via arm_capture

- **WHEN** the `open_continuous_session` tool runs successfully (because the owning domain — notes in the MVP — decided to open a continuous capture session)
- **THEN** Core SHALL send an `arm_capture` message to the connected Ear with `mode: "continuous"`
- **AND** the Ear SHALL play the `ack_continue` cue (Submarine)
- **AND** the Ear SHALL open a FRESH capture session under `continuous` mode (no wake event required)
- **AND** the new session's `session_start` SHALL carry `mode: "continuous"` so Core arms the right cap and suppresses Core-side VAD endpoint from the start

#### Scenario: Mode is immutable per session

- **WHEN** a continuous session is in progress
- **THEN** no tool, no message, and no transcript content SHALL transition the session back to `regular` mode
- **AND** the only valid exits from `continuous` SHALL be the owning sub-agent returning `{ release: true }` (typically via `finalize_note` or `discard_note` for notes), the Core silence cap, or an unhandled transport error

### Requirement: Notes domain tools

The notes domain SHALL expose the following tools to the orchestration graph and to its own session-bound sub-agent:

- **Supervisor-visible**:
  - `save_short_note(text)`: persist a short note in the post-endpoint flow. Side effect: writes to disk under `output/notes/`. Returned cue: `ack_done`.
  - `open_continuous_session()`: reserve the next Ear session via the kernel-provided `buildOpenContinuousSessionTool` factory, which calls `EarSessionRouter.arm({ ownerSpec: notesAgentSpec, mode: "continuous" })`. Returns the arm dispatch result. The Submarine cue is played by the Ear on receipt of `arm_capture`. The notes domain SHALL NOT call `EarSessionRouter.arm` directly — it MUST go through the kernel factory.

- **Session-bound only (visible to the notes sub-agent inside `runSessionAgent`, NOT to the supervisor)**:
  - `append_text(text)`: append the supplied chunk to the in-progress note file. Idempotent on identical consecutive calls.
  - `finalize_note(cleanText)`: overwrite the in-progress note file with `cleanText`, return `{ release: true, reason: "endpoint" }` so the runner ends the Ear session.
  - `discard_note(reason)`: delete the in-progress note file, return `{ release: true, reason: "user" }`.

Persistence path SHALL remain `output/notes/YYYY-MM-DD_HH-mm-ss.md` with one file per note. The directory SHALL be created lazily on first save and SHALL be excluded from version control.

The in-progress note file SHALL be opened when the first session-bound final is received (not at `open_continuous_session` time) so an aborted reservation does not leave empty files behind.

#### Scenario: Short-note path

- **WHEN** the supervisor routes a short utterance through `save_short_note`
- **THEN** a file SHALL be written under `output/notes/`
- **AND** the Ear SHALL play the `ack_done` cue

#### Scenario: open_continuous_session arms a session

- **WHEN** the supervisor calls `open_continuous_session`
- **THEN** the tool SHALL reserve the next Ear session via the kernel `EarSessionRouter` (going through `buildOpenContinuousSessionTool`)
- **AND** SHALL dispatch `arm_capture` with `mode: "continuous"`
- **AND** SHALL NOT itself open or write any file under `output/notes/`

#### Scenario: Streaming append during dictation

- **WHEN** the notes sub-agent receives a final and decides to keep it
- **THEN** it SHALL call `append_text` with the final's text
- **AND** the in-progress note file SHALL grow by exactly that text plus a separator newline

#### Scenario: Sub-agent finalizes the note

- **WHEN** the notes sub-agent's internal stop check returns "done" for the current final
- **THEN** the sub-agent SHALL call `finalize_note(cleanText)`
- **AND** the in-progress file SHALL be overwritten with `cleanText`
- **AND** the runner SHALL end the Ear session with reason `endpoint` and initiator `core:tool_release`
- **AND** the Ear SHALL play the standard endpoint cue

#### Scenario: Session-bound tool called from supervisor context

- **WHEN** the supervisor or any non-session sub-agent attempts to call `append_text`, `finalize_note`, or `discard_note`
- **THEN** the tool SHALL throw `ToolUsedOutsideSessionError`
- **AND** the error SHALL be surfaced as a tool-call error to the caller

### Requirement: Long-note safety cap

A session in `continuous` mode SHALL terminate after a configurable hard cap measured from the last partial OR final transcript, regardless of whether the owning sub-agent ever decides to release. This Core-side silence cap SHALL be enforced by the existing session pipeline. The Ear-side safety timer remains an independent backstop, and the `tool-driven-ear-sessions` owner safety cap (wall-clock from `session_start`) SHALL act as a third backstop. Any of the three firing SHALL end the session.

When the Core silence cap fires on an owned session, ownership SHALL be force-released and the owning domain's on-cap flush hook SHALL run so whatever transcript was accumulated is saved (the notes domain SHALL save the current in-progress file as-is).

#### Scenario: Hard cap fires on a stuck sub-agent

- **WHEN** the owning sub-agent never returns `{ release: true }` and no transcript arrives for the configured silence cap duration
- **THEN** the session SHALL terminate with reason `timeout` and initiator `core:silence_cap`
- **AND** the in-progress note file SHALL remain on disk with whatever was appended so far
