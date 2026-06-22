## Why

The backend has unit tests for individual services (notes, shopping, overlay, session router) and a single thin `tests/e2e/contract.e2e.test.ts` that boots `AppModule`, stubs the gateway and Deepgram, and exercises one `ConversationService.handleTurn` call. That contract test does not exercise the wire (socket.io transport, gateway dispatch, audio frame plumbing), does not exercise the STT event stream (`partial_transcript` / `final_transcript` / `UtteranceEnd` / Deepgram error), does not exercise the sub-agent → tool-call path through the live `createReactAgent`, and does not exercise any multi-turn arming flow (continuous, immersive, ask-user). The bugs we have historically caught only over the wire — in-transition session drops, wake-during-thinking yields, arm-terminates-active races, handleTurn serialization — would not be caught by today's tests.

The team wants to close this gap with a deterministic end-to-end test layer: real Nest app + real socket.io transport + real kernel/graph/tools/domains/overlay/list-view/checkpointer + real on-disk artifacts (sqlite, notes), with only the LLM and Deepgram boundaries replaced by scriptable test doubles. The goal is to cover every wire-visible scenario the product already supports today, and to make those scenarios green without changing business code — reverse-TDD: tests adapt to the existing implementation; bugs surfaced along the way are recorded as failing tests (`it.todo` / `it.fails`) and fixed in separate changes.

## What Changes

- Add a deterministic e2e harness at `apps/core/tests/e2e/harness/` with four building blocks: `bootTestApp` (a per-test Nest bootstrap that wires real providers + the three doubles below + tmp filesystem), `FakeEar` (a thin `socket.io-client` wrapper that speaks the full `@vega/ear-protocol` event set, exposes a typed inbox, and offers `await`-able waiters), `FakeDeepgram` (a `DeepgramClient` override exposing `simulatePartial / simulateFinal / simulateUtteranceEnd / simulateError / simulateClose` against the currently-open session), and `ScriptedLlm` (a `@langchain/anthropic` + `@langchain/langgraph/prebuilt` mock backed by an imperative queue: `expectRoute`, `expectSubAgent`, `assertConsumed`).
- Add a scenario catalog at `apps/core/tests/e2e/scenarios/` covering lifecycle (register/wake/start/end/disconnect), STT event semantics (partial/final/utterance-end/error), domain flows (notes short + named, shopping add/done/clear), mode flows (continuous, immersive, ask-user), overlay (idle→listening→thinking→success cycle, `update_overlay` tool TTL behavior, monotonic `seq`), and error paths (tool throws, Deepgram mid-utterance error, malformed payload).
- Use **reverse-TDD**: do not modify business code to make tests pass. Where a scenario surfaces a real bug, record it as `it.todo` (unimplemented behaviour) or `it.fails` (active regression) with an inline reference to the failing observation, and open a follow-up change for the fix. The harness itself MAY add new public methods to existing services ONLY when there is no other way to drive or observe them; such additions SHALL be the minimum surface and SHALL be flagged in the spec.
- Audio handling compromise: exactly one scenario (`lifecycle.test.ts`) emits real `audio_frame` events with non-empty `Buffer` payloads end-to-end through gateway → `SessionService.forwardAudio` → `DeepgramClient.send`. Every other scenario passes `{ skipAudio: true }` on session start and drives `FakeDeepgram.simulate*` directly to exercise the same SessionService callbacks without round-tripping bytes.
- Per-test fresh app: each `it` boots a new Nest moduleRef. There is no shared `beforeAll` Nest app across `it` blocks. State (sqlite rows, notes files, recordings dir, registries) is isolated by a per-test tmp root.
- Local-only execution: tests SHALL NOT require network. The LLM and STT boundary stubs replace both inference and the boot-time `verifyAuth` `fetch` calls; a `VEGA_DISABLE_BOOT_PING=1` env variable SHALL gate the existing `LlmService.ping` and the `DeepgramClient` / `LlmService` `verifyAuth` calls so a clean test run produces no outbound network traffic. This is the only intentional production-code change in this proposal, and is gated to test runs.
- Delete `apps/core/tests/e2e/contract.e2e.test.ts` — its coverage is fully subsumed by `bootstrap.test.ts` + `notes.test.ts` in the new layout.

## Capabilities

### New Capabilities

- `backend-e2e-harness`: A deterministic wire-level end-to-end test harness for `apps/core`. Provides per-test Nest bootstrap with tmp-root artifact directories, a socket.io-client fake Ear with typed inbox and waiters, a Deepgram client replacement with externally-driven STT event injection, and an imperative scripted LLM that lets a test assert the exact sequence of supervisor routing decisions and sub-agent tool calls. The harness boundary is stable: the four building blocks (`bootTestApp`, `FakeEar`, `FakeDeepgram`, `ScriptedLlm`) are the only public API; scenario files SHALL NOT reach into Nest internals or LangGraph internals directly.

### Modified Capabilities

- `vega-core`: Adds a single boot-time-only env flag (`VEGA_DISABLE_BOOT_PING`) that short-circuits the `LlmService.ping` and the boot-time `verifyAuth` `fetch` calls in both `LlmService` and `DeepgramClient`. Default unset → existing behavior unchanged. Set → boot completes without any outbound HTTPS request. No other behavior change.

## Impact

- Code touched in `apps/core/src/` is minimal: only `LlmService` and `DeepgramClient` get the `VEGA_DISABLE_BOOT_PING` env gate. No changes to gateway, kernel, supervisor, sub-agent factory, sessions, overlay, list-view, tools, or domains.
- New tree: `apps/core/tests/e2e/harness/` (~5 files) and `apps/core/tests/e2e/scenarios/` (~8–9 files). Deleted: `apps/core/tests/e2e/contract.e2e.test.ts`.
- Test runtime: per-test fresh Nest boot is ~300 ms; with ~40 scenarios this is ~12 s of e2e on top of the existing unit suite. Acceptable for local; no CI target in this change.
- Dependency adds: `socket.io-client` as a dev dependency in `apps/core` (already a transitive dep but should be declared at root for the fake Ear). No production deps added.
- Out of scope: TTS (no TTS subsystem exists yet; reply assertions remain on the `handleTurn` return string), CI integration, performance/load tests, real-Anthropic / real-Deepgram smoke tests.
