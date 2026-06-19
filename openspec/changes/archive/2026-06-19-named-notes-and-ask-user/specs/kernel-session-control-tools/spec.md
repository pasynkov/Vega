## ADDED Requirements

### Requirement: Kernel SHALL provide an `ask_user` tool builder for domains

The orchestration kernel SHALL expose a factory `buildAskUserTool(router: EarSessionRouter, sessions: SessionService, overlay: OverlayService): AgentTool` from `apps/core/src/conversation/kernel/tools/ask-user.tool.ts`. The returned `AgentTool` SHALL have the name `ask_user` and SHALL be globally available — every domain MAY inject it into its supervisor-side or session-bound `AgentSpec.tools` bundle.

The DTO SHALL accept:

- `question` (string, ≤ 240 chars, required) — rendered as overlay `caption`
- `hint` (string, ≤ 120 chars, optional, default `"Скажите ответ"`) — rendered as overlay `hint`
- `captureMs` (positive integer, optional, default `8000`) — maximum wall-clock the ask-session waits before aborting

The handler SHALL:

1. Resolve the active `deviceId` via `ctx.earSession?.deviceId` first, then `sessions.getDeviceIdForSession(ctx.sessionId)`. If neither yields a deviceId the handler SHALL return `{ ok: false, reason: "no-active-device" }` without throwing.
2. Drive the overlay to `{ kind: "listening", caption: question, hint, sound: "cue_listen" }` via `OverlayService.set(...)` (no TTL — the ask-session lifecycle owns termination).
3. Open a new Ear capture session via `router.openAskSession({ deviceId, captureMs })`, awaiting the returned `Promise<AskSessionOutcome>`.
4. Translate the outcome:
   - `{ kind: "answer", text }` → return `{ ok: true, answer: text }`
   - `{ kind: "timeout" }` → return `{ ok: false, reason: "timeout" }`
   - `{ kind: "cancelled" }` → return `{ ok: false, reason: "cancelled" }` (user tap or other manual abort)
5. After the outcome resolves, drive the overlay to `{ kind: "idle" }` exactly once so the surface collapses.

The handler MUST NOT call `EarSessionRouter`, `SessionService`, or `OverlayService` from anywhere other than this builder; domain code MUST consume `ask_user` rather than re-implementing the wait-for-final loop.

#### Scenario: Notes domain wires ask_user into its supervisor tool bundle

- **WHEN** `NotesAgentService` constructs its supervisor-side tool bundle
- **THEN** the bundle SHALL include the tool returned by `buildAskUserTool(router, sessions, overlay)`
- **AND** that tool's name SHALL be `ask_user`
- **AND** no notes-domain file SHALL invoke `router.openAskSession` directly

#### Scenario: User answers within captureMs

- **WHEN** the LLM invokes `ask_user({ question: "Как назвать заметку?", captureMs: 8000 })`
- **AND** the user speaks "идея проекта" within the window
- **THEN** the handler SHALL return `{ ok: true, answer: "идея проекта" }`
- **AND** the overlay SHALL have shown `caption: "Как назвать заметку?"` while listening
- **AND** SHALL be set back to `{ kind: "idle" }` after the answer resolves

#### Scenario: Capture window elapses with no final

- **WHEN** the LLM invokes `ask_user({ question: "Как назвать заметку?", captureMs: 8000 })`
- **AND** no STT final arrives within 8 000 ms
- **THEN** the handler SHALL return `{ ok: false, reason: "timeout" }`
- **AND** the overlay SHALL be set to `{ kind: "idle" }` exactly once

#### Scenario: User cancels the ask via tap

- **WHEN** the LLM invokes `ask_user({ question: "..." })`
- **AND** the user taps the status item to cancel
- **THEN** the handler SHALL return `{ ok: false, reason: "cancelled" }`
- **AND** the overlay SHALL be set to `{ kind: "idle" }` exactly once

#### Scenario: No active device

- **WHEN** the LLM invokes `ask_user({ question: "..." })`
- **AND** neither `ctx.earSession?.deviceId` nor `sessions.getDeviceIdForSession(ctx.sessionId)` resolves a deviceId
- **THEN** the handler SHALL return `{ ok: false, reason: "no-active-device" }`
- **AND** SHALL NOT call `router.openAskSession`
- **AND** SHALL NOT mutate the overlay

## MODIFIED Requirements

### Requirement: Kernel SHALL provide an `open_continuous_session` tool builder for domains

The orchestration kernel SHALL expose a factory `buildOpenContinuousSessionTool(router: EarSessionRouter, ownerSpecRef: { spec: AgentSpec | null }): AgentTool` from `apps/core/src/conversation/kernel/tools/open-continuous-session.tool.ts`. The returned `AgentTool` SHALL have the name `open_continuous_session`. Its DTO SHALL accept:

- `name` (string, 1..120 chars, required) — the user-facing name of the long-form artefact being captured (e.g. note title). Domains SHALL forward this verbatim to their storage layer; the kernel SHALL NOT re-derive it from `intent`.
- `intent` (string, optional) — short free-form description used in logs / overlays.

Its handler SHALL read the current `ownerSpecRef.spec`; if null, it SHALL return `{ ok: false, reason: "owner-session-spec-not-ready" }` without throwing. If the spec is present, the handler SHALL call `router.arm({ ownerSpec: <spec>, mode: "continuous", artifactName: <name>, intent: <intent> })` and return the `ArmResult` extended with `{ artifactName: <name> }`.

A domain MAY use this builder to add `open_continuous_session` to its supervisor-side tool bundle. A domain MUST NOT call `EarSessionRouter.arm` directly from inside a tool handler — calls SHALL go through this builder so the kernel owns the contract.

#### Scenario: Notes domain builds its supervisor tool bundle

- **WHEN** `NotesAgentService` constructs its supervisor-side tool bundle
- **THEN** the bundle SHALL include the tool returned by `buildOpenContinuousSessionTool(router, sessionSpecRef)`
- **AND** that tool's name SHALL be `open_continuous_session`
- **AND** no other notes-domain file SHALL contain a `router.arm(...)` call

#### Scenario: Spec ref still null when LLM calls the tool

- **WHEN** the LLM invokes `open_continuous_session` and `ownerSpecRef.spec` is still null
- **THEN** the handler SHALL return `{ ok: false, reason: "owner-session-spec-not-ready" }`
- **AND** SHALL NOT call `router.arm`
- **AND** SHALL NOT throw

#### Scenario: Spec ref is present, name passed through

- **WHEN** the LLM invokes `open_continuous_session({ name: "идея проекта", intent: "дневник" })` and `ownerSpecRef.spec` is non-null
- **THEN** the handler SHALL call `router.arm({ ownerSpec: <spec>, mode: "continuous", artifactName: "идея проекта", intent: "дневник" })` exactly once
- **AND** SHALL return the `ArmResult` extended with `{ artifactName: "идея проекта" }`

#### Scenario: Name parameter is missing

- **WHEN** the LLM invokes `open_continuous_session` without the `name` field
- **THEN** DTO validation SHALL fail and the tool framework SHALL return a validation error to the agent
- **AND** SHALL NOT call `router.arm`

## REMOVED Requirements

### Requirement: Notes domain SHALL expose a `save_short_note` tool

**Reason**: The short-note path is being removed. All notes flow through the named, continuous-session path defined by `open_continuous_session` + `finalize_note`. Keeping two flows complicates the supervisor prompt and the storage layer for no observed user value.

**Migration**: Domain prompts and tool bundles SHALL drop `save_short_note`. Reproducing a "short" capture is a one-utterance continuous session — the user dictates a single phrase, the runner finalizes immediately on the same logic. No on-disk migration is needed; previously saved short-note files remain compatible with the storage read path.
