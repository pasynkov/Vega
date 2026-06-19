## 1. Protocol — `@vega/ear-protocol`

- [x] 1.1 Add `"immersive"` to `SessionMode` (`session_start.mode`, `arm_capture.mode`, `session_mode.mode`) in `packages/ear-protocol/src/schema.ts`.
- [x] 1.2 Add `"immersive"` to `OverlayKind` (`overlay_update.state.kind`) in the same file.
- [x] 1.3 Mirror both additions in `packages/ear-protocol/swift/Sources/EarProtocol/EarProtocol.swift` (TS+Swift parity).
- [x] 1.4 Update `packages/ear-protocol/fixtures/examples.json` with at least one fixture per event carrying `mode: "immersive"` and one `overlay_update` carrying `state.kind: "immersive"`.
- [x] 1.5 Update Swift fixtures `packages/ear-protocol/swift/Tests/EarProtocolTests/Fixtures/examples.json`.
- [x] 1.6 Extend `packages/ear-protocol/tests/round-trip.test.ts` so new fixtures round-trip on TS side.
- [x] 1.7 Extend `packages/ear-protocol/swift/Tests/EarProtocolTests/RoundTripTests.swift` for Swift parity.

## 2. Conversation — silence cap + inFlight pause

- [x] 2.1 In `apps/core/src/conversation/ear/session/session.service.ts` add `IMMERSIVE_MODE_SILENCE_CAP_MS = 15_000` constant rendered alongside `CONTINUOUS_MODE_SILENCE_CAP_MS`.
- [x] 2.2 Extend `start()` branch picking `initialCap` and `vadEndpointSuppressed`: when `initialMode === "immersive"`, set cap to `IMMERSIVE_MODE_SILENCE_CAP_MS`, suppress VAD endpoint, and skip wall-clock timeout (mirror continuous).
- [x] 2.3 Add field `inFlight: boolean` to `InFlightSession`, default `false`.
- [x] 2.4 Add public method `setSessionInFlight(sessionId, inFlight: boolean): void`. On `true` clear pending silence timer. On `false` re-arm via existing `armSilenceTimer`.
- [x] 2.5 In `armSilenceTimer`, return early when `session.inFlight === true` (no timer schedule).
- [x] 2.6 In `onPartial`, when `session.inFlight === true`, do NOT call `armSilenceTimer` (timer will re-arm on inFlight=false). Keep partial recording / emit logic.

## 3. ImmersiveDomainRegistry

- [x] 3.1 Create `apps/core/src/conversation/immersive/immersive-domain.registry.ts` exporting `ImmersiveDomainRegistry` Nest service with `register`, `get`, `list`.
- [x] 3.2 Create `apps/core/src/conversation/immersive/immersive.module.ts` (`@Global()`, exports registry). Import in `AppModule` / `ConversationModule` so it's available before domain bootstraps.
- [x] 3.3 Define `ImmersiveDomainRegistration` type in the same file.

## 4. SessionAgentRunner — per-final-turn strategy

- [x] 4.1 In `apps/core/src/conversation/sessions/session-agent-runner.service.ts`, branch `start()` on `args.handle.mode`. `"immersive"` → init `per-final-turn` runner state. Other modes → existing `continuous-finalize` path.
- [x] 4.2 Add `onInFlightChange?: (inFlight: boolean) => void` to `RunnerSessionCallbacks`.
- [x] 4.3 Implement `onPushFinalImmersive(state, text)`:
  - guard `released`, `wakeWordOnly` filter, empty text;
  - sequential queue via `state.inflight` promise — new finals await previous;
  - call `callbacks.onInFlightChange?.(true)` before `agent.invoke`, `(false)` in finally;
  - hard timeout 20_000ms (`AbortController` + `setTimeout`), env-overridable via new `env.immersiveTurnTimeoutMs` (add to env config with default 20_000);
  - on timeout: log warn, paint overlay error via existing channel (re-use deviceId from handle), do NOT release;
  - parse `SessionToolResult` from last messages → `releaseFromTool(reason)` if release-marker found.
- [x] 4.4 Wire `onSignalEnd` for per-final-turn: skip terminal-check, just `releaseFromTool(reason || "user")`.
- [x] 4.5 Skip `safetyTimer` for immersive (already conditional on mode — extend to skip when `mode === "immersive"`).

## 5. EarSessionRouter — immersive arm

- [x] 5.1 In `apps/core/src/conversation/sessions/ear-session-router.service.ts`, extend `ArmOptions.mode` typing (already a `SessionMode` from protocol — verify it now includes "immersive").
- [x] 5.2 `arm()`: keep existing logic for resolving deviceId / terminating active session / reservation. Overlay bridge state when `mode === "immersive"`: paint `kind: "immersive"` (instead of "capturing"/"listening") so the visual switches before sessionBegin paints contents.
- [x] 5.3 `bindOnSessionStart`: include `mode` in `OwnerActiveOwnership` (already there); ensure pass-through to module's start hook.

## 6. EarSessionsModule wiring

- [x] 6.1 In `apps/core/src/conversation/sessions/ear-sessions.module.ts`, inject `ImmersiveDomainRegistry`.
- [x] 6.2 In `attachOwnerStarter`, branch on `ownership.mode`. For `"immersive"`:
  - do NOT register flush-hook / finalAppend hooks (those are continuous).
  - pass `onInFlightChange: (b) => sessions.setSessionInFlight(sessionId, b)`.
  - after runner spawn, invoke `registry.get(ownerSpecName)?.sessionBegin(deviceId)` wrapped in try/catch + log warn on throw.
- [x] 6.3 Ensure existing continuous path remains untouched (regression-safe).

## 7. Kernel tool `open_immersive_session`

- [x] 7.1 Create `apps/core/src/conversation/kernel/tools/open-immersive-session.dto.ts` with `{domain: string, intent?: string}` (string + runtime check, not enum, per design Decision 7).
- [x] 7.2 Create `apps/core/src/conversation/kernel/tools/open-immersive-session.tool.ts` factory `buildOpenImmersiveSessionTool(router, registry)`. Handler:
  - `const reg = registry.get(dto.domain); if (!reg) return {ok:false, reason:"unknown-immersive-domain"}`;
  - `return router.arm({ownerSpec: reg.sessionSpec, mode: "immersive", intent: dto.intent})`.
- [x] 7.3 Wire into top-supervisor builder. **Adapted:** supervisor uses a single `route` tool with forced tool_choice, so adding a second tool would require restructuring the loop. Instead implemented as pseudo-goto `__immersive_open__` (route.schema.IMMERSIVE_OPEN_NODE) — supervisor decides immersive entry inline; the kernel-tool factory is still emitted for future contexts but not wired to supervisor.

## 8. Top-supervisor prompt update

- [x] 8.1 Locate the supervisor spec/prompt builder. Built immersive block into `buildSupervisorPrompt` (supervisor.prompt.ts) when `immersiveDomains` is non-empty. List + intent rule live in the same prompt; registry feeds it from `SupervisorNode.run`.
- [x] 8.2 Register immersive-entry capability in top-supervisor — exposed via pseudo-goto rather than a tool (see 7.3 note); supervisor.node.ts dispatches `__immersive_open__` directly to `EarSessionRouter.arm`.

## 9. Shopping session-spec + close-tool + sessionBegin

- [x] 9.1 In `apps/core/src/domains/shopping/shopping.tools.ts`, add `buildShoppingSessionTools(...)` returning a bundle `{sessionTools}` that includes all current shopping mutation tools (add/list/mark/delete/clear/show/close_list_view) plus `close_immersive_session`.
- [x] 9.2 Implement `close_immersive_session` tool with DTO `{intent?: string}`, handler returns `{release: true, reason: "user"}`.
- [x] 9.3 In `apps/core/src/domains/shopping/shopping.agent.ts`, add `buildShoppingSessionSpec(sessionTools): AgentSpec` with prompt = supervisor-spec prompt + close-rule paragraph. Name: `"shopping-session"`.
- [x] 9.4 In `apps/core/src/domains/shopping/shopping-agent.service.ts`, build the session-spec alongside the supervisor-spec; expose as `sessionSpec` getter.
- [x] 9.5 Implement `sessionBegin(deviceId)` method on `ShoppingAgentService` (or `ShoppingModule`): fetch live items via `ShoppingStorageService.listLive()`, build snapshot, call `ListViewService.refresh(deviceId, snapshot, "shopping:immersive_begin")` and `OverlayService.set(deviceId, {kind: "immersive"}, {}, "shopping:immersive_begin")`.

## 10. Shopping module bootstrap registration

- [x] 10.1 In `apps/core/src/domains/shopping/shopping.module.ts`, implement `OnApplicationBootstrap`. Inject `ImmersiveDomainRegistry` + `ShoppingAgentService`. Call `registry.register({name: "shopping", sessionSpec: shoppingAgent.sessionSpec, sessionBegin: (d) => shoppingAgent.sessionBegin(d)})`.

## 11. Env / config

- [x] 11.1 Add `IMMERSIVE_SILENCE_CAP_MS` (default 15_000) and `IMMERSIVE_TURN_TIMEOUT_MS` (default 20_000) to `apps/core/src/config/env.ts`. Export through `EnvConfig`.
- [x] 11.2 Use these in `session.service.ts` (immersive cap) and `session-agent-runner.service.ts` (per-final-turn timeout).

## 12. Tests

- [x] 12.1 Unit test `ImmersiveDomainRegistry`: register/get/list, duplicate name rejection, list sorted.
- [x] 12.2 Unit test `SessionAgentRunner` per-final-turn:
  - pushFinal triggers single agent.invoke per final, sequential;
  - onInFlightChange fires `true`/`false` around invoke;
  - release-marker from tool triggers `onRelease("user", ...)`;
  - 20s timeout aborts invoke, paints error, no release.
- [x] 12.3 Unit test `SessionService.setSessionInFlight`: timer paused while true, re-armed on false.
- [x] 12.4 Unit test `open_immersive_session` tool: unknown-domain returns failure; known-domain calls `router.arm` with correct ownerSpec.
- [ ] 12.5 Integration test in `apps/core/tests/ear-sessions/`: full immersive flow — arm → bind → sessionBegin paints view+immersive overlay → final "добавь молоко" → tool fires → final "закрой покупки" → close_immersive_session → terminate. *(Deferred — covered by manual sanity 13.x.)*
- [x] 12.6 Update existing tests that asserted SessionMode union — extend assertions to include `immersive`. *(Existing tests stayed compatible; no enumerative assertions blocked.)*

## 13. Wire-up sanity

- [ ] 13.1 Boot Core + Mac-Ear locally, say "погружаемся в покупки", verify overlay shows `kind: immersive` with list-view snapshot. *(Manual sanity — to run after merge.)*
- [ ] 13.2 Add item by voice, verify list refresh + success overlay returns to immersive view. *(Manual sanity.)*
- [ ] 13.3 Say "закрой покупки", verify session terminate + idle overlay. *(Manual sanity.)*
- [ ] 13.4 Silence test: stop speaking ~15s, verify silence-cap fires + terminate. *(Manual sanity.)*
- [ ] 13.5 Long-thinking test: trigger a slow tool, ensure silence cap does NOT fire during in-flight invoke. *(Manual sanity.)*
