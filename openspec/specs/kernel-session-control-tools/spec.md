# kernel-session-control-tools Specification

## Purpose

Defines the reusable tool builders the orchestration kernel exposes to domains for controlling Ear capture session lifecycle. Today the only builder is `buildOpenContinuousSessionTool`, which a domain injects into its `AgentSpec.tools` so the supervisor agent can open a continuous (no-VAD-endpoint, ~60 s silence cap) capture session bound to the domain. The capability is the seam that lets new domains opt into long-running capture without re-implementing the `arm()` call or reaching directly into `EarSessionRouter`.

## Requirements

### Requirement: Kernel SHALL provide an `open_continuous_session` tool builder for domains

The orchestration kernel SHALL expose a factory `buildOpenContinuousSessionTool(router: EarSessionRouter, ownerSpecRef: { spec: AgentSpec | null }): AgentTool` from `apps/core/src/conversation/kernel/tools/open-continuous-session.tool.ts`. The returned `AgentTool` SHALL have the name `open_continuous_session`. Its handler SHALL read the current `ownerSpecRef.spec`; if null, it SHALL return `{ ok: false, reason: "owner-session-spec-not-ready" }` without throwing. If the spec is present, the handler SHALL call `router.arm({ ownerSpec: <spec>, mode: "continuous" })` and return the `ArmResult` verbatim.

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

#### Scenario: Spec ref is present

- **WHEN** the LLM invokes `open_continuous_session` and `ownerSpecRef.spec` is non-null
- **THEN** the handler SHALL call `router.arm({ ownerSpec: <spec>, mode: "continuous" })` exactly once
- **AND** SHALL return whatever `router.arm` returned (the `ArmResult`)

### Requirement: Kernel-provided tool builders live under `conversation/kernel/tools/`

Every shared tool factory the kernel exposes to domains SHALL live under `apps/core/src/conversation/kernel/tools/`. The current member of this folder SHALL be `open-continuous-session.tool.ts`. Future kernel-provided tool builders SHALL land in the same folder; domain code SHALL NOT import from `conversation/sessions/` or `conversation/ear/` to build tools.

#### Scenario: A future domain wants continuous capture

- **WHEN** a new domain module (e.g. story-dictate) wants its supervisor agent to be able to open a continuous capture session
- **THEN** the domain module SHALL import `buildOpenContinuousSessionTool` from `apps/core/src/conversation/kernel/tools/open-continuous-session.tool.ts`
- **AND** SHALL push its output into the domain's `AgentSpec.tools` array
- **AND** SHALL NOT import from `apps/core/src/conversation/sessions/` to build the tool
