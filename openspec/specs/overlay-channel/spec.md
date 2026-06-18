# overlay-channel Specification

## Purpose

Defines the contract between Vega Core and any Vega Ear client for the interactive overlay surface: the visual+sound state Core paints to communicate "I heard you / I'm thinking / I'm doing / done / error". The capability covers the per-device `OverlayService` (the single writer), the overlay state model, the `update_overlay` kernel tool that domains call, the ttl-driven session termination contract, and the catalog of implicit triggers that Core emits without domain involvement.

## Requirements

### Requirement: OverlayService is the single per-device writer for overlay state

Core SHALL host an `OverlayService` that is the only component allowed to emit `overlay_update` wire messages. The service SHALL track at most one active overlay state per Ear device. It SHALL assign a strictly monotonic `seq` (per device) to every emitted message, starting at `1` on the first send for that connection. The service SHALL NOT persist overlay state across Ear disconnects; on a new WebSocket connection the implicit state is `idle` and nothing is emitted until a trigger fires.

Both implicit triggers (originating in Core) and explicit triggers (originating in a domain agent through the `update_overlay` kernel tool) SHALL call `OverlayService` to mutate state. No other path SHALL produce `overlay_update` messages.

#### Scenario: Domain tool and implicit trigger both go through OverlayService

- **WHEN** an STT `final_transcript` arrives and a domain agent simultaneously invokes `update_overlay`
- **THEN** both updates SHALL be applied through `OverlayService` in arrival order
- **AND** each emitted `overlay_update` SHALL carry a strictly greater `seq` than the previous one for the same device

#### Scenario: Reconnect resets implicit overlay state

- **WHEN** an Ear disconnects with overlay state `{kind: processing, hint: ...}` and reconnects
- **THEN** `OverlayService` SHALL NOT emit any `overlay_update` on the new connection until a new trigger fires
- **AND** the next `seq` for that device SHALL restart at `1`

### Requirement: Overlay state model

An overlay state SHALL be a single immutable record with shape `{ kind, hint?, caption?, sound? }`. The `kind` field SHALL be one of `idle`, `listening`, `capturing`, `thinking`, `processing`, `success`, `error`. The `hint` field SHALL be an optional short string (≤ 120 chars) rendered above the orb. The `caption` field SHALL be an optional short string (≤ 240 chars) rendered below the orb. The `sound` field SHALL be an optional cue name (see `ear-protocol` cue enum) that the Ear SHALL play exactly once on receipt.

Every `overlay_update` SHALL contain a complete state record — there are no patches and no partial updates. Fields absent from the payload SHALL be treated as cleared (e.g. omitting `caption` clears the bottom line).

#### Scenario: Empty optional sections collapse

- **WHEN** an `overlay_update` arrives with `{kind: thinking}` and neither `hint` nor `caption`
- **THEN** the Ear SHALL render the orb in the `thinking` style only
- **AND** SHALL NOT render top or bottom text sections

#### Scenario: Bound-checked text fields

- **WHEN** Core attempts to emit an overlay state with `hint` longer than 120 characters or `caption` longer than 240 characters
- **THEN** validation SHALL reject the state at the service boundary and SHALL NOT send a wire message

### Requirement: Kernel `update_overlay` tool

The orchestration kernel SHALL expose a factory `buildUpdateOverlayTool(overlay: OverlayService): AgentTool` (or equivalent) from `apps/core/src/conversation/kernel/tools/update-overlay.tool.ts`. The returned `AgentTool` SHALL have the name `update_overlay`. Its DTO SHALL accept `{ kind, hint?, caption?, sound?, ttl? }` per the overlay state model plus an optional `ttl` (positive integer milliseconds). The handler SHALL forward the state record to `OverlayService` and SHALL return `{ ok: true }` synchronously.

A domain that wants its agent to push overlay states SHALL inject this tool into its supervisor and/or session-bound `AgentSpec.tools`. No domain code SHALL emit `overlay_update` wire messages or import `OverlayService` directly.

#### Scenario: Notes domain wires update_overlay into its supervisor

- **WHEN** `NotesAgentService` constructs its supervisor-side tool bundle
- **THEN** the bundle SHALL include the tool returned by `buildUpdateOverlayTool(overlay)`
- **AND** that tool's name SHALL be `update_overlay`

### Requirement: TTL-driven session termination

`OverlayService` SHALL accept an optional `ttl` (milliseconds) on any state record. When set, the service SHALL start a per-device timer; on expiry the service SHALL request termination of the current Ear capture session via the established `session_end` path (reason `endpoint`) and SHALL then emit a final `{kind: idle}` overlay update so the Ear collapses the visual.

If a new state arrives before the timer fires, the timer SHALL be cancelled. If the new state also carries a `ttl`, a fresh timer SHALL be scheduled. If the new state has no `ttl`, no timer SHALL be scheduled. `OverlayService` SHALL NOT cancel a pending ttl from inside `terminate` (session_end) paths — a ttl set by a domain handler is the source of truth for the final overlay transition.

#### Scenario: success state with ttl closes the session and idles the overlay

- **WHEN** a domain tool emits `{kind: success, hint: "Готово", sound: "ack_success", ttl: 1500}`
- **THEN** Core SHALL send the corresponding `overlay_update`
- **AND** ~1500 ms later Core SHALL terminate the active Ear session with `session_end` reason `endpoint`
- **AND** Core SHALL emit `{kind: idle}` so the Ear collapses the overlay

### Requirement: Implicit overlay triggers

Core SHALL push the following implicit overlay updates through `OverlayService` without any domain involvement:

- On `wake_ack` of action `proceed` → `{kind: listening}` (no `sound` — `wake` cue is played locally by the Ear).
- On `partial_transcript` → NO overlay update. Partials are streamed only for STT visibility, not for overlay paint.
- On `final_transcript` → `{kind: capturing, caption: <final text>}` ONLY when the session is in `continuous` mode AND the session is owned by a domain (e.g. notes dictation). For a regular short-command session, no overlay update is emitted on finals.
- On `arm_capture` dispatch (Core opens a new session via the kernel arm flow) → for `continuous` mode `{kind: capturing}`; for `regular` mode `{kind: listening}`. Bridges the closing short session to the new session without an overlay collapse.
- On `terminate` of an in-flight session, when no domain ttl is pending and the caller did not pass `silentOverlay`:
  - `reason: endpoint` → `{kind: thinking, caption: <last final or partial>, sound: endpoint}` (preserves the "соображаю" visual while the orchestrator dispatches; the Pop cue plays once).
  - any other `reason` → `{kind: thinking, caption: <last final or partial>, sound: error}` (cue sound signals the failure but the visual stays in `thinking` so the user never sees an error flash for a normally-handled flow).
  - `ear:vad` SHALL map to `reason: endpoint` (natural end-of-utterance from the Ear's local VAD is an endpoint, not an error).
  - When `silentOverlay` is passed (ttl-driven release, arm-driven release), Core SHALL skip the overlay paint entirely. The next overlay update is the canonical one.
  - When a domain ttl timer is pending on this device, Core SHALL skip the overlay paint so the domain's success/error state survives until ttl expiry.
- On `session_end` → no `overlay_update` is emitted. The Ear SHALL NOT hide the overlay in response to `session_end`; the overlay survives across the session boundary and only collapses on a subsequent `{kind: idle}` update or a WebSocket disconnect.
- On orchestrator outcome `unknown` → `{kind: error, hint: "Не понял запрос", sound: ack_unknown, ttl: 1500}`. On orchestrator outcome `error` → `{kind: error, hint: "Что-то пошло не так", sound: ack_error, ttl: 2500}`. On `acted`, no implicit overlay is emitted (the domain handler already painted finishing state via `update_overlay`).

Explicit triggers from domain `update_overlay` calls SHALL be free to override any implicit state in any order (last-writer-wins by `seq`).

#### Scenario: continuous mode shows each final as a separate caption

- **WHEN** the Ear is in a continuous session owned by the notes domain and the user dictates two sentences
- **THEN** Core SHALL emit two `overlay_update` messages, each with `{kind: capturing, caption: <that sentence>}`
- **AND** the Ear SHALL render exactly the latest caption at any time (no accumulated list)

#### Scenario: regular short-command session leaves the overlay alone on finals

- **WHEN** the Ear is in a regular session and Deepgram emits a final transcript "купи молоко"
- **THEN** Core SHALL NOT emit an `overlay_update` carrying that text as a caption
- **AND** the overlay SHALL keep whatever visual was painted last (typically `listening`)

#### Scenario: overlay bridges the gap between short session and continuous session

- **WHEN** the orchestrator handles a final from a short session, decides to open a continuous session, and the kernel `arm` flow terminates the short session before sending `arm_capture`
- **THEN** the terminate path SHALL be invoked with `silentOverlay`
- **AND** Core SHALL emit `{kind: capturing}` together with `arm_capture` so the overlay never collapses between the two sessions

#### Scenario: domain success ttl drives the final overlay transition

- **WHEN** a domain handler emits `{kind: success, hint: "Заметка сохранена", sound: ack_success, ttl: 1500}` and immediately requests session release
- **THEN** Core SHALL terminate the session with `silentOverlay`
- **AND** Core SHALL NOT overwrite the success state with `thinking`
- **AND** the ttl timer SHALL fire ~1500 ms later and emit `{kind: idle}` so the Ear collapses the overlay
