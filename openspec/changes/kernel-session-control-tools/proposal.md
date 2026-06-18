## Why

The `begin_dictation` tool in `apps/core/src/domains/notes/notes.tools.ts:39-52` is a thin wrapper over `EarSessionRouter.arm({ ownerSpec, mode: "long_note" })`. Opening a long-running, no-VAD-cap capture session is a **kernel responsibility**, not a notes-specific behavior — any future domain that wants a continuous capture session (story dictation, free-form chat, voice journaling) would have to copy this exact tool factory.

At the same time, the protocol-level mode name `long_note` leaks the original use case into the audio pipeline. Tying a capture-mode enum value to "notes" prevents other domains from owning a `long_note` session without that being a name lie. The audio pipeline does not care which domain consumes the session; it only cares that the silence cap is suppressed and the per-final transcript is forwarded to the session owner.

This change extracts the tool into a kernel builder, and renames the protocol mode `long_note` → `continuous`, so the abstraction matches what the audio pipeline actually models: "a continuous capture stream with no auto-endpoint, owned by some domain."

## What Changes

- **Add** `apps/core/src/conversation/kernel/tools/open-continuous-session.tool.ts` exporting `buildOpenContinuousSessionTool(router, ownerSpecRef)` that returns an `AgentTool` named `open_continuous_session`. Tool handler calls `router.arm({ ownerSpec, mode: "continuous" })` and returns the `ArmResult` verbatim.
- **Update** `apps/core/src/domains/notes/notes.tools.ts` to drop the inline `begin_dictation` factory and instead push `buildOpenContinuousSessionTool(router, sessionSpecRef)` into the supervisor-side tool bundle. The notes-session sub-agent's `finalize_note` / `discard_note` tools are unchanged.
- **Update** `apps/core/src/domains/notes/notes.agent.ts` system prompt and tool list to reference `open_continuous_session` (not `begin_dictation`).
- **BREAKING** Rename the `ear-protocol` `SessionModeEnum` value `long_note` → `continuous`. This touches:
  - `packages/ear-protocol/src/schema.ts` (zod enum + every message schema that references the mode)
  - `packages/ear-protocol/swift/Sources/EarProtocol/EarProtocol.swift` (`SessionMode.longNote` → `SessionMode.continuous`, raw value `"continuous"`)
  - `apps/mac-ear/Sources/VegaEar/` (every consumer of `SessionMode.longNote`, all UI strings, the session_mode handler, the wake/listening flow)
  - `apps/core/src/conversation/ear/session/session.service.ts` (3 mode comparisons, the `LONG_NOTE_SILENCE_CAP_MS` constant renamed to `CONTINUOUS_MODE_SILENCE_CAP_MS`)
  - `apps/core/src/conversation/sessions/` (`EarSessionRouter`, `SessionAgentRunner`, `EarSessionHandle` type comments)
  - `apps/core/src/domains/notes/` (notes-session AgentSpec name stays `notes-session`; its prompt and finalize/discard messaging shift from "long-note" to "continuous-mode")
  - All existing vitest tests under `apps/core/tests/` that compare `mode === "long_note"` or arm sessions with `mode: "long_note"`
- **Update** the `long-note-mode` capability spec: rename it operationally to "continuous capture mode" semantics. The capability folder name on disk (`openspec/specs/long-note-mode/`) is preserved in this change to avoid an additional rename ripple; only the requirements inside it get the term flip.
- **Verify** by re-running `apps/core/tests/e2e/contract.e2e.test.ts` (the short-note path stays green) and the existing long-note end-to-end harness in `apps/core/tests/ear-sessions/full-flow.test.ts` after its mode literals are updated.

## Capabilities

### New Capabilities

- `kernel-session-control-tools`: defines the kernel-provided tool builders that any domain can inject into its `AgentSpec.tools` to drive Ear session lifecycle (open continuous capture, in the MVP). This is the seam that lets new domains opt into long-running capture without re-implementing the `arm()` call.

### Modified Capabilities

- `ear-protocol`: rename `SessionModeEnum` value `long_note` → `continuous`; all message schemas referencing the mode keep their shape with the new enum value.
- `mac-ear`: the "Long-note mode handling" requirement renames its references to the mode value to `continuous`; the cue mapping, UI affordances, and `session_mode` handling are unchanged behaviorally.
- `vega-core`: the "Long-note mode silence cap and termination" requirement keeps its semantics but references the mode value as `continuous` and renames the silence-cap constant accordingly.
- `tool-driven-ear-sessions`: requirements that mention long_note ownership are reworded to "continuous-mode ownership"; tool semantics unchanged.
- `agent-system`: add a requirement that the kernel exposes session-control tool builders (the new `open_continuous_session` builder is the first one); domains MUST go through these builders rather than calling `EarSessionRouter.arm` directly.
- `long-note-mode`: requirements re-worded around `continuous` mode; the protocol-level name change is the only behavioral surface that shifts.

## Impact

- **Affected code (Core)**: 1 new file (`open-continuous-session.tool.ts`), edits in `notes.tools.ts`, `notes.agent.ts`, `notes-agent.service.ts`, `session.service.ts`, `ear-session-router.service.ts`, `session-agent-runner.service.ts`, `ear-session-handle.ts`.
- **Affected code (ear-protocol)**: `packages/ear-protocol/src/schema.ts` plus the regenerated `dist/`; Swift enum in `packages/ear-protocol/swift/Sources/EarProtocol/EarProtocol.swift`.
- **Affected code (mac-ear)**: every Swift file that references `SessionMode.longNote` — capture controller, status item, session_mode handler, menu strings.
- **Affected tests**: `apps/core/tests/ear-sessions/full-flow.test.ts`, `apps/core/tests/ear-sessions/integration.test.ts`, `apps/core/tests/ear-sessions/ear-session-router.test.ts`, `apps/core/tests/long-note/session-service.test.ts`, plus any test that constructs a `session_start` message with `mode: "long_note"`.
- **APIs**: protocol BREAKING — an `ear-protocol` client built before this change will fail zod validation when Core sends `arm_capture { mode: "continuous" }`, and Core will reject `session_start { mode: "long_note" }` from such a client. Forward-compatibility is not provided. Coordinated bump of the protocol package version is implicit.
- **Risk**: medium. The protocol rename is mechanical but wide. Mitigated by (a) the contract e2e test still bootstraps the whole stack with the new mode value, and (b) the long-note ear-sessions integration tests cover the arm → session_start → bind → flush → finalize loop.
