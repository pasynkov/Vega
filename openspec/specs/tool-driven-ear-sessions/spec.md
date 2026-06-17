# tool-driven-ear-sessions Specification

## Purpose
TBD - created by archiving change tool-driven-ear-sessions. Update Purpose after archive.
## Requirements
### Requirement: A tool may own an Ear capture session for its full lifetime

The capability SHALL define `EarSessionRouter`, a Core service that maps `sessionId` → owning `AgentSpec` for any session that was opened on behalf of a domain tool. While a session is owned, the standard post-endpoint `handleTurn` flow SHALL NOT run for that session. Ownership SHALL be reserved before the Ear session opens (via `arm_capture`) and SHALL be released when the owning sub-agent loop terminates for any reason.

Only one tool SHALL own a given `sessionId` at a time. Only one outstanding ownership reservation per Ear device SHALL be active at a time; a second `arm({ ownerSpec })` call before the first session arrives SHALL be rejected.

#### Scenario: Tool reserves and the next session is owned

- **WHEN** a tool calls `EarSessionRouter.arm({ ownerSpec, mode: "long_note" })`
- **THEN** the router SHALL dispatch `arm_capture` to the Ear with the requested mode
- **AND** the next `session_start` from that Ear with the matching mode SHALL be bound to `ownerSpec`
- **AND** `EarSessionRouter.ownerOf(sessionId)` SHALL return that `ownerSpec` for the lifetime of the session

#### Scenario: Unowned session uses the default flow

- **WHEN** a wake-driven `session_start` arrives for which the router has no reservation
- **THEN** the router SHALL NOT bind the session
- **AND** the default post-endpoint `handleTurn` flow SHALL run when the session ends

#### Scenario: Double-arm is rejected

- **WHEN** a tool calls `arm` while a prior unfulfilled reservation exists for the same Ear device
- **THEN** the router SHALL throw a structured `EarSessionReservationConflictError`
- **AND** SHALL NOT dispatch a second `arm_capture`

### Requirement: Session sub-agent runner drives a domain loop from streamed finals

The capability SHALL define `runSessionAgent({ handle, spec, initialPrompt })`, a runner that owns one Ear session's LLM loop for its lifetime. The runner SHALL be invoked exactly once per owned session, immediately after that session's `session_start` is observed, with `spec` resolved from `EarSessionRouter.ownerOf(sessionId)`.

The runner SHALL boot a sub-agent using the AgentSpec's `systemPrompt`, `tools`, and (optionally) `model`. The sub-agent SHALL be invoked once with `initialPrompt` (a short brief describing why it was opened, e.g. "User requested dictation of a long note"). On every subsequent Deepgram `final_transcript` for the owned session, the runner SHALL push the final text into the sub-agent as the next user turn. Partial transcripts SHALL NOT trigger sub-agent turns.

Per-session sub-agent turns SHALL be serialised: if a new final arrives while the sub-agent is still processing the previous turn, the new final SHALL be queued and delivered when the previous turn settles. The queue SHALL preserve order. There SHALL be no implicit timeouts on turn execution beyond the safety cap below.

The sub-agent ends the session by calling one of its own tools that resolves to "release ownership" (in the notes domain: `finalize_note` or `discard_note`). When the sub-agent loop returns, the runner SHALL ask `EarSessionRouter` to release ownership and SHALL ask the session pipeline to terminate the Ear session with the reason supplied by the tool (default `endpoint`, initiator `core:tool_release`).

#### Scenario: Finals drive sequential sub-agent turns

- **WHEN** Deepgram delivers three final transcripts in sequence to an owned session
- **THEN** the runner SHALL invoke the sub-agent once per final, in arrival order
- **AND** SHALL NOT start the second sub-agent invocation until the first has returned

#### Scenario: Sub-agent decides to end the session

- **WHEN** the sub-agent calls a tool that returns `{ release: true, reason: "endpoint" }`
- **THEN** the runner SHALL release the router ownership
- **AND** the session pipeline SHALL terminate the Ear session with reason `endpoint` and initiator `core:tool_release`
- **AND** subsequent finals (if any) SHALL NOT reach the sub-agent

#### Scenario: Sub-agent throws unexpectedly

- **WHEN** the sub-agent invocation throws an unhandled error
- **THEN** the runner SHALL log the error at error level
- **AND** SHALL release the router ownership
- **AND** the session pipeline SHALL terminate the Ear session with reason `stt_error` and initiator `core:tool_error`
- **AND** any artefact-side work the sub-agent had already begun SHALL be flushed by the owning domain before release

### Requirement: Session pipeline routes finals via the router

The existing Deepgram-final fanout in `vega-core` SHALL consult `EarSessionRouter.ownerOf(sessionId)` for every final and every `session_end`. If an owner is present, the final SHALL be delivered to the sub-agent runner instead of the post-endpoint `handleTurn` path. If not, the existing path SHALL run unchanged.

`session_end` events received from the Ear (e.g. user tap) for an owned session SHALL flush any pending finals into the sub-agent and then signal the sub-agent that no more finals will arrive; the sub-agent SHALL be given one final turn to call its release tool, after which the runner SHALL force-release ownership.

#### Scenario: Owned session ends via tap

- **WHEN** an owned session receives `session_end` from the Ear with reason `user` while finals are queued
- **THEN** the runner SHALL drain queued finals into the sub-agent in order
- **AND** SHALL then deliver a synthetic terminal turn ("the user has ended capture; finalize or discard") to the sub-agent
- **AND** SHALL release ownership after the sub-agent settles, regardless of which tool it calls

### Requirement: Hard safety cap on owned sessions

An owned Ear session SHALL terminate after a configurable hard wall-clock cap (target: 90 seconds from `session_start`, configurable via `EAR_SESSION_OWNER_CAP_MS`) regardless of sub-agent activity, to prevent a stuck or runaway sub-agent from holding the microphone open indefinitely. When the cap fires, the runner SHALL release ownership, instruct the session pipeline to terminate with reason `timeout` and initiator `core:owner_safety_cap`, and the owning domain SHALL be given one synchronous chance to persist whatever artefact state it has accumulated.

This cap is independent of the existing `core:silence_cap` (which measures gap between transcripts) and SHALL act as an additional backstop.

#### Scenario: Cap fires on a runaway sub-agent

- **WHEN** an owned session has been active for the configured cap without releasing
- **THEN** the runner SHALL force-release router ownership
- **AND** the session SHALL terminate with reason `timeout` and initiator `core:owner_safety_cap`
- **AND** the domain SHALL have run its on-cap flush hook before ownership is released

### Requirement: Owning domain owns intent and stop decisions

The capability SHALL NOT contain any classifier service, intent prompt, or "is the user done?" logic. Those concerns SHALL live entirely inside the owning domain's `AgentSpec` (its `systemPrompt`, its tools, the LLM it chooses to call). The runner's contract is mechanical: it pushes finals in, the sub-agent calls tools out.

The owning domain MAY choose to invoke a cheap classifier model (e.g. Anthropic Haiku) on each final from inside its sub-agent loop, but doing so SHALL be a local implementation detail of that domain, not a framework primitive.

#### Scenario: Framework exposes no classifier

- **WHEN** an implementer reads the `tool-driven-ear-sessions` module
- **THEN** the module SHALL NOT export a `HaikuClassifierService` or any equivalent intent/stop classifier
- **AND** the runner contract SHALL pass final text verbatim to the sub-agent without inspection

