## ADDED Requirements

### Requirement: Kernel SHALL provide reusable session-control tool builders for domains

The orchestration kernel SHALL expose at least one tool-builder factory under `apps/core/src/conversation/kernel/tools/` that domains use to add Ear-session-control tools to their `AgentSpec`. The MVP member is `buildOpenContinuousSessionTool(router, ownerSpecRef)` (see the `kernel-session-control-tools` capability for its contract).

A domain that wants its supervisor-side or session-bound agent to control an Ear session lifecycle SHALL use one of these kernel-provided builders. A domain SHALL NOT call `EarSessionRouter.arm`, `EarSessionRouter.release`, or any other `EarSessionRouter` mutator directly from a tool handler — every call SHALL go through a kernel-provided builder so the surface stays one-source-of-truth.

#### Scenario: A domain needs a continuous capture session

- **WHEN** a domain module wants to give its agent the ability to open a long-running Ear session
- **THEN** the module SHALL import `buildOpenContinuousSessionTool` from `apps/core/src/conversation/kernel/tools/open-continuous-session.tool.ts`
- **AND** SHALL push its output into the domain's `AgentSpec.tools`
- **AND** SHALL NOT instantiate its own copy of the `arm`-call logic
