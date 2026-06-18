## MODIFIED Requirements

### Requirement: A tool may own an Ear capture session for its full lifetime

The capability SHALL define `EarSessionRouter`, a Core service that maps `sessionId` → owning `AgentSpec` for any session that was opened on behalf of a domain tool. While a session is owned, the standard post-endpoint `handleTurn` flow SHALL NOT run for that session. Ownership SHALL be reserved before the Ear session opens (via `arm_capture`) and SHALL be released when the owning sub-agent loop terminates for any reason.

Only one tool SHALL own a given `sessionId` at a time. Only one outstanding ownership reservation per Ear device SHALL be active at a time; a second `arm({ ownerSpec })` call before the first session arrives SHALL be rejected.

#### Scenario: Tool reserves and the next session is owned

- **WHEN** a tool calls `EarSessionRouter.arm({ ownerSpec, mode: "continuous" })` (typically via the kernel-provided `buildOpenContinuousSessionTool` factory)
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
