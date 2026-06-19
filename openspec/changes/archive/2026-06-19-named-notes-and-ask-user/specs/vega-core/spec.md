## ADDED Requirements

### Requirement: Ask-session lifecycle on Core

Core SHALL support a third Ear session mode `ask` for single-final captures driven by the kernel `ask_user` tool. An ask-session is opened by Core via `arm_capture { mode: "ask", captureMs }` and is bound to an in-memory handle owned by the originating `ask_user` tool invocation.

For every ask-session Core SHALL:

- Set the per-session silence cap to `captureMs` (default 8 000 ms when unspecified). The cap SHALL count from session start; partial transcripts SHALL NOT reset it (single-final semantics).
- Suppress the `core:vad` termination path so a short utterance is not cut prematurely.
- Terminate the session with reason `endpoint` and initiator `core:ask_first_final` on the first `final_transcript` from Deepgram.
- Translate Ear-initiated `session_end` reasons during an ask-session: `timeout` → ask outcome `timeout` (initiator `core:ear_timeout`), `user` → ask outcome `cancelled` (initiator `core:ear_user`), `vad` → ask outcome `cancelled` (initiator `core:ear_vad`).
- Deliver the resolved `AskSessionOutcome` (`{ kind: "answer", text } | { kind: "timeout" } | { kind: "cancelled" }`) to the kernel handle exactly once; the ask-session SHALL NOT route any final or session_end to the standard `handleTurn` path.
- Skip persistence to `recordings/` for ask-sessions (the audio is conversational scaffolding, not a captured artefact).

`EarSessionRouter.openAskSession({ deviceId, captureMs })` SHALL be the only entry point that opens an ask-session. It SHALL return a `Promise<AskSessionOutcome>` that resolves when the session ends and rejects only on infrastructure errors (no active device, socket disconnect mid-session).

#### Scenario: First final ends the ask-session and resolves the handle

- **WHEN** Core opens an ask-session for `deviceId = D` with `captureMs = 8000`
- **AND** Deepgram emits a `final_transcript` of text `"идея проекта"` for that sessionId
- **THEN** Core SHALL terminate the session with reason `endpoint` and initiator `core:ask_first_final`
- **AND** the `Promise<AskSessionOutcome>` returned by `openAskSession` SHALL resolve to `{ kind: "answer", text: "идея проекта" }`
- **AND** Core SHALL NOT invoke `handleTurn` for that final

#### Scenario: Ask-session times out without a final

- **WHEN** Core opens an ask-session with `captureMs = 8000`
- **AND** no `final_transcript` arrives within 8 000 ms and the Ear sends `session_end` reason `timeout`
- **THEN** Core SHALL surface initiator `core:ear_timeout`
- **AND** the `Promise<AskSessionOutcome>` SHALL resolve to `{ kind: "timeout" }`

#### Scenario: User cancels ask-session via tap

- **WHEN** Core opens an ask-session and the Ear sends `session_end` reason `user` before any final
- **THEN** Core SHALL surface initiator `core:ear_user`
- **AND** the `Promise<AskSessionOutcome>` SHALL resolve to `{ kind: "cancelled" }`

#### Scenario: Ask-session is not persisted

- **WHEN** an ask-session terminates with any outcome
- **THEN** no `recordings/<ts>/` directory SHALL be created for that sessionId

### Requirement: Notes domain SHALL use a name-aware, continuous-only flow

The notes domain SHALL drive every note through the continuous-session path. The supervisor-level `notes` agent SHALL choose exactly one of two flows per turn:

- **Name in utterance**: when the user's utterance carries an explicit note name (e.g. "запиши длинную заметку про идею проекта" → name `"идея проекта"`), the agent SHALL invoke `open_continuous_session({ name, intent? })` once.
- **Name missing**: when no explicit name can be extracted, the agent SHALL invoke `ask_user({ question: "Как назвать заметку?" })` first. On `{ ok: true, answer }` it SHALL invoke `open_continuous_session({ name: answer, intent? })`. On `{ ok: false, reason: "timeout" | "cancelled" | "no-active-device" }` it SHALL invoke `update_overlay({ kind: "error", hint: "Имя не задано", sound: "ack_error", ttl: 1500 })` and SHALL NOT open a continuous session.

The notes domain SHALL NOT expose a `save_short_note` tool. Short notes are no longer a first-class flow.

`NotesStorageService` SHALL allocate the in-progress file at session open using the schema `<slug(name)>_<timestamp>.md`, where:

- `slug(name)` lowercases the input, collapses runs of whitespace to a single `-`, strips every character outside `[\p{L}\p{N}-]`, trims leading/trailing `-`, and clamps the result to 60 characters. If the result is empty (e.g. name is entirely punctuation), the slug SHALL be `note`.
- `timestamp` is the existing `YYYY-MM-DD_HH-mm-ss` form.

On `finalize_note(cleanText)` the storage layer SHALL overwrite the named file in place; the filename SHALL NOT change between session start and finalize.

#### Scenario: Notes flow with name in utterance

- **WHEN** the user says "запиши длинную заметку про идею проекта"
- **AND** the supervisor routes to `notes`
- **THEN** the notes agent SHALL call `open_continuous_session` exactly once with `name = "идея проекта"`
- **AND** SHALL NOT call `ask_user` on this turn

#### Scenario: Notes flow without name asks for one

- **WHEN** the user says "запиши длинную заметку"
- **AND** the supervisor routes to `notes`
- **THEN** the notes agent SHALL call `ask_user({ question: "Как назвать заметку?" })`
- **AND** on `{ ok: true, answer: "идея проекта" }` SHALL call `open_continuous_session({ name: "идея проекта" })`
- **AND** the resulting in-progress file SHALL be `<dir>/идея-проекта_<ts>.md`

#### Scenario: Ask aborts → notes does not open continuous

- **WHEN** the user says "запиши длинную заметку"
- **AND** `ask_user` returns `{ ok: false, reason: "timeout" }`
- **THEN** the notes agent SHALL NOT call `open_continuous_session`
- **AND** SHALL call `update_overlay` with `{ kind: "error", hint: "Имя не задано", sound: "ack_error", ttl: 1500 }`

#### Scenario: Slug derivation handles edge cases

- **WHEN** `slug` is applied to the inputs `"идея проекта"`, `"!!!"`, and `"a very-long name that exceeds the sixty character clamp easily here"`
- **THEN** the outputs SHALL be `"идея-проекта"`, `"note"`, and a 60-char prefix of the slugified form respectively

## MODIFIED Requirements

### Requirement: Long-note mode silence cap and termination

A session opened under `continuous` mode (Ear sent `session_start` with `mode: "continuous"`) SHALL run with a ~60 second silence cap measured from the last partial OR final transcript, and with the per-session VAD-driven `core:vad` termination suppressed. The Core-side silence cap, the Ear-side safety cap, and the `tool-driven-ear-sessions` owner safety cap together act as backstops.

A new termination initiator label `core:tool_release` SHALL be used when an owned session is terminated because the owning sub-agent returned a `{ release: true }` tool result. The earlier `core:continuous_end` label is retired (no notes-domain tool terminates the session by name any more — termination flows through `tool-driven-ear-sessions`).

The `notes` domain SHALL expose an `open_continuous_session` tool that accepts a required `name` parameter and, instead of mutating the active regular session, calls `EarSessionRouter.arm({ ownerSpec: notesAgentSpec, mode: "continuous", artifactName: name })`, which dispatches `arm_capture` to the connected Ear so a fresh long-note session is opened and bound to the notes sub-agent. The original short utterance terminates normally via its own VAD / silence cap.

When the `continuous` session is bound to the notes domain, Core SHALL drive the overlay to `{ kind: "capturing", caption: <name>, sound: "ack_continue" }` at arm time so the user sees which note is being recorded. The `artifactName` SHALL flow from `open_continuous_session` through `router.arm` to the overlay/session-spec layer; sub-agent code SHALL NOT re-derive it.

Core's Deepgram-final fanout SHALL consult `EarSessionRouter.ownerOf(sessionId)` for every final and every Ear-initiated `session_end`. When an owner is present, the final SHALL be delivered to the owning sub-agent runner instead of the post-endpoint `handleTurn` path.

#### Scenario: long-note session uses the relaxed cap from start

- **WHEN** the Ear sends `session_start` with `mode: "continuous"`
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

#### Scenario: continuous session overlay shows the note name

- **WHEN** the notes agent invokes `open_continuous_session({ name: "идея проекта" })`
- **THEN** Core SHALL drive the overlay to `{ kind: "capturing", caption: "идея проекта", sound: "ack_continue" }` at arm time
- **AND** the Mac Ear SHALL render the caption under the orb verbatim
