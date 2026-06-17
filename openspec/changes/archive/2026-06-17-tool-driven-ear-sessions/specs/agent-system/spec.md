## ADDED Requirements

### Requirement: Sub-agents may be invoked in session-bound mode

The capability SHALL recognise a second sub-agent invocation mode in addition to the post-endpoint `handleTurn` path: **session-bound invocation**, driven by `tool-driven-ear-sessions.runSessionAgent`. In session-bound invocation, the same `AgentSpec` is reused: its `systemPrompt`, `tools`, and (if present) `model` SHALL be the only sources of behaviour. No new fields SHALL be added to `AgentSpec`.

The distinction between modes SHALL be encoded in the runtime context passed to tool handlers, not in the spec shape. Specifically, a tool handler invoked from inside a session-bound sub-agent SHALL receive an `EarSessionHandle` on its context; the same handler invoked from the post-endpoint path SHALL receive `undefined` in that slot.

#### Scenario: AgentSpec shape is unchanged

- **WHEN** an implementer inspects the `AgentSpec` interface after this change
- **THEN** its field set SHALL be exactly the set described in the existing `AgentSpec` requirement
- **AND** no `sessionBound` boolean, no separate "session agent" type, and no parallel spec interface SHALL exist

#### Scenario: Tool handler can detect session-bound context

- **WHEN** a tool handler is invoked from a session-bound sub-agent loop
- **THEN** its context SHALL include an `EarSessionHandle` for the active session
- **AND** the same handler invoked from a post-endpoint turn SHALL receive context without an `EarSessionHandle`

### Requirement: Session-bound tools may declare release semantics

Tools that end a session-bound sub-agent loop SHALL signal release by returning a `SessionToolResult` of shape `{ release: true, reason: "endpoint" | "timeout" | "stt_error" | "user", ... }`. Tools intended to be used only inside a session-bound loop (e.g. `append_text`, `finalize_note`) MAY rely on `EarSessionHandle` being present on context; when invoked outside a session-bound loop they SHALL throw `ToolUsedOutsideSessionError` rather than silently no-op.

#### Scenario: Release-shape return ends the session

- **WHEN** a session-bound tool returns `{ release: true, reason: "endpoint" }`
- **THEN** the sub-agent runner SHALL treat the loop as terminated
- **AND** SHALL release `EarSessionRouter` ownership for that session

#### Scenario: Session-only tool invoked from post-endpoint turn

- **WHEN** the supervisor (or a non-session sub-agent) calls a tool that requires `EarSessionHandle`
- **THEN** the tool SHALL throw `ToolUsedOutsideSessionError`
- **AND** the error SHALL be surfaced to the calling LLM as a normal tool-call error
