# conversation Specification

## Purpose

The `conversation` capability is Vega's turn-handling entry point. It owns the session lifecycle, the LangGraph `SqliteSaver` checkpointer that persists conversation state across Core restarts, and the `ConversationService.handleTurn` method that downstream transports (a future ear-protocol bridge, a Telegram bot, a chat UI, the in-repo test harness) call to drive one user-to-assistant exchange through the orchestration graph.

The capability is deliberately transport-agnostic. It does not know about Deepgram, ear-protocol messages, or HTTP. Its job is to be the one stable seam through which words enter and leave the LLM layer.

## ADDED Requirements

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
