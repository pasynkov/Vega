## 1. Production-code change: boot-ping suppression

- [x] 1.1 Add `llmDisableBootPing` (or generic `vegaDisableBootPing`) boolean to `EnvConfig` (`apps/core/src/config/env.ts`), defaulting to `false`, sourced from `VEGA_DISABLE_BOOT_PING=1`
- [x] 1.2 Gate `LlmService.verifyAuth` and `LlmService.ping` (`apps/core/src/integrations/llm/llm.module.ts`) so both become no-ops when the flag is set
- [x] 1.3 Gate `DeepgramClient.verifyAuth` (`apps/core/src/integrations/deepgram/deepgram.client.ts`) so it becomes a no-op when the flag is set
- [x] 1.4 Verify with an existing unit test (or new tiny one) that a Nest boot with the flag set produces zero outbound `fetch` calls
- [x] 1.5 Confirm there is no other boot-time outbound network call by grepping for `fetch(` and `new WebSocket(` in `apps/core/src/` and excluding the audio-time Deepgram `open()` socket

## 2. Harness scaffolding

- [x] 2.1 Create `apps/core/tests/e2e/harness/boot.ts` exporting `scenarioBoot({deviceId, caps})` and `scenarioTeardown(ctx)`; `scenarioBoot` creates tmp root, sets env, builds `Test.createTestingModule(...).overrideProvider(DeepgramClient).useValue(fakeDg).compile()`, binds the gateway on `EAR_WS_PORT=0`, returns `{ app, ear, dg, llm, tmpRoot, port }`
- [x] 2.2 Create `apps/core/tests/e2e/harness/fake-ear.ts` exporting `FakeEar` (constructed against a `port`); methods: `register`, `wake`, `sessionStart({mode, skipAudio?, sampleRate?, codec?})`, `sendAudio(buf)`, `sessionEnd({reason})`, `disconnect`; inbox: `overlay[]`, `listView[]`, `armCapture[]`, `partial[]`, `final[]`, `sessionEnd[]`, `sessionMode[]`, `wakeAck[]`, `ack[]`, `exception[]`; waiters: `waitAck`, `waitOverlay(pred)`, `waitListView(pred)`, `waitFinal(pred)`, `waitPartial(pred)`, `waitArmCapture(mode?)`, `waitSessionEnd(reason?)`, `waitSessionMode(mode?)`; every waiter accepts an optional `timeoutMs` and logs the relevant inbox slice on timeout
- [x] 2.3 Create `apps/core/tests/e2e/harness/fake-deepgram.ts` exporting `FakeDeepgram` (implements `DeepgramClient` shape: `open(callbacks, sampleRate)` returns `{ send(buf), close() }`); maintains per-session state; methods to drive: `simulatePartial(text)`, `simulateFinal(text, confidence?)`, `simulateUtteranceEnd()`, `simulateError(detail)`, `simulateClose()`; inspection: `openSessions[]` (the callbacks + sampleRate at open), `currentSession`, `bytesReceived(sessionIdx)`, `framesReceived(sessionIdx)`
- [x] 2.4 Create `apps/core/tests/e2e/harness/scripted-llm.ts` exporting `ScriptedLlm` and an `installLlmMocks(llm)` function that registers `vi.mock("@langchain/anthropic", ...)` and `vi.mock("@langchain/langgraph/prebuilt", ...)` to read from the `llm` queue; queue API: `expectRoute({goto, task?, speakText?})`, `expectSubAgent(name, {toolCalls, result})`, `assertConsumed()`, `assertEmpty()`, `lastPrompt()`; the supervisor mock SHALL throw "ScriptedLlm: queue exhausted (expected route)" when called past the queue end; the sub-agent mock SHALL throw "ScriptedLlm: queue exhausted (expected sub-agent for X)" when called past the queue end
- [x] 2.5 Create `apps/core/tests/e2e/harness/waiters.ts` exporting `waitFor<T>(pred: () => T | undefined, opts?: {timeoutMs?: number; intervalMs?: number; onTimeout?: () => string}): Promise<T>`; default `timeoutMs=2000`, `intervalMs=10`; on timeout throws with the `onTimeout()` diagnostic appended
- [x] 2.6 Document the harness in a top comment in `boot.ts` (no separate README): four building blocks, what is real, what is mocked, the two test-only assumptions (port:0 binding, `VEGA_DISABLE_BOOT_PING=1`)

## 3. Bootstrap scenario (replaces existing contract test)

- [x] 3.1 Add `apps/core/tests/e2e/scenarios/bootstrap.test.ts` covering: AppModule boots cleanly under the harness; `AgentRegistry` contains the `notes` domain; `AgentRegistry` does NOT contain `memory` or `memory_search`; `FlushHookRegistry` has a hook for `notes-session`
- [x] 3.2 Delete `apps/core/tests/e2e/contract.e2e.test.ts` in the same diff

## 4. Lifecycle scenario (the audio-byte flow)

- [x] 4.1 Add `apps/core/tests/e2e/scenarios/lifecycle.test.ts`
- [x] 4.2 Scenario: `register` → server emits `ack` with the same `deviceId`
- [x] 4.3 Scenario: `register` followed by no `wake_detected` and no `session_start` → no further events; clean disconnect
- [x] 4.4 Scenario (the ONE audio-byte test): `register` → `wake_detected` → `wake_ack(proceed)` → `session_start(regular)` → `sendAudio` with 5 frames of 320-byte int16 buffers → assert `FakeDeepgram.framesReceived(0) === 5` and `bytesReceived(0) === 1600` → `dg.simulateFinal("hello")` → `ear.waitFinal("hello")` → `ear.sessionEnd({reason: "user"})` → server cleans up, no exception
- [x] 4.5 Scenario: connect, do not send `register` within 2 s → server disconnects the socket (validates `REGISTER_TIMEOUT_MS` behavior)
- [x] 4.6 Scenario: any event before `register` → server disconnects the socket (validates `warnUnregistered`)
- [x] 4.7 Scenario: send malformed payloads to `register`, `wake_detected`, `session_start`, `session_end` → server logs warn and does NOT crash or disconnect

## 5. STT events scenario

- [x] 5.1 Add `apps/core/tests/e2e/scenarios/stt-events.test.ts`
- [x] 5.2 Scenario: partial → final → utterance-end → `ConversationService` handles the final and the LLM script consumes one `route` decision; Ear receives `partial_transcript` and `final_transcript`
- [x] 5.3 Scenario: multiple partials before the final → Ear receives each `partial_transcript` in order
- [x] 5.4 Scenario: final WITHOUT utterance-end (regular short-turn endpoint via Core's own timer) → session still resolves via the silence cap
- [x] 5.5 Scenario: `dg.simulateError("...")` mid-utterance → Ear receives `session_end` with `reason: "stt_error"`; LLM queue NOT consumed
- [x] 5.6 Scenario: `dg.simulateClose()` before any transcript → Ear receives `session_end` cleanly

## 6. Notes domain scenarios

- [x] 6.1 Add `apps/core/tests/e2e/scenarios/notes.test.ts`
- [x] 6.2 Scenario: short-note save (the contract-test equivalent at wire level): `dg.simulateFinal("запиши заметку купить молоко")` → supervisor routes to `notes` → sub-agent calls `save_short_note` → server emits overlay `success` → note file exists under `<tmpRoot>/notes/` matching `/купить молоко/`
- [x] 6.3 Scenario: named-note multi-turn (router-owned session): supervisor calls `open_named_note(...)` → server emits `arm_capture(continuous)` → Ear `sessionStart({mode:"continuous"})` → multiple finals → supervisor returns `goto:__end__` → router releases → server emits `session_end`

## 7. Shopping domain scenarios

- [x] 7.1 Add `apps/core/tests/e2e/scenarios/shopping.test.ts`
- [x] 7.2 Scenario: `add_item` tool call → Ear receives `list_view_update` with the new item and monotonically increasing `seq`
- [x] 7.3 Scenario: `mark_done` tool call → Ear receives `list_view_update` with `done: true` for the item id
- [x] 7.4 Scenario: `clear` tool call → Ear receives `list_view_update` with `items: []` and `open: false`
- [x] 7.5 Scenario: multiple updates in one turn → `seq` monotonic, no skips

## 8. Mode flow scenarios

- [x] 8.1 Add `apps/core/tests/e2e/scenarios/continuous.test.ts` covering: `open_continuous_session` tool call → `arm_capture(continuous)` → Ear `sessionStart({mode:"continuous"})` → N finals interleaved with `expectRoute({goto:"<domain>"})` → final `expectRoute({goto:"__end__"})` triggers session end
- [x] 8.2 Add `apps/core/tests/e2e/scenarios/immersive.test.ts` covering: `open_immersive_session` → `arm_capture(immersive)` → mode transitions visible via `sessionMode` events → exit via `goto:__end__`
- [x] 8.3 Add `apps/core/tests/e2e/scenarios/ask-user.test.ts` covering: tool calls `ask_user` → server emits `arm_capture(ask)`; (a) Ear `sessionStart({mode:"ask"})` and `dg.simulateFinal("answer")` → answer routes back to caller via the sub-agent script; (b) Ear ignores the arm → after ask timeout, server emits `session_end` and sub-agent returns timeout outcome; (c) cancel path (if applicable to the existing tool surface)

## 9. Overlay scenario

- [x] 9.1 Add `apps/core/tests/e2e/scenarios/overlay.test.ts`
- [x] 9.2 Scenario: full short-turn paint sequence: `idle → listening → thinking → success → idle` with monotonic `seq`
- [x] 9.3 Scenario: `update_overlay` tool with a TTL → after TTL the overlay returns to `idle` but the active session is NOT terminated (regression guard for `overlay_ttl_idle`)
- [x] 9.4 Scenario: tool emits `update_overlay({kind: "view"})` (shopping case) → `seq` shared with regular overlay updates, no resets

## 10. Error path scenarios

- [x] 10.1 Add `apps/core/tests/e2e/scenarios/errors.test.ts`
- [x] 10.2 Scenario: a tool throws inside `createReactAgent` → supervisor receives `status: "error"` → overlay paints `error` → session_end clean
- [x] 10.3 Scenario: the LLM (supervisor) throws → overlay paints `error` → session_end with `reason: "stt_error"` or appropriate fallback (assert what the production code actually does today)
- [x] 10.4 Scenario: malformed `audio_frame` payload (not a `[string, Buffer]` tuple) → server ignores and continues, the active session is unaffected

## 11. Reverse-TDD bug log

- [x] 11.1 For each `it.fails` and `it.todo` introduced while writing scenarios, add a one-line code comment naming the follow-up change candidate (e.g. `// TODO(change: fix-ask-cancel-timing): supervisor receives the cancel before the answer routes back`)
- [x] 11.2 Add a short paragraph to the spec scenario catalog noting which scenarios are currently `it.fails` / `it.todo` (do not modify the catalog itself — the spec lists what SHALL be covered, the scenario files document the current state)

## 12. Validation

- [x] 12.1 `openspec validate add-backend-e2e-harness --strict` passes
- [x] 12.2 Local run: `pnpm --filter @vega/core test tests/e2e` (or the project's equivalent) completes; passing tests pass, `it.fails` / `it.todo` are listed as such
- [x] 12.3 `git grep -n "VEGA_DISABLE_BOOT_PING"` shows the flag wired into both `LlmService` and `DeepgramClient` and nowhere else
- [x] 12.4 Confirm `apps/core/tests/e2e/contract.e2e.test.ts` is deleted in the diff
- [x] 12.5 Spot-check: there is no `it.skip` in `tests/e2e/scenarios/`; every failing test is `it.fails` or `it.todo` with a comment
