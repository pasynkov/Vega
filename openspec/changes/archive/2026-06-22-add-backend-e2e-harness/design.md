## Context

Today's backend test suite for `apps/core` is shaped like a pyramid that stops short of its apex: there is one thin "e2e" test (`tests/e2e/contract.e2e.test.ts`) that boots `AppModule`, replaces `EarGateway` with a no-op stub, replaces `DeepgramClient` with a no-op stub, replaces `DbService` with a tmp-sqlite copy, and replaces `@langchain/anthropic` + `@langchain/langgraph/prebuilt` via `vi.mock` to drive a single `ConversationService.handleTurn` call. The unit layer below is well-covered: `tests/agent-system/`, `tests/ear-sessions/`, `tests/overlay/`, `tests/notes/`, `tests/shopping/`, `tests/memory/`, `tests/long-note/`, `tests/conversation/`. Every test that historically caught a wire-only bug — the in-transition session drop, the wake-during-thinking yield, the arm-terminates-active race, the `handleTurn` serialization fix — lives at the unit layer and pokes a private surface that is easy to drift out of sync with reality.

The team's mental model of what the backend does is now stable enough to make this gap costly: every new domain (notes, shopping), every new mode (continuous, immersive, ask-user), every new overlay surface (orb, list-view) adds combinations that the current tests don't reach. The proposal here is to introduce one well-scoped layer above the unit suite that tests the system through the same socket.io wire the Mac/iOS Ear actually uses, with the LLM and the upstream STT boundary as the only mocks.

A second, equally important constraint is **reverse-TDD**: the harness exists to lock in current behavior, not to drive new behavior. Tests adapt to the implementation; bugs surfaced are recorded as failing tests and fixed in separate changes. This rules out designs that require pervasive new public methods on the production services to support test observability.

## Goals / Non-Goals

**Goals:**

- A test layer that exercises the real `EarGateway` over real `socket.io-server`, the real `SessionService` → real `RecordingStore` plumbing, the real kernel/graph/registries/sub-agent runtime, real overlay + list-view + tool execution, and real on-disk artifacts (sqlite, notes), with only the LLM and Deepgram boundaries replaced.
- A deterministic STT event surface: tests drive `partial_transcript`, `final_transcript`, `UtteranceEnd`, and Deepgram errors as discrete events. Production-code-visible behavior on each event is asserted both at the Core (downstream effects in `SessionService` / `ConversationService` / overlay) and at the wire (events the Ear receives back).
- A deterministic LLM surface: every test scripts the exact sequence of `route` decisions and sub-agent tool calls. A mismatch surfaces as a clear assertion failure ("expected route to X, supervisor went to Y"), not as a flaky timeout.
- Per-test isolation: every `it` boots a fresh Nest app on a fresh tmp root and disposes both at the end. No state bleeds between tests.
- Zero outbound network during test runs.
- A scenario catalog that grows by simply adding `it(...)` calls — no schema changes to the harness for a new scenario in an existing category.

**Non-Goals:**

- Replacing the unit suite. Existing tests stay where they are.
- Real Anthropic / real Deepgram smoke tests. Out of scope for this change.
- TTS. There is no TTS subsystem; reply assertions remain on the `handleTurn` return string. A future change can add a `TtsMock`.
- CI integration. Tests are local-only for now. A CI target is a separate change.
- Performance / load / soak tests.
- Driving the Ear apps (`apps/mac-ear`, `apps/ios-ear`) end-to-end. Those apps have their own test pyramid.
- Auto-discovering scenarios from spec text or recordings. Scenarios are hand-written.

## Decisions

### Decision: Wire-level e2e via real socket.io transport

**Choice:** The harness boots the real `EarGateway` on `EAR_WS_PORT=0` (ephemeral port) and the Fake Ear connects with `socket.io-client` to `ws://127.0.0.1:<port>/ear`.

**Why:** Every wire-only bug the project has shipped was a gateway/router interaction that the service-level test would have missed. Examples: in-transition drop (a session_start arriving while a previous session was tearing down), wake-during-thinking (wake_detected during an active capture should yield), arm-terminates-active (arm_capture for a different mode while an active session existed). These manifest at the dispatch layer — `EarGateway` → `SessionService` → `EarSessionRouter` — and are invisible to a test that calls `conversation.handleTurn(...)` directly. The cost of running real socket.io is small (~50–100 ms per test on top of Nest boot) and the bug-catching delta is high.

**Alternatives considered:**

- *Service-level e2e (current shape).* Reject: misses every gateway bug, requires the test to skip the wire entirely. The contract test already proves this — it cannot exercise `wake_detected`, `audio_frame`, `arm_capture`, or `session_end`-with-reason.
- *Hybrid (real gateway, in-process invocation that bypasses the socket).* Reject: socket.io semantics (binary frames, ack callbacks, namespace isolation) get bypassed; debugging "why doesn't my fake Ear see overlay_update" becomes a mix of "is the gateway wrong" and "is my in-process shim wrong". Use the real wire.
- *Live LLM + live Deepgram (full e2e).* Reject: flaky, slow, network-bound, expensive, non-deterministic. Useful as a separate smoke-test target later, but useless as a regression suite.

### Decision: Imperative `ScriptedLlm` over declarative dialog tree

**Choice:** Tests script the LLM imperatively as a typed FIFO queue:

```ts
llm.expectRoute({ goto: "notes", task: "save купить молоко" })
llm.expectSubAgent("notes", {
  toolCalls: [{ name: "save_short_note", args: { text: "купить молоко" } }],
  result: { status: "ok", summary: "saved" },
})
llm.expectRoute({ goto: "__end__" })
```

**Why:** Imperative scripting matches the "script the exact path" mental model: a test reads top-to-bottom as a transcript of what happens. When the graph takes the wrong branch, the very next assertion fails with a precise diff ("expected goto=notes, got goto=shopping"). Declarative maps ("when text matches X, route Y") hide the path the graph actually took inside the harness, making routing-bug investigations harder.

**Alternatives considered:**

- *Declarative dialog tree (`llm.script({ "запиши заметку купить молоко": { route: ..., notes: ..., end: true }})`).* Reject: shorter happy-path notation, worse failure mode. Routing bugs are precisely what we want to catch.
- *Pattern-matched router (`llm.on(/купить/, () => ({ goto: "notes", ... }))`).* Reject: hides the path entirely; a routing bug becomes "no pattern matched" instead of a specific routing assertion failure.

### Decision: Per-test fresh Nest app, per-test tmp root

**Choice:** Each `it` calls `scenarioBoot({ deviceId, caps })`, which builds a new Nest `Test.createTestingModule`, points `VEGA_DB_PATH` / `VEGA_NOTES_DIR` / `RECORDINGS_DIR` at a fresh `mkdtemp` directory, binds the gateway on port 0, returns `{ app, ear, dg, llm, tmpRoot }`. The `it` callback does its work and then calls `await scenarioTeardown(...)`, which disconnects the ear, closes the Nest app, and `rmSync` the tmp root.

**Why:** Isolation > speed. The historical alternatives the team considered (shared `beforeAll` + reset hooks; module-level mock state) both proved brittle in the contract test — `supervisorTurnIdx` and the `vi.mock` closure state are shared across `it` blocks and lead to "the previous test left the queue at index 2" failures. A per-test fresh app costs ~300 ms; with ~40 scenarios that is ~12 s, acceptable for local-only.

**Alternatives considered:**

- *Shared `beforeAll` Nest app + per-test reset hooks.* Reject: state bleeds. The kernel checkpointer (`SqliteSaver`) is per-`thread_id` so the same sessionId across tests is not safe; isolating it would require careful per-test prefix engineering that the harness should not need to know about.
- *Single fixture, single app, one giant `describe`.* Reject: failure of one scenario corrupts the next; impossible to bisect.

### Decision: Audio compromise — one real-bytes test, rest skip audio

**Choice:** `FakeEar.sessionStart({ mode, ...opts })` accepts a `skipAudio: boolean = true` default. When `skipAudio: false`, the test drives `await ear.sendAudio(buffer)` calls and the harness asserts the gateway sees them, `SessionService.forwardAudio` is hit, and `DeepgramClient.send` receives the bytes. `lifecycle.test.ts` has exactly one scenario that exercises this path. Every other scenario uses the default (`skipAudio: true`), starts the session, and drives `dg.simulateFinal(...)` directly to feed the transcript callbacks into `SessionService` without a single byte being sent.

**Why:** Real bytes through the wire prove the gateway → forward → Deepgram socket plumbing exists and is wired. But the bytes are opaque PCM; they do not produce a transcript by themselves (the real Deepgram does that, and the real Deepgram is what we are mocking). So in every other scenario, sending bytes is pure cost with no observable benefit — we still drive the transcript through `dg.simulateFinal`. One byte-pumping test is the cheapest way to lock in the plumbing without paying the cost in every scenario.

### Decision: Reverse-TDD enforcement via `it.todo` / `it.fails`

**Choice:** Scenarios SHALL be written for the implementation as it is, not as it should be. When a scenario surfaces a behavior the production code does not have (missing feature), the test is `it.todo(...)` with a one-line description and a TODO comment naming the change that would implement it. When a scenario surfaces a behavior the production code has but gets wrong (active bug), the test is `it.fails(...)` with a comment quoting the failing observation and an inline reference to the follow-up change. The harness itself MAY add new public methods to existing services ONLY when there is no other way to drive or observe them; such additions SHALL be the minimum surface and SHALL be flagged in the spec.

**Why:** The team explicitly wants this layer to lock in current behavior without driving a refactor pass through the production code. A test that fails because of a real bug is more valuable than a test that gets the bug "fixed" inside the harness with a workaround. `it.fails` is Vitest's native idiom for "this test is failing because the code is wrong; the assertion is the contract we want".

**Alternatives considered:**

- *Fix the bug as part of the test PR.* Reject: explicitly out of scope per the user's reverse-TDD constraint. Bug fixes belong in their own changes.
- *Skip the failing scenario.* Reject: a skipped test is a forgotten test; `it.fails` is the explicit "this is wrong and we know it" marker.

### Decision: Continuous-mode termination through `ScriptedLlm` only

**Choice:** Continuous-session termination is driven by the supervisor returning `{ goto: "__end__" }` (signaling the kernel that the user is done) in the test script. `FakeEar` SHALL NOT have a "stop word" affordance; tests script the LLM termination decision directly.

**Why:** In production, continuous-session termination IS the supervisor's decision (the team chose this earlier in exploration). A FakeEar-side stop word would diverge from the real path. Tests stay faithful to the production model.

### Decision: Ask-user is explicit, not auto

**Choice:** When the test invokes a tool that triggers `ask_user` → `arm_capture(ask)`, the Fake Ear does NOT auto-respond. The test SHALL explicitly call `await ear.waitArmCapture("ask")` followed by `await ear.sessionStart({ mode: "ask" })` and then drive the answer through `dg.simulateFinal(...)`. Tests that exercise ask-user timeout SHALL omit the `sessionStart` and wait for the timeout to fire.

**Why:** Letting the Fake Ear auto-respond would couple test setup to undocumented harness magic and would hide the ask-without-response timeout path. Explicit is debuggable.

### Decision: `VEGA_DISABLE_BOOT_PING` gates the only production-code change

**Choice:** Add a single env-gated short-circuit in three places — `LlmService.verifyAuth`, `LlmService.ping`, `DeepgramClient.verifyAuth`. When `VEGA_DISABLE_BOOT_PING=1` is set, each is a no-op. When unset, behavior is unchanged.

**Why:** The contract test today already sets `ANTHROPIC_API_KEY=sk-ant-api-test-stub` and `DEEPGRAM_API_KEY=test-deepgram-key`. These propagate into `LlmService.verifyAuth` and `DeepgramClient.verifyAuth`, both of which fire an outbound `fetch` at boot. A bad key produces a logged error but not a failure — so the contract test "works" but every run spams an error log and makes an outbound HTTPS request. The flag eliminates both. The alternative is per-test `vi.mock("node-fetch")` style trickery, which is invasive and fragile. A single boot-time env flag is honest and minimal.

### Decision: Tmp-root layout

**Choice:** Each scenario gets a `tmpRoot = mkdtempSync(join(tmpdir(), "vega-e2e-"))` and the harness sets:

```
VEGA_DB_PATH        = <tmpRoot>/vega.sqlite
VEGA_NOTES_DIR      = <tmpRoot>/notes
RECORDINGS_DIR      = <tmpRoot>/recordings
ANTHROPIC_API_KEY   = sk-ant-api-test-stub
DEEPGRAM_API_KEY    = test-deepgram-key
EAR_WS_HOST         = 127.0.0.1
EAR_WS_PORT         = 0
VEGA_DISABLE_BOOT_PING = 1
LOG_LEVEL           = fatal
```

Teardown `rmSync(tmpRoot, { recursive: true, force: true })`.

**Why:** Locked-down env, every artifact under one root, easy to assert on disk state inside the test (e.g. `expect(await readNoteFromDir(tmpRoot, /купить молоко/)).toBeTruthy()`), trivial to clean up. The existing `contract.e2e.test.ts` already uses this pattern; we just elevate it into the harness.

### Decision: Scenario file layout

**Choice:**

```
apps/core/tests/e2e/
├── harness/
│   ├── boot.ts            # bootTestApp + scenarioBoot/Teardown
│   ├── fake-ear.ts        # FakeEar (socket.io-client wrapper)
│   ├── fake-deepgram.ts   # FakeDeepgram (DeepgramClient override)
│   ├── scripted-llm.ts    # ScriptedLlm + vi.mock setup
│   └── waiters.ts         # waitFor(predicate, timeoutMs)
└── scenarios/
    ├── bootstrap.test.ts        # registry/flush-hooks contract (replaces contract.e2e.test.ts)
    ├── lifecycle.test.ts        # register/wake/start/end + ONE audio-byte test
    ├── stt-events.test.ts       # partial/final/utterance-end/error
    ├── notes.test.ts            # short + named notes
    ├── shopping.test.ts         # add/done/clear + list_view_update
    ├── continuous.test.ts       # open_continuous_session lifecycle
    ├── immersive.test.ts        # open_immersive_session lifecycle
    ├── ask-user.test.ts         # ask_user tool (answer, timeout, cancel)
    ├── overlay.test.ts          # update_overlay tool, ttl, seq
    └── errors.test.ts           # tool throws, dg error, malformed payload
```

A new scenario goes in the matching file as a new `it`. A new category file (e.g. `memory.test.ts` when the memory search domain reappears) is one file plus its `it` blocks; nothing in the harness changes.

### Decision: Surfacing existing seams; no new public test backdoors

**Choice:** The harness reuses existing seams: `Test.createTestingModule(...).overrideProvider(DeepgramClient).useValue(...)` for STT; `vi.mock("@langchain/anthropic", ...)` and `vi.mock("@langchain/langgraph/prebuilt", ...)` for LLM. It does NOT add `setSilenceCap`-style public methods to production services for test convenience. The contract test's pattern is essentially correct — the new harness factors it into building blocks and adds the wire layer.

**Why:** Reverse-TDD constraint. If the harness needs a new observation point that no other production caller needs, that is a smell — the test should observe the effect, not the internal state. The one acceptable exception is `VEGA_DISABLE_BOOT_PING`, which suppresses an outbound side effect rather than adding a new one.

## Risks / Trade-offs

- **Per-test boot cost.** ~300 ms × ~40 scenarios = ~12 s of e2e overhead. Mitigation: this is local-only; we accept it. If it becomes painful, the next change can introduce a shared-boot mode behind a flag.
- **socket.io flake.** Async event delivery and connection setup are race-prone. Mitigation: every test asserts via `await ear.waitFor*` with a default 2 s timeout (sufficient on a warm machine; CI not in scope). Each waiter logs the inbox contents on timeout for fast debugging.
- **LLM mock drift.** Real Anthropic and real `createReactAgent` evolve. Mitigation: the harness mocks the smallest possible surface — `ChatAnthropic.bindTools().invoke` and `createReactAgent({tools}).invoke` — and these have been stable for the duration of the project. If LangChain breaks this surface, the harness fails loudly and we update both call sites.
- **Reverse-TDD risk: tests document bugs forever.** `it.fails` tests become "the bug log". Mitigation: each `it.fails` has a comment naming the follow-up change; a project hygiene rule is that no `it.fails` lives past the next release without either being fixed or downgraded to `it.todo` with an explicit "won't fix" rationale.
- **Tmp-root cleanup on failed teardown.** A crashing test can leak a `/tmp/vega-e2e-*` directory. Mitigation: use `mkdtempSync` (always-unique) and trust the OS-level tmp eviction; the directories are small (sqlite + a few notes files).

## Migration Plan

1. Land the harness + `bootstrap.test.ts` + `lifecycle.test.ts` in one PR; verify the audio-byte scenario runs.
2. Land each scenario file as its own PR, growing the coverage incrementally. The catalog in the spec is the checklist.
3. Delete `tests/e2e/contract.e2e.test.ts` in the same PR that introduces `bootstrap.test.ts` (which subsumes its three assertions).
4. Triage any `it.fails` test created along the way as a separate change.

## Open Questions

- **TTS.** Currently out of scope. When TTS lands (a `TtsClient.speak(text)` or a Core → Ear `speak_audio` event), the harness will need a `TtsMock` peer to `FakeDeepgram`. This is a separate change.
- **CI.** Not in this change. When we want it, we will need to validate that `port:0` binding works in the CI runner and that the boot-ping flag suppresses every outbound call. Re-evaluate after the harness is in use locally for a release cycle.
- **Recordings.** `RecordingStore` writes session audio under `recordings/`. The harness currently lets it write into the tmp root and discards. If a future scenario wants to assert recording correctness, the harness will need a `recordings` inspection helper — out of scope for this change.
