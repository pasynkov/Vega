## 1. Protocol rename (ear-protocol + Swift)

- [x] 1.1 In `packages/ear-protocol/src/schema.ts`, rename the zod `SessionModeEnum` value `long_note` → `continuous`; verify every message schema (`SessionStart`, `SessionMode`, `ArmCapture`, etc.) still type-checks with the new enum literal
- [x] 1.2 Rebuild `packages/ear-protocol/dist/` (run the package's existing build script); commit the regenerated `dist/schema.{js,d.ts}` so consumers don't drift
- [x] 1.3 In `packages/ear-protocol/swift/Sources/EarProtocol/EarProtocol.swift`, rename `SessionMode.longNote` → `SessionMode.continuous` with raw value `"continuous"`; verify `swift build` for the package
- [x] 1.4 Update `packages/ear-protocol/README.md`: replace every `long_note` mention with `continuous` and add a one-line note that this is a breaking rename from the previous value

## 2. Mac-ear (Swift consumer)

- [x] 2.1 Grep `apps/mac-ear/Sources/` for `longNote` and `long_note`; rewrite each call site to use `SessionMode.continuous` / `"continuous"`
- [x] 2.2 Run `swift build` in `apps/mac-ear/` and confirm zero warnings / errors related to the rename

## 3. Core + kernel builder + bug fixes

- [x] 3.1 Create `apps/core/src/conversation/kernel/tools/` directory and add `open-continuous-session.tool.ts` exporting `buildOpenContinuousSessionTool(router, ownerSpecRef)` returning an `AgentTool` named `open_continuous_session`
- [x] 3.2 Rename DTO: `BeginDictationDto` → `OpenContinuousSessionDto`; move it to `apps/core/src/conversation/kernel/tools/open-continuous-session.dto.ts`
- [x] 3.3 In `apps/core/src/conversation/ear/session/session.service.ts`, rename `LONG_NOTE_SILENCE_CAP_MS` → `CONTINUOUS_MODE_SILENCE_CAP_MS` and every `mode === "long_note"` comparison → `mode === "continuous"` (this includes the wall-clock-cap branch added in bc47f87)
- [x] 3.4 In `apps/core/src/conversation/sessions/ear-session-router.service.ts` and `session-agent-runner.service.ts`, update mode-value comparisons / log fields from `long_note` → `continuous`
- [x] 3.5 In `apps/core/src/domains/notes/notes.tools.ts`, drop the inline `begin_dictation` factory and push `buildOpenContinuousSessionTool(router, sessionSpecRef)` into the `supervisorTools` array; remove the now-unused old DTO import and file
- [x] 3.6 In `apps/core/src/domains/notes/notes.agent.ts`, replace every `begin_dictation` / `long_note` occurrence in supervisor + session-bound system prompts with `open_continuous_session` / `continuous` (preserve Russian-language UX phrasing)
- [x] 3.7 **Bug 2 fix — arm terminates the active session first.** In `apps/core/src/conversation/sessions/ear-session-router.service.ts`, give `EarSessionRouter` a back-reference to `SessionService` (constructor injection); before sending `ArmCaptureMessage` inside `arm()`, look up any active session for the calling device and terminate it via `sessions.terminateExternal(activeSessionId, "endpoint", "core:tool_release")`. After termination, dispatch `arm_capture` as today. Log `Arm terminated active session before dispatch { deviceId, terminatedSessionId, newMode }`.
- [x] 3.8 **Bug 4 fix — drop in-transition finals.** In `apps/core/src/conversation/sessions/ear-sessions.module.ts`, when the per-final listener observes a final whose `sessionId` belonged to a session that is being terminated as part of an arm transition (i.e. the session was just closed by `core:tool_release`), it SHALL log `dropped-in-transition` and SHALL NOT call `ConversationService.handleTurn`. Implement by stamping the terminating sessionId into a small "recently torn down by arm" set with a short TTL (~5 s).
- [x] 3.9 **Bug 3 fix — per-session serialization.** In `apps/core/src/conversation/conversation.service.ts`, replace the current inFlight-read-then-set pattern in `handleTurn` with a proper chain: `this.inFlight.set(sid, (this.inFlight.get(sid) ?? Promise.resolve()).catch(() => undefined).then(() => this.runTurn(sid, text)))`. Return the resulting promise. The chain head SHALL be the value stored in `inFlight`. A rejection SHALL be caught so it doesn't block the next queued turn.
- [x] 3.10 **Bug 1 fix — wake-word first-final filter.** In `apps/core/src/conversation/sessions/ear-sessions.module.ts` (per-final listener), maintain a `firstFinalSeen: Set<string>` keyed by `sessionId`. For the first final of a session, lowercase + trim the text and check against a Core-side wake-word vocabulary (`["janet", "edna", "этна", "эдна", "джанет"]` for MVP; defined as a const in a new `apps/core/src/conversation/ear/wake/wake-vocabulary.ts`). If it matches, log `Dropping wake-only first final` and skip `handleTurn`. Subsequent finals on the same session bypass the filter.
- [x] 3.11 Run `npx tsc --noEmit` from `apps/core/` and confirm zero errors

## 4. Tests

- [x] 4.1 Update every existing test under `apps/core/tests/` that constructs a `session_start` / `arm_capture` message with `mode: "long_note"` → `mode: "continuous"`; update `apps/core/tests/ear-sessions/full-flow.test.ts` mock recognizer regexes (the mocked supervisor / sub-agent string match on `begin_dictation` / `long_note` → `open_continuous_session` / `continuous`)
- [x] 4.2 **Bug 3 test** — `apps/core/tests/conversation/conversation.test.ts` (or a new sibling): construct a `ConversationService` with a slow-mock graph, fire three `handleTurn(sessionId, ...)` calls back-to-back, assert (a) the three `runTurn` calls execute serially in arrival order and (b) the second call's start time is ≥ the first call's resolution time. Verify a rejecting first turn does not block the next turn
- [x] 4.3 **Bug 1 test** — extend `apps/core/tests/ear-sessions/integration.test.ts` (or add `wake-filter.test.ts`): simulate a wake-driven session whose first transcript is `"Этна."`; assert `ConversationService.handleTurn` is not called; assert subsequent non-wake finals on the same session are forwarded normally
- [x] 4.4 **Bug 2 test** — extend `apps/core/tests/ear-sessions/ear-session-router.test.ts`: a session is active on a device; a tool calls `router.arm({ ownerSpec, mode: "continuous" })`; assert `sessions.terminateExternal` was called on the active session with `("endpoint", "core:tool_release")` before `arm_capture` was sent over the socket
- [x] 4.5 **Bug 4 test** — extend the same ear-sessions integration: after `arm` fires, simulate a final arriving on the terminated session before the new session_start; assert the per-final listener logs `dropped-in-transition` and does NOT invoke `ConversationService.handleTurn`
- [x] 4.6 Run `npm --workspace apps/core test`; confirm the full suite is green
- [ ] 4.7 (USER) Run `npm run core:dev` against the real Mac ear; verify the live trigger no longer fires `handleTurn("Этна.")`, `arm_capture` is preceded by a session_end on the original session, finals during transition are dropped, and continuous session opens cleanly. Then dictate for 60+ seconds and confirm the session does NOT die at 30 s wall-clock (post-bc47f87 we already use `earSessionOwnerCapMs`)
- [x] 4.8 Final grep across `apps/`, `packages/`, and `openspec/` (excluding `openspec/changes/archive/`) for `long_note` — only documentation / spec-folder paths should remain; flag any stray code occurrences and fix

## 5. Commits

- [x] 5.1 Commit task group 1 as `refactor(ear-protocol): rename SessionMode long_note → continuous`
- [x] 5.2 Commit task group 2 as `refactor(mac-ear): adopt continuous SessionMode`
- [x] 5.3 Commit task group 3 as `refactor(core): kernel session-control tool builder + 4 session-flow bug fixes`
- [x] 5.4 Commit task group 4 as `test(core): coverage for kernel tool builder + session-flow bugs`
