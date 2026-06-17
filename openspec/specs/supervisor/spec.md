# supervisor Specification

## Purpose

The `supervisor` capability is the central routing brain of Vega's LLM layer. It owns the main LangGraph `StateGraph`, the supervisor node that picks a domain (or chooses to speak directly), the conversation-state shape every node mutates, and a deterministic pre-supervisor step that primes the state with memory hints.

The supervisor exists so that every domain sub-agent can stay focused on its own ~3–5 tools while the overall system still handles utterances that span domains or that don't need a domain at all ("сколько времени").

## Requirements

### Requirement: Conversation state shape

The main graph SHALL use a single typed state object built via LangGraph's `Annotation.Root`. The state SHALL contain exactly the following fields and no more in the MVP:

- `messages` — the conversation history, via `MessagesAnnotation.spec.messages`;
- `sessionId: string` — the active session's id (hard-coded to `"default"` in the MVP);
- `activeContext: { lastDomain?: string; lastEntityIds: Record<string, string> }` — multi-turn context the supervisor may use when interpreting ambiguous follow-ups ("ответь да");
- `memoryHints: string[]` — top-K facts pulled before routing;
- `lastAgentResult?: AgentOutput` — the most recent sub-agent's structured output, available to the supervisor when chaining domains.

Adding a new field to the state SHALL require a deliberate change. Sub-agent local state SHALL NOT leak into this shape.

#### Scenario: Sub-agent returns a result the supervisor needs to chain on

- **WHEN** a sub-agent returns `AgentOutput` with non-empty `data`
- **THEN** the sub-agent node SHALL set `lastAgentResult` on the state via `Command.update`
- **AND** the next supervisor invocation SHALL see that value
- **AND** the supervisor MAY include the value in the task string it sends to the next sub-agent

### Requirement: Pre-supervisor memory pull

Before every supervisor invocation, a deterministic `pre-supervisor` node SHALL populate `state.memoryHints` by calling `MemoryService.searchTopK(latestUserMessage, 5)`. The pre-supervisor node SHALL NOT invoke an LLM; it SHALL be a side-effect-light deterministic step.

#### Scenario: Turn begins with no relevant memory

- **WHEN** the user's message produces zero matches via `MemoryService.searchTopK`
- **THEN** `state.memoryHints` SHALL be set to an empty array
- **AND** the supervisor SHALL proceed normally without referring to memory in its prompt

#### Scenario: Turn begins with relevant memory

- **WHEN** `MemoryService.searchTopK` returns one or more facts
- **THEN** their `content` strings SHALL be placed into `state.memoryHints`
- **AND** the supervisor prompt SHALL include a "Known facts about the user" block enumerating them

### Requirement: Supervisor routing via structured output

The supervisor SHALL call the LLM with `withStructuredOutput(RouteSchema)`. `RouteSchema` SHALL be a class-validator DTO with:

- `goto: string` — one of the active domain names from `AgentRegistry.metaForSupervisor()` plus the literal `"__end__"`;
- `task?: string` — a natural-language description of the work the chosen sub-agent should perform; required when `goto` is a domain name, omitted when `goto` is `"__end__"`;
- `speakText?: string` — the literal reply to surface to the user; required when `goto` is `"__end__"`, omitted when `goto` is a domain name.

The supervisor node SHALL validate the structured output and return a `Command` whose `goto` matches `RouteSchema.goto`. Invalid combinations (e.g. `goto: "__end__"` with no `speakText`) SHALL be caught by class-validator and SHALL trigger one retry of the supervisor LLM call with the validation error appended to the prompt. After one failed retry the supervisor SHALL fall back to `Command(goto: "__end__", update: {messages: [AI("Я не понял, повтори?")]})`.

#### Scenario: Supervisor routes to a domain

- **WHEN** the LLM returns `{goto: "memory", task: "remember user prefers espresso"}`
- **THEN** the supervisor node SHALL return `Command(goto: "memory", update: {messages: [System("task: remember user prefers espresso")], activeContext: {...lastDomain: "memory"}})`
- **AND** the graph SHALL transition to the `memory` node

#### Scenario: Supervisor decides to reply directly

- **WHEN** the LLM returns `{goto: "__end__", speakText: "16:42"}`
- **THEN** the supervisor node SHALL return `Command(goto: "__end__", update: {messages: [AI("16:42")]})`
- **AND** the graph SHALL terminate the turn

#### Scenario: Supervisor returns an unknown `goto`

- **WHEN** the LLM returns a `goto` value that is not in `AgentRegistry.metaForSupervisor()` and is not `"__end__"`
- **THEN** the class-validator validation SHALL fail
- **AND** the supervisor SHALL retry once with the failed schema appended to the prompt
- **AND** if the retry also fails the supervisor SHALL fall back to a clarification reply

### Requirement: Graph factory wires nodes from the registry

The graph factory SHALL build a single compiled `StateGraph` at boot time. The graph SHALL consist of:

- `__start__ → pre-supervisor` (deterministic memory pull);
- `pre-supervisor → supervisor` (deterministic edge);
- `supervisor → <each domain name> | __end__` (Command-driven);
- `<each domain name> → supervisor` (Command-driven, with the sub-agent's structured output written into state).

The graph SHALL attach a `SqliteSaver` checkpointer pointed at `VEGA_DB_PATH`. The compiled graph SHALL be exposed as a single DI provider so other code never re-compiles it.

#### Scenario: Graph is compiled once

- **WHEN** the application boots
- **THEN** the graph factory SHALL compile the `StateGraph` exactly once
- **AND** every subsequent `ConversationService.handleTurn` invocation SHALL use the same compiled instance
- **AND** the factory SHALL NOT expose a recompile method

#### Scenario: Registry changes after boot

- **WHEN** an `AgentSpec.enabled` flag flips from `true` to `false` while Core is running
- **THEN** the graph's node set SHALL remain unchanged (still has the now-disabled node)
- **AND** `AgentRegistry.metaForSupervisor()` SHALL omit the domain so the supervisor's structured output enum no longer includes it
- **AND** any in-flight call already routed to the disabled domain SHALL complete normally

### Requirement: Supervisor explicitly does not generate freeform text outside routing

The supervisor LLM SHALL be prompted to produce ONLY structured output. It SHALL NOT produce assistant messages that bypass the `RouteSchema`. The single channel for surfacing words to the user from the supervisor SHALL be the `speakText` field on a `goto: "__end__"` decision.

#### Scenario: LLM emits text instead of structured output

- **WHEN** the LLM ignores the structured-output instruction and returns free-form text
- **THEN** the supervisor node SHALL treat this as a validation failure and retry once
- **AND** if the retry also fails the supervisor SHALL fall back to the clarification reply
