## ADDED Requirements

### Requirement: Kernel SHALL provide an `update_overlay` tool builder for domains

The orchestration kernel SHALL expose a factory `buildUpdateOverlayTool(overlay: OverlayService): AgentTool` from `apps/core/src/conversation/kernel/tools/update-overlay.tool.ts`. The returned `AgentTool` SHALL have the name `update_overlay`. Its DTO SHALL accept the overlay state shape `{ kind, hint?, caption?, sound?, ttl? }` where:

- `kind` is one of `idle`, `listening`, `capturing`, `thinking`, `processing`, `success`, `error`
- `hint` is an optional string ≤ 120 chars
- `caption` is an optional string ≤ 240 chars
- `sound` is an optional cue identifier from the protocol cue catalog excluding `wake` (which is local-only on the Ear)
- `ttl` is an optional positive integer (milliseconds) that instructs `OverlayService` to terminate the active capture session after that delay via the standard `session_end` path

The handler SHALL invoke `OverlayService.set(ctx.deviceId, state)` (or equivalent per-device call) exactly once and SHALL return `{ ok: true }` synchronously. The handler SHALL NOT emit `overlay_update` wire messages directly. The handler SHALL be safe to call outside an active session (no-op in that case).

A domain MAY inject this tool into its supervisor-side and/or session-bound `AgentSpec.tools` bundle. A domain MUST NOT call `OverlayService` from inside a tool handler — calls SHALL go through this builder so the kernel owns the contract.

#### Scenario: Notes domain wires update_overlay into its supervisor tool bundle

- **WHEN** `NotesAgentService` constructs its supervisor-side tool bundle
- **THEN** the bundle SHALL include the tool returned by `buildUpdateOverlayTool(overlay)`
- **AND** that tool's name SHALL be `update_overlay`
- **AND** no notes-domain file SHALL import `OverlayService` directly

#### Scenario: ttl drives session termination

- **WHEN** the LLM invokes `update_overlay` with `{ kind: "success", hint: "Готово", sound: "ack_success", ttl: 1500 }`
- **THEN** the handler SHALL forward the state to `OverlayService` exactly once
- **AND** OverlayService SHALL terminate the active Ear session via `session_end` reason `endpoint` ~1500 ms later

#### Scenario: Tool invoked with no active session

- **WHEN** the LLM invokes `update_overlay` while no Ear session is active for the device
- **THEN** the handler SHALL return `{ ok: true }` without throwing
- **AND** SHALL NOT emit an `overlay_update` wire message
