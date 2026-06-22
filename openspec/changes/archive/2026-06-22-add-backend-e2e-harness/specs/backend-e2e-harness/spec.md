## ADDED Requirements

### Requirement: Wire-level e2e test harness boundary

The project SHALL provide a deterministic wire-level end-to-end test harness for `apps/core` rooted at `apps/core/tests/e2e/harness/`. The harness SHALL expose four building blocks as its only public API: `bootTestApp` (per-test Nest bootstrap with tmp-root artifact directories and ephemeral-port socket.io binding), `FakeEar` (a `socket.io-client` wrapper that speaks the `@vega/ear-protocol` event set), `FakeDeepgram` (a `DeepgramClient` override exposing externally-driven STT event injection), and `ScriptedLlm` (an imperative-queue LLM mock for both supervisor routing and sub-agent reactions).

Scenario files SHALL NOT reach into Nest internals, LangGraph internals, the `EarRegistry`, the `EarSessionRouter`, the `SessionService`, the `OverlayService`, the `ListViewService`, or any tool implementation directly. All observations and stimuli SHALL flow through the four building blocks. Direct dependencies into `apps/core/src/` from a scenario file are forbidden except for type imports and for asserting on-disk artifacts (notes files, sqlite rows) the test wrote.

#### Scenario: Scenario file imports only from the harness

- **WHEN** a contributor adds a new scenario file under `apps/core/tests/e2e/scenarios/`
- **THEN** that file SHALL import its app, ear, deepgram, and llm handles only via the harness building blocks
- **AND** SHALL NOT import any class from `apps/core/src/conversation/`, `apps/core/src/integrations/llm/`, `apps/core/src/integrations/deepgram/`, or `apps/core/src/conversation/ear/`

#### Scenario: Harness provides per-test fresh app

- **WHEN** a scenario calls `scenarioBoot(...)`
- **THEN** the harness SHALL create a fresh `mkdtemp` tmp root, set every artifact env var to a path under that root, build a new `Test.createTestingModule` with `DeepgramClient` and the LLM stubs overridden, and bind the gateway on an ephemeral port
- **AND** SHALL NOT reuse a Nest moduleRef from a previous scenario
- **AND** SHALL return `{ app, ear, dg, llm, tmpRoot, port }` to the caller

#### Scenario: Harness tears down without leaking resources

- **WHEN** a scenario calls `scenarioTeardown(ctx)`
- **THEN** the harness SHALL disconnect the Fake Ear's socket, close the Nest app, and recursively remove the tmp root
- **AND** SHALL NOT leave open sockets or running timers tied to the Nest app

### Requirement: Fake Ear speaks the full Ear→Core protocol

The harness SHALL provide a `FakeEar` class that connects to the test app's gateway via `socket.io-client` on the `/ear` namespace and exposes typed methods for every Ear→Core event in `@vega/ear-protocol` (`register`, `wake_detected`, `session_start`, `audio_frame`, `session_end`) and a typed inbox for every Core→Ear event (`ack`, `wake_ack`, `partial_transcript`, `final_transcript`, `overlay_update`, `list_view_update`, `arm_capture`, `session_end`, `session_mode`, `exception`).

`FakeEar.sessionStart(opts)` SHALL default `skipAudio` to `true`. When `skipAudio: true`, the helper SHALL emit `session_start` and SHALL NOT emit any `audio_frame` events; transcripts are driven via `FakeDeepgram` instead. When `skipAudio: false`, the helper SHALL allow the caller to drive `sendAudio(buf)` and SHALL forward the raw bytes through the wire.

Every `waitFor*` helper on `FakeEar` SHALL accept an optional `timeoutMs` and SHALL produce a diagnostic message naming the inbox slice that was inspected when the timeout fires.

#### Scenario: Fake Ear sees the ack after register

- **WHEN** a scenario calls `await ear.register()` against a freshly booted app
- **THEN** the harness SHALL emit a `register` event with `deviceId`, `deviceName`, `capabilities`
- **AND** SHALL resolve the call when the corresponding `ack` event arrives in the inbox

#### Scenario: Wake → overlay listening

- **WHEN** a scenario calls `await ear.wake({ score: 0.92 })` after registering
- **THEN** the harness SHALL emit `wake_detected` with the given score and an ISO-8601 timestamp
- **AND** the inbox SHALL receive `wake_ack` with `action: "proceed"`
- **AND** the inbox SHALL receive an `overlay_update` with `state.kind: "listening"` before the next user-facing event

#### Scenario: Real audio bytes flow end-to-end exactly once

- **WHEN** the `lifecycle.test.ts` audio-byte scenario sends N frames of size B via `await ear.sendAudio(buf)` against a `skipAudio: false` session
- **THEN** the harness SHALL deliver every byte through the real gateway to `FakeDeepgram.send`
- **AND** `FakeDeepgram.framesReceived(sessionIdx)` SHALL equal N and `bytesReceived(sessionIdx)` SHALL equal `N * B`
- **AND** no other scenario file SHALL invoke `ear.sendAudio` (audio plumbing is locked in by exactly one test)

### Requirement: Fake Deepgram drives STT events deterministically

The harness SHALL provide a `FakeDeepgram` class that replaces the production `DeepgramClient` provider in the test app. The replacement's `open(callbacks, sampleRate)` SHALL register the callbacks against the most-recently-opened session and return a session object whose `send(buf)` records bytes and whose `close()` updates session state.

`FakeDeepgram` SHALL expose: `simulatePartial(text)` invoking `callbacks.onPartial(text)`; `simulateFinal(text, confidence?)` invoking `callbacks.onFinal(text, confidence ?? null)`; `simulateUtteranceEnd()` invoking `callbacks.onUtteranceEnd()`; `simulateError(detail)` invoking `callbacks.onError(detail)`; `simulateClose()` invoking `callbacks.onClose()`. Each simulator SHALL invoke its callback synchronously and SHALL throw if no session has been opened.

`FakeDeepgram` SHALL NOT make any outbound network request. The `verifyAuth` behavior of the real `DeepgramClient` SHALL NOT be exercised against the test app.

#### Scenario: Partial → final → utterance end drives Core through the same path as production Deepgram

- **WHEN** a scenario opens a session and calls `dg.simulatePartial("куп")`, `dg.simulatePartial("купи")`, `dg.simulateFinal("купить")`, `dg.simulateUtteranceEnd()`
- **THEN** the Fake Ear's inbox SHALL receive `partial_transcript` events with text "куп" and "купи" in order
- **AND** SHALL receive a `final_transcript` event with text "купить"
- **AND** the Core's endpoint listener SHALL fire exactly once for this turn

#### Scenario: Deepgram error mid-utterance closes the session with `stt_error`

- **WHEN** a scenario opens a session and calls `dg.simulateError("transient")` without prior `simulateFinal`
- **THEN** the Fake Ear's inbox SHALL receive a Core→Ear `session_end` event with `reason: "stt_error"`
- **AND** the LLM script queue SHALL remain unconsumed for this turn

### Requirement: Scripted LLM uses an imperative queue with strict matching

The harness SHALL provide a `ScriptedLlm` class backed by an imperative FIFO queue. Tests SHALL push expected supervisor decisions via `expectRoute({goto, task?, speakText?})` and expected sub-agent reactions via `expectSubAgent(name, {toolCalls, result})`. The queue SHALL be consumed in arrival order: the next `route` call from the supervisor SHALL match the next `expectRoute` at the queue head; the next sub-agent invocation for domain `X` SHALL match the next `expectSubAgent(X, ...)` at the queue head.

Calling past the queue end SHALL throw a precise diagnostic ("ScriptedLlm: queue exhausted (expected route)" / "ScriptedLlm: queue exhausted (expected sub-agent for X)"). At the end of a test, calling `assertConsumed()` SHALL throw if the queue is non-empty, naming the remaining entries.

The supervisor mock SHALL replace `@langchain/anthropic`'s `ChatAnthropic.bindTools(...).invoke(messages)` at the boundary the supervisor node uses. The sub-agent mock SHALL replace `@langchain/langgraph/prebuilt`'s `createReactAgent({tools})` such that the returned agent's `invoke` method executes the scripted tool calls against the real tool list, then returns an `AIMessage` carrying the scripted `result` JSON.

#### Scenario: Supervisor goes off-script → immediate failure

- **WHEN** a scenario calls `expectRoute({goto: "notes", ...})` and the supervisor instead routes to `goto: "shopping"`
- **THEN** the test SHALL fail at the supervisor mock with a diagnostic naming both the expected and actual `goto` values
- **AND** SHALL NOT continue executing the rest of the script

#### Scenario: Sub-agent invokes a tool that the scripted result claims succeeded

- **WHEN** a scripted sub-agent has `toolCalls: [{name: "save_short_note", args: {text: "купить молоко"}}]` and `result: {status: "ok"}`
- **THEN** the harness SHALL invoke the real `save_short_note` tool with the given args inside the test's tool registry
- **AND** SHALL return an `AIMessage` carrying `JSON.stringify({status: "ok"})` to the supervisor
- **AND** SHALL surface any error the real tool throws as a test failure (not silently swallow it)

### Requirement: Scenario catalog

The harness SHALL be exercised by a scenario catalog under `apps/core/tests/e2e/scenarios/` covering at minimum the following categories. Each category SHALL be a single test file. New scenarios in an existing category SHALL be added as additional `it` blocks within the same file; a new category SHALL be a new file plus its `it` blocks with no harness change.

The catalog SHALL include:

- `bootstrap.test.ts` — AppModule boots; `AgentRegistry` contains `notes`; `AgentRegistry` does NOT contain `memory` / `memory_search`; `FlushHookRegistry` has a hook for `notes-session`. This file replaces and subsumes the deleted `tests/e2e/contract.e2e.test.ts`.
- `lifecycle.test.ts` — register/wake/start/end happy path; the single audio-byte scenario; register timeout; event-before-register; malformed payloads on `register` / `wake_detected` / `session_start` / `session_end`.
- `stt-events.test.ts` — partial → final → utterance end; multiple partials in order; final without utterance end resolves via silence cap; Deepgram error mid-utterance closes with `stt_error`; Deepgram close before any transcript closes cleanly.
- `notes.test.ts` — short-note save through the wire; named-note multi-turn via router-owned continuous session.
- `shopping.test.ts` — `add_item` → `list_view_update`; `mark_done` → `list_view_update`; `clear` → empty + collapsed; monotonic `seq` across multiple updates in one turn.
- `continuous.test.ts` — `open_continuous_session` lifecycle: arm → start → N turns → end via `goto:__end__`.
- `immersive.test.ts` — `open_immersive_session` lifecycle: arm → start → mode transitions visible on the wire → exit via `goto:__end__`.
- `ask-user.test.ts` — `ask_user` tool: (a) answered in time; (b) timeout; (c) cancelled (where supported).
- `overlay.test.ts` — `idle → listening → thinking → success → idle` paint sequence; `update_overlay` TTL returns to idle without terminating the active session; orb + view `seq` shared.
- `errors.test.ts` — tool throws inside `createReactAgent` → overlay error → clean session end; supervisor throws → overlay error → fallback session end; malformed `audio_frame` payload → ignored, active session unaffected.

#### Scenario: New category file adds no harness change

- **WHEN** a contributor adds a new scenario category (e.g. `memory.test.ts` when the memory search domain reappears) under `apps/core/tests/e2e/scenarios/`
- **THEN** the new file SHALL use the existing four harness building blocks unchanged
- **AND** SHALL NOT require new methods on `FakeEar`, `FakeDeepgram`, `ScriptedLlm`, or `bootTestApp` unless the corresponding production-code surface introduces a new event or new boundary

### Requirement: Reverse-TDD enforcement

Scenario authors SHALL write tests against the implementation as it is, not as it should be. Scenarios that surface a missing production feature SHALL be `it.todo(...)` with an inline comment naming the follow-up change candidate. Scenarios that surface an active production bug SHALL be `it.fails(...)` with an inline comment quoting the failing observation and naming the follow-up change candidate.

Scenario files SHALL NOT use `it.skip` to bypass failing scenarios; `it.fails` is the explicit "this is wrong and we know it" marker. Production code under `apps/core/src/` SHALL NOT be modified to make a scenario pass within the same diff that introduces the scenario, with the single exception of the `VEGA_DISABLE_BOOT_PING` flag covered in the `vega-core` capability delta.

The harness itself MAY add a new public method to an existing production service ONLY when there is no other way to drive or observe the behavior under test. Such additions SHALL be the minimum surface required, SHALL be documented in this spec under a "Test seams" subsection (added as it becomes necessary), and SHALL pass a code review that confirms no production caller will accidentally depend on them.

#### Scenario: A new feature requirement surfaces

- **WHEN** a scenario author writes a test for a behavior the production code does not yet implement
- **THEN** the test SHALL be `it.todo(description)` with a one-line code comment naming the follow-up change candidate
- **AND** SHALL NOT cause the test suite to fail

#### Scenario: An active production bug surfaces

- **WHEN** a scenario author writes a test that asserts the correct behavior of an existing feature but the production code currently violates that assertion
- **THEN** the test SHALL be `it.fails(description)` with a one-line code comment quoting the failing observation and naming the follow-up change candidate
- **AND** the test suite SHALL pass overall (Vitest counts a failing `it.fails` as passing)

#### Scenario: Author proposes a test-only public method

- **WHEN** a scenario author cannot drive or observe a behavior without adding a new public method to a production service
- **THEN** the proposal SHALL include an update to this spec's "Test seams" subsection naming the method, the production class, and the rationale
- **AND** SHALL NOT add the method to production code until the spec update is approved

### Requirement: Local-only execution, zero outbound network

A complete `vitest` run of the e2e scenario suite SHALL NOT make any outbound network request. The harness SHALL set `VEGA_DISABLE_BOOT_PING=1` in the test environment so the `LlmService.verifyAuth`, `LlmService.ping`, and `DeepgramClient.verifyAuth` paths become no-ops. The harness SHALL set `EAR_WS_HOST=127.0.0.1` and `EAR_WS_PORT=0` so the gateway binds to a loopback ephemeral port.

The harness SHALL NOT depend on a running Anthropic, Deepgram, or any other external service. Tests SHALL NOT require any secret or API key beyond the documented stub values (`ANTHROPIC_API_KEY=sk-ant-api-test-stub`, `DEEPGRAM_API_KEY=test-deepgram-key`) which are accepted by the harness purely to satisfy `EnvConfig` shape validation.

#### Scenario: Test run produces no outbound HTTP

- **WHEN** the e2e suite is executed against an offline machine
- **THEN** every scenario SHALL pass (modulo `it.fails` / `it.todo` semantics)
- **AND** no scenario SHALL hang waiting for an outbound response

#### Scenario: Boot ping is suppressed under the flag

- **WHEN** the harness boots the Nest app with `VEGA_DISABLE_BOOT_PING=1`
- **THEN** `LlmService.verifyAuth` SHALL not invoke `fetch`
- **AND** `LlmService.ping` SHALL not invoke the model
- **AND** `DeepgramClient.verifyAuth` SHALL not invoke `fetch`

### Requirement: Test seams registry

This requirement is the canonical registry of every new public method, property, or boundary the e2e harness has caused to be added to production services beyond the `VEGA_DISABLE_BOOT_PING` flag. Each entry SHALL name the production class, the new public surface, the scenario that forced it, and the rationale for not observing the behavior via an existing path. The registry is empty at the time of this spec's creation.

The intent of this registry is to keep the production-code surface honest under reverse-TDD: a test that drives a new method on a production service SHALL declare that fact here, in the same diff that adds the method, so future readers can see why the seam exists and when it can be removed.

#### Scenario: A test seam is added

- **WHEN** a contributor needs a new public method on a production service to drive or observe a scenario, and there is no other path to do so
- **THEN** the diff SHALL update this registry with the class name, the method signature, the scenario name, and a one-paragraph rationale
- **AND** the new method SHALL NOT be referenced by any production caller — it exists only for the harness

#### Scenario: A seam becomes unnecessary

- **WHEN** a production refactor removes the need for a previously listed seam
- **THEN** the diff SHALL remove the corresponding entry from this registry
- **AND** SHALL remove the now-unused method from the production service

(no entries at creation time)
