# conversation Specification

## Purpose

The `conversation` capability is Vega's turn-handling entry point. It owns the session lifecycle, the LangGraph `SqliteSaver` checkpointer that persists conversation state across Core restarts, and the `ConversationService.handleTurn` method that downstream transports (a future ear-protocol bridge, a Telegram bot, a chat UI, the in-repo test harness) call to drive one user-to-assistant exchange through the orchestration graph.

The capability is deliberately transport-agnostic. It does not know about Deepgram, ear-protocol messages, or HTTP. Its job is to be the one stable seam through which words enter and leave the LLM layer.

## Requirements

### Requirement: `ConversationService.handleTurn` is the only entry point into the graph

The orchestration graph SHALL be invoked exclusively through `ConversationService.handleTurn(sessionId: string, userText: string): Promise<string>`. No other code SHALL call `compiledGraph.invoke` directly.

The method SHALL:

1. Resolve the session via `SessionRegistry`, creating its metadata row if absent;
2. Load checkpointed state for `sessionId` from the `SqliteSaver`;
3. Append a `HumanMessage(userText)` to `state.messages`;
4. Invoke the compiled graph with a config carrying `{configurable: {thread_id: sessionId}}` so the checkpointer scopes to the right session;
5. Extract the final spoken reply from the resulting state (the most recent `AIMessage` content from the supervisor's `goto: "__end__"` step);
6. Return that string.

#### Scenario: First turn on a new session

- **WHEN** `handleTurn("default", "привет")` is called and no checkpoint exists for `"default"`
- **THEN** the service SHALL create the session in `SessionRegistry`
- **AND** the checkpointer SHALL persist a fresh state at the end of the turn
- **AND** the method SHALL resolve with the supervisor's spoken reply

#### Scenario: Follow-up turn on an existing session

- **WHEN** `handleTurn("default", ...)` is called and a checkpoint already exists for `"default"`
- **THEN** the prior conversation history SHALL be loaded into state before the user's new message is appended
- **AND** the supervisor SHALL see the full conversation when routing

### Requirement: `SqliteSaver` checkpointer is bound to `VEGA_DB_PATH`

The `SqliteSaver` SHALL persist its tables in the same SQLite database file as the `Memory` table. The checkpointer SHALL be constructed exactly once at boot and injected into the graph factory.

#### Scenario: Restart preserves the conversation

- **WHEN** Core completes a turn, then exits cleanly, then restarts, then `handleTurn` is called with the same `sessionId`
- **THEN** the supervisor SHALL see the prior conversation history
- **AND** the supervisor MAY refer back to facts established before the restart

#### Scenario: Two concurrent turns on the same session

- **WHEN** a transport invokes `handleTurn(sessionId, ...)` while a previous `handleTurn(sessionId, ...)` is still in flight
- **THEN** the second invocation SHALL wait for the first to complete before starting (per-session serialization)
- **AND** the implementation SHALL use a per-session lock; the MVP MAY use an in-process `Map<sessionId, Promise>` since there is only one Core process

### Requirement: `SessionRegistry` reserves multi-session shape

`SessionRegistry` SHALL exist as a NestJS service exposing `get(sessionId)`, `create(sessionId)`, `touch(sessionId)`, and `list()`. The MVP SHALL only ever be called with the literal `"default"` sessionId, but the methods SHALL accept arbitrary strings so that a future multi-session change is a behavior change rather than an API change.

Session metadata SHALL include `id`, `createdAt`, `lastActiveAt`. It SHALL NOT include user identity or device identity in this change; the existing `userId` slot on the ear-protocol stays where it is, unconnected to sessions, until a future change ties them together.

#### Scenario: Touching a session updates last-active

- **WHEN** `handleTurn` is called for an existing session
- **THEN** the registry's `lastActiveAt` for that session SHALL be updated to the moment the turn started
- **AND** the timestamp SHALL be persisted across restarts (registry rows live in the same SQLite database)

### Requirement: Spoken reply is the only return value

`handleTurn` SHALL return exactly the spoken reply string. Any structured side-effects (memories written, tools called, sub-agents engaged) SHALL be observable via logs and via the SQLite database, but SHALL NOT be part of the return shape.

A future transport that needs structured detail (e.g. "this turn resulted in a memory write of id X") SHALL motivate a separate richer entry point in its own change; the simple-string contract SHALL stay stable.

#### Scenario: Turn produces no spoken text

- **WHEN** the supervisor decides `goto: "__end__"` with an empty or missing `speakText`
- **THEN** `handleTurn` SHALL resolve with the empty string
- **AND** the caller SHALL be free to interpret this as silence (skip TTS, skip rendering)

### Requirement: Turn-level error containment

Any thrown error from inside the graph (model network failure, tool exception, checkpointer write failure) SHALL be caught by `ConversationService` and converted into a fallback spoken reply describing the failure in user-friendly Russian (e.g. "Сейчас не могу ответить, попробуй ещё раз"). The original error SHALL be logged at `error` level with stack trace and `sessionId`.

#### Scenario: Anthropic API is temporarily unreachable

- **WHEN** the supervisor's LLM call rejects with a network error
- **THEN** `handleTurn` SHALL log the error
- **AND** SHALL return the fallback spoken reply
- **AND** SHALL persist the user's message into the checkpoint so the follow-up turn still sees the question

### Requirement: `ConversationModule` SHALL be the single public-facing module for domains

`ConversationModule` SHALL be marked `@Global()` and SHALL re-export every other module under `conversation/` whose providers a domain might legitimately inject (kernel registries, session-control services, flush-hook registry). A domain module that does `imports: [ConversationModule]` SHALL be able to inject `AgentRegistry`, `FlushHookRegistry`, and any other service the kernel chooses to expose, without naming any pipeline module in its own `imports:` array.

A domain module under `apps/core/src/domains/` SHALL import **only** `ConversationModule` from the pipeline in its `@Module({ imports: [...] })` array. The forbidden tokens in a domain module's `imports:` array are `EarModule`, `EarSessionsModule`, `AgentSystemModule`, `SupervisorModule`, or any future pipeline module. Type-only references to specific service classes (e.g. `private sessions: SessionService`) are permitted — the contract is about the `@Module({ imports: [...] })` graph, not TypeScript type references.

#### Scenario: A domain module wires itself up

- **WHEN** a domain module declares `@Module({ imports: [ConversationModule] })` and injects `AgentRegistry` and `FlushHookRegistry` into its constructor
- **THEN** NestJS DI SHALL resolve both services without error
- **AND** the domain's `OnModuleInit` SHALL be able to call `AgentRegistry.register(spec)` and `FlushHookRegistry.set(name, hook)` against the same instances the orchestration kernel uses at runtime

#### Scenario: A domain module attempts to import the ear pipeline

- **WHEN** a domain module's `@Module({ imports: [...] })` array contains `EarModule`, `EarSessionsModule`, `AgentSystemModule`, or `SupervisorModule`
- **THEN** the change SHALL be rejected at code review as a violation of the domain-isolation contract
- **AND** the domain SHALL be rewritten to obtain those providers via `imports: [ConversationModule]` instead


### Requirement: `ConversationService.handleTurn` SHALL serialize per-session

`ConversationService.handleTurn(sessionId, userText)` SHALL guarantee that for any given `sessionId`, at most one `runTurn` is executing at a time. If `handleTurn` is invoked while a prior turn for the same `sessionId` is still in flight, the new invocation SHALL be queued and SHALL run after every previously-queued turn for that session has settled (resolved or rejected). The queue SHALL preserve arrival order.

The implementation SHALL NOT use the inflight-read-then-set pattern; that pattern races when two callers read the same `prior` promise and both create their own `current` after `prior` settles, causing concurrent `runTurn` invocations. Instead, each caller SHALL append its work onto the *latest* per-session chain head (typically `tail = tail.then(() => runTurn(...))`).

A turn that throws or rejects SHALL NOT block subsequent queued turns; the chain SHALL continue with the next turn.

#### Scenario: Two concurrent finals on the same session

- **WHEN** `handleTurn("S", "Так,")` is invoked while `handleTurn("S", "это у нас")` is still in flight
- **THEN** the second invocation SHALL NOT start its `runTurn` until the first invocation's `runTurn` has settled
- **AND** at no point SHALL two `runTurn` calls for the same `sessionId` be active concurrently

#### Scenario: Three queued turns in arrival order

- **WHEN** `handleTurn("S", "first")`, `handleTurn("S", "second")`, and `handleTurn("S", "third")` are invoked back-to-back
- **THEN** the three `runTurn` calls SHALL execute in the order `first` → `second` → `third`
- **AND** each turn's `lastAgentResult` and supervisor checkpoint state SHALL be visible to the next turn

#### Scenario: A turn rejects

- **WHEN** the first turn in the per-session queue throws inside `runTurn`
- **THEN** the rejection SHALL be caught by the chain's error handler and SHALL NOT prevent the next queued turn from running
- **AND** the rejecting turn's caller SHALL still see the rejection as a rejected promise

### Requirement: First-final wake-word filter SHALL drop wake-only utterances

The transcript fanout that drives `ConversationService.handleTurn` (currently `EarSessionsModule.addTranscriptListener`) SHALL recognise the very first `final_transcript` of each wake-driven session and SHALL drop it if its trimmed, lower-cased text matches a configured wake-word vocabulary (case-insensitive substring or whole-word equality, depending on the matcher). The vocabulary SHALL be a Core-side configurable list whose MVP value covers the OpenWakeWord candidates `Janet` and `edna` along with their common Cyrillic / Russian-phonetic transliterations (e.g. `Этна`, `Эдна`, `Джанет`).

A dropped wake-only final SHALL NOT invoke `ConversationService.handleTurn`; instead the listener SHALL log it at info level (`Dropping wake-only first final: <text>`) and continue. Subsequent finals on the same session SHALL be processed normally. The filter SHALL apply only to the FIRST final of each session — once any non-wake final has been processed, subsequent finals SHALL be passed through without checking the vocabulary.

#### Scenario: First final is the wake word transliteration

- **WHEN** a wake-driven session opens and the first `final_transcript` carries the text `"Этна."`
- **THEN** the transcript fanout SHALL drop the final
- **AND** SHALL NOT invoke `ConversationService.handleTurn`
- **AND** SHALL log `Dropping wake-only first final: Этна.`

#### Scenario: First final is real user speech

- **WHEN** a wake-driven session opens and the first `final_transcript` carries `"Давай запишем большую заметку."`
- **THEN** the transcript fanout SHALL pass the final to `ConversationService.handleTurn` unchanged
- **AND** the wake-word filter SHALL NOT short-circuit subsequent finals for the same session

#### Scenario: Second final is a wake word transliteration

- **WHEN** a session has already processed one non-wake final and a subsequent `final_transcript` happens to match `"Этна."`
- **THEN** the transcript fanout SHALL pass the final to `ConversationService.handleTurn` (the filter applies only to the FIRST final per session)
