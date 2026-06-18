# memory Specification

## Purpose

The `memory` capability gives Vega long-term knowledge about the user: behavioral preferences ("user dislikes meetings on Friday afternoons"), factual data ("Pyotr's email is pyotr@example.com"), and episodic notes ("last week we discussed the kitchen renovation"). Memory is the one cross-cutting capability included in this change because every future domain will read from or write to it, and shipping it now exercises the `agent-system` contract end to end.

The capability ships three things: a SQLite-backed `MemoryService`, a `memory` domain agent that mediates dedup-aware writes and structured reads, and a shared `rememberTool` other sub-agents inject into their own tool sets to save facts without bypassing the memory agent.

## Requirements

### Requirement: `Memory` entity is the canonical fact row

A single TypeORM entity `Memory` SHALL hold every persisted fact. It SHALL contain exactly these columns in the MVP:

- `id: string` — UUID v4 primary key;
- `content: string` — the fact, in natural language;
- `type: 'behavioral' | 'factual' | 'episodic'` — coarse classification used for filtered search;
- `tags: string[]` — small free-form labels stored as a `simple-array`;
- `contentHash: string` — sha256 of the normalized `content`, indexed unique, used for dedup-on-write;
- `createdAt: Date` — automatic on insert;
- `updatedAt: Date` — automatic on update;
- `embedding: Buffer | null` — reserved for a later semantic-search change; SHALL remain `NULL` in this change.

The schema SHALL be created via TypeORM `synchronize: true` for the MVP. A migrations setup is explicitly a later change.

#### Scenario: Inserting the same content twice

- **WHEN** `MemoryService.write` is called with `content` whose normalized form hashes to an existing row's `contentHash`
- **THEN** the service SHALL NOT insert a duplicate row
- **AND** the service SHALL return the existing row's `id`
- **AND** `updatedAt` on the existing row SHALL NOT be touched (dedup is not a touch)

### Requirement: `MemoryService` is the only DB-touching abstraction

The `MemoryService` SHALL be the only code that reads from or writes to the `Memory` table. Sub-agents, including the memory agent's tool handlers, SHALL go through it.

It SHALL expose:

- `write(content, type, tags?): Promise<{id, deduplicated: boolean}>`;
- `search(query, opts?: {type?, limit?}): Promise<Memory[]>`;
- `searchTopK(query, k): Promise<Memory[]>` — convenience wrapper used by the pre-supervisor node;
- `update(id, content): Promise<Memory>`;
- `delete(id): Promise<void>`.

`search` MVP implementation SHALL be a SQLite `LIKE`-based match against tokenized `content`. Semantic search via `embedding` is explicitly out of scope.

#### Scenario: `searchTopK` returns most-recent on ties

- **WHEN** more rows match the query than `k`
- **AND** several matches share an identical relevance score
- **THEN** `searchTopK` SHALL prefer rows with later `updatedAt`
- **AND** the result array SHALL be sorted by relevance then by `updatedAt` desc

#### Scenario: `delete` on a missing id

- **WHEN** `MemoryService.delete` is called with an id that does not exist
- **THEN** the service SHALL resolve without error
- **AND** SHALL NOT throw

### Requirement: Memory agent mediates LLM-driven writes

A memory react-agent SHALL be encapsulated **inside the `MemoryModule`** to mediate dedup-aware writes triggered by `rememberTool`. The agent SHALL NOT be registered with `AgentRegistry` and SHALL NOT be visible to the supervisor as a routable domain. Its tools SHALL be exactly `search`, `write`, `update`, `delete`, each fronted by a `class-validator` DTO. Its system prompt SHALL instruct the agent to:

1. Always call `search` before `write` to surface near-duplicates;
2. Prefer `update` over `write` when a near-duplicate exists;
3. Use the `type` field according to the documented taxonomy (`behavioral` for preferences, `factual` for concrete data, `episodic` for time-anchored notes);
4. Return a one-sentence `summary` of what was stored, retrieved, or revised.

The agent is invoked exclusively via `MemoryAgentService.dispatch(task)`, which is called from `rememberTool`'s handler. No code outside `MemoryModule` SHALL invoke the memory agent directly.

#### Scenario: Memory agent receives "remember X" but X is already known

- **WHEN** the agent's task is "remember user prefers espresso" and `search` returns a row whose `content` already states the same preference
- **THEN** the agent SHALL NOT call `write`
- **AND** the agent SHALL return `AgentOutput{ status: "ok", summary: "Уже знаю.", data: { id: <existing> } }`

#### Scenario: Memory agent receives "what does the user prefer" and knows nothing

- **WHEN** the agent's task is "what coffee does the user prefer" and `search` returns no rows
- **THEN** the agent SHALL NOT call `write`
- **AND** the agent SHALL return `AgentOutput{ status: "ok", summary: "Я этого не знаю.", data: { found: 0 } }`

#### Scenario: Supervisor does not see memory in its routing table

- **WHEN** `AppModule` finishes booting
- **THEN** `AgentRegistry.list()` SHALL NOT contain an `AgentSpec` with name `memory` or `memory_search`
- **AND** the supervisor's domain meta SHALL NOT advertise memory as a routable domain

### Requirement: `rememberTool` is the shared facility for cross-agent writes

A single `rememberTool` SHALL be exposed from the memory module. Other domain modules SHALL inject it into their `AgentSpec.tools` rather than calling `MemoryService` directly. The tool SHALL:

- Take a single argument `fact: string`;
- Fire off the memory agent with task `"remember: <fact>"` via the same orchestration runtime;
- Return immediately to the calling sub-agent with `{queued: true}`;
- Run the underlying memory-agent invocation asynchronously so the calling sub-agent's loop does not block on memory.

#### Scenario: Caller invokes `rememberTool` mid-conversation

- **WHEN** a sub-agent invokes `rememberTool({fact: "user prefers espresso"})`
- **THEN** the tool SHALL return `{queued: true}` within one event-loop tick
- **AND** the memory agent SHALL eventually run and persist the fact (dedup-aware)
- **AND** failures inside the memory-agent invocation SHALL be logged but SHALL NOT propagate back to the original sub-agent

### Requirement: Memory state survives Core restarts

The `Memory` table SHALL live in the same SQLite database as the LangGraph checkpointer (`VEGA_DB_PATH`). A clean Core restart SHALL preserve every written fact without manual intervention.

#### Scenario: Restart-and-recall

- **WHEN** a fact is persisted in turn T, Core is restarted, and a follow-up turn T+1 asks about the same fact
- **THEN** the pre-supervisor node SHALL find the fact via `searchTopK`
- **AND** the supervisor SHALL be able to reply directly without invoking the memory agent
