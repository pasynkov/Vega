## Context

Vega today ends at "transcript saved on disk". This change adds the layer that turns a transcript into a response or an action: the LLM orchestration spine. The user is the sole developer and the sole end-user; there is no multi-user concern, no public API, no production traffic. Core runs as a local daemon on a MacBook.

A personal assistant naturally grows many tools across many domains. The author does not yet know the full list of domains — calendar, mail, music, home, notes, code, contacts, search, files, weather, timers, phone are all plausible — so the architecture must let new domains be added without rewiring the router or rewriting the supervisor. Conversely, the LLM-tool scaling problem is real and well documented: agent accuracy degrades visibly past ~7 tools and falls off a cliff past ~30, so a single flat agent with every tool is not viable.

A previous exploration considered five architectural patterns: hierarchical routing (router → sub-agents), RAG-over-tools, two-phase LLM-driven tool search, MCP-style skill discovery, and a planner/executor split. The decisions below land on an orchestrator pattern (supervisor + sub-agents-as-tools) because it composes naturally for multi-domain commands ("find a free slot tomorrow and send Peter an invite"), keeps conversation state in one place, and degrades to single-domain handling without extra wiring.

This change is the spine. It ships one real domain — `memory` — so every contract is exercised end-to-end. Every other domain (calendar, mail, …) is a separate future change that contributes one `AgentSpec` to the registry.

## Goals / Non-Goals

**Goals:**
- A working orchestration loop: user message in → supervisor routes → sub-agent executes with its own tools → supervisor replies → state persists across Core restarts.
- A plug-in point (`AgentSpec`) such that adding a new domain is one NestJS module with zero changes to the supervisor or graph factory.
- Tool schemas declared once, used twice: same `class-validator` DTO drives both the LLM-facing JSON Schema and runtime input validation.
- Long-term memory that any agent can read from and write to, via the memory sub-agent rather than via direct DB access.
- Conversation continuity: a turn-N exchange can refer back to facts established in turn-1, even after a Core restart.

**Non-Goals:**
- Any specific application domain other than memory. Calendar, mail, music, etc. are out of scope and ship in their own changes.
- Hooking the orchestrator to the existing ear-protocol stream. The MVP is driven from a test harness; the bridge is a follow-up change.
- Voice TTS or streaming token output. Both are foreseeable but explicitly deferred; the chosen architecture leaves room without committing now.
- Multi-user or multi-session concurrency. Single user, single live session at a time. `sessionId` is part of the state shape from day one so a future change can lift this without protocol churn.
- Embedding-based semantic memory search. The `Memory` table reserves an `embedding` column; populating and querying it is a later change once the fact count justifies the complexity.
- Authentication or any network exposure of the LLM layer. Loopback-only, trusted-process model, same as the existing daemon.
- Cost/budget tracking, prompt-cache tuning, structured logging dashboards. All worthwhile, none required for the spine to function.

## Decisions

### Orchestrator pattern: supervisor + sub-agents-as-tools

A central `supervisor` node routes each user turn to exactly one domain sub-agent. Sub-agents are exposed to the supervisor as tools (`ask_calendar`, `ask_mail`, …). The supervisor may call several sub-agents in sequence within one turn ("find a free slot, then send the invite"); LangGraph supports parallel `tool_use` from a single model response if the supervisor decides to fan out.

**Why:**
- Survives the tool-count problem: the supervisor sees a small list of domains, each sub-agent sees a small list of tools. No flat agent ever holds the union.
- Multi-domain commands ("X and Y") work naturally because the supervisor is in the loop across the whole turn rather than handing the conversation off.
- The state-holder is one node (the supervisor); sub-agents are stateless executors. This avoids the "who remembers the email-id from the previous turn" problem that plagues pure-handoff routers.
- Adding a domain is purely additive — the supervisor's prompt is regenerated from the registry at boot.

**Alternatives considered:**
- One-shot dispatch router (router decides domain, sub-agent answers user directly, no return to router). Rejected because compound commands like "включи музыку и письмо отправь Пете" require either a multi-domain router or post-hoc re-routing; both add complexity the orchestrator pattern absorbs for free.
- Plan-then-execute (a planner emits a multi-step plan, an executor runs it). Rejected as overkill for the typical voice command. The same shape can be added later as a single "plan" sub-agent if the need appears.
- RAG-over-tools (embedding retrieval of top-K tools into a flat agent). Rejected because retrieval misses become silent failures — the LLM never knows the right tool exists — and because behavioral nuances ("when user says 'позвони' that goes to phone, not contacts") are hard to encode in embeddings.

### Manual `Command(goto: ...)` routing, not `createReactAgent` for the supervisor

The supervisor is a hand-written graph node that calls the model with `withStructuredOutput(RouteSchema)` and returns a LangGraph `Command` to either route to a sub-agent or end the turn with a spoken reply. The sub-agents themselves are wrapped via LangGraph's `createReactAgent` because their loop is the standard tool-call / tool-result cycle and writing it by hand buys nothing.

**Why:**
- Routing is the most failure-prone part of the system. Making it an explicit structured call rather than an implicit consequence of tool-choice means each routing decision is logged with both the input context and the structured output verbatim, and is unit-testable without the rest of the graph.
- The supervisor's "speak directly" path ("привет", "сколько времени") is naturally expressed as a `goto: "__end__"` with a `speakText`, rather than tortured through a fake "speak" tool.
- The pre-turn step that pulls top-K memory hints into state is easier to wire as a separate node feeding a deterministic supervisor than as a hidden side-effect of an opaque agent loop.
- The sub-agent loop, by contrast, is genuinely the standard react-agent loop. Writing it by hand offers no debuggability gain and costs maintenance.

**Alternatives considered:**
- `createReactAgent` for the supervisor too, with each sub-agent exposed as a tool. Rejected for the debug/test reasons above; revisitable if the supervisor's hand-written loop ever grows past trivial.
- A separate `langgraph-supervisor` library. Rejected because the supervisor's logic is small enough that wrapping it in another abstraction costs more than it saves, and because the library targets Python.

### Sub-agent as graph node, not subgraph

Each sub-agent is a LangGraph node that internally invokes a compiled react-agent. The supervisor's `Command(goto: "<domain>")` lands at that node; the node returns `Command(goto: "supervisor", update: {messages, lastAgentResult})`.

**Why:**
- Simpler call site: the supervisor sees domains as a flat name space, the graph factory wires nodes by iterating the registry.
- Sub-agents are stateless from the main graph's perspective — they receive a task string and the (read-only) state, return a structured result. No nested checkpoints to reason about.
- If a sub-agent later needs internal multi-step persistence of its own, promoting it to a subgraph is a local refactor that does not touch the supervisor.

**Alternatives considered:**
- Sub-agent as compiled subgraph composed via `addNode(name, subgraph)`. Rejected for MVP because the supervisor doesn't yet need sub-agents to checkpoint independently; adding subgraph composition now would mean reasoning about two checkpointers at once.

### Sub-agent signature: text-in, structured-out (the "γ" hybrid)

Sub-agent input is a single `task: string` plus the message history. Sub-agent output is `{status: "ok"|"clarify"|"error", summary: string, data?: Record<string, unknown>}`. The `summary` field is what the supervisor reads back to the user; `data` is what the supervisor passes into the next sub-agent in a chain.

**Why:**
- LLM-native on the input side: the supervisor describes the task in plain words ("отправь Пете invite на завтра 13:00"), which is how the supervisor LLM naturally expresses intent.
- Machine-readable on the output side: chaining works (`mail.find` returns `data.email_id`, the next step passes that into `calendar.create`).
- Stateless sub-agent: the supervisor is the memory-holder; the sub-agent is told what to do for this one task and forgets afterward.

**Alternatives considered:**
- Fully structured input (`{intent, params, context}`). Rejected because writing it locks the supervisor into a schema it doesn't always know (especially for free-form domains like `notes` or `code`).
- Plain text output. Rejected because chaining requires structured payloads.

### LangGraph.js as the runtime

The orchestration graph runs on `@langchain/langgraph`. State is shared via `Annotation.Root({...})`; routing is via `Command`. The conversation checkpointer is `SqliteSaver`.

**Why:**
- The pattern (state graph + command-based routing + checkpointed conversations) is exactly what LangGraph models. Building the same primitives by hand would be straightforward but is wasted novelty.
- LangGraph.js is the JavaScript flavor and runs inside NestJS without ceremony. The Vega stack is Node.
- The supervisor pattern is a documented first-class use case with current examples.

**Alternatives considered:**
- Roll our own graph. Rejected: the abstraction (nodes, edges, state, command routing, checkpoints) is real; no reason to reinvent it before knowing what we'd do differently.
- Mastra / Flowise / other agent frameworks. Rejected: more opinionated, less control, smaller ecosystem.
- Direct Anthropic SDK with hand-written loop. Workable but loses checkpoints and stream-mode integrations that LangGraph already solves.

### Tool schemas via `class-validator` + `class-transformer` + `class-validator-jsonschema`

Every tool's input is a `class-validator`-decorated DTO class. At boot, `validationMetadatasToSchemas()` (from `class-validator-jsonschema`) converts each DTO to a JSON Schema, which is handed to LangGraph's `tool({ schema })`. At runtime, the LLM's raw arguments are passed through `class-transformer.plainToInstance(Dto, raw)` and then `class-validator.validate(dto)`; the handler receives a validated DTO instance.

**Why:**
- One declaration, two uses: the same class drives the LLM's tool schema and the runtime validation. There is no risk of schema drift between "what the LLM thinks the args are" and "what the handler accepts".
- NestJS-idiomatic. This is the same pattern `@nestjs/swagger` uses for OpenAPI, so the team's mental model and tooling already understands it.
- No Zod. The author explicitly prefers class-based decorators in this stack.

**Alternatives considered:**
- Zod schemas as LangGraph's first-class shape. Rejected by the author for stack consistency. Working but redundant with the existing class-validator presence in any NestJS API code.
- Hand-written JSON Schema per tool. Workable for two or three tools, untenable past a dozen, and leaves runtime validation orphaned.

### SQLite + TypeORM as the only persistence store

A single SQLite file holds the `Memory` table (via TypeORM entities) and LangGraph's conversation checkpoints (via the `SqliteSaver` checkpointer). The file lives next to `recordings/` by default; the path is configurable via env.

**Why:**
- Embedded, zero-ops, single-file. Vega is a single-user daemon on a Mac; running Postgres or MinIO for this would add ops surface without buying anything.
- SQLite is the right shape for the data: memory needs `SELECT ... WHERE`, partial updates, and (later) vector search via `sqlite-vec`. Object storage (S3, MinIO) cannot do these without a separate index layer, and was explicitly considered and rejected.
- The same store hosting checkpoints and memory means one backup target. If cloud durability is wanted later, Litestream replicating the SQLite file to S3/MinIO gets both with one mechanism.

**Alternatives considered:**
- MinIO / S3-compatible blob storage for memory. Rejected: memory operations are queries, updates, and per-tag filters — not blob get/put. Search would require listing and fetching every object on every turn. Detail in the proposal-exploration record.
- Postgres. Rejected: needs a daemon, adds a port, gives zero benefit at the current scale.
- Separate stores per concern (one DB per subsystem). Rejected as premature.

### Memory through a memory sub-agent, not direct DB access

Other sub-agents do not call `MemoryService` directly. They receive a shared `rememberTool` whose handler invokes the memory sub-agent with a task like "remember: user prefers no meetings on Friday afternoons". The memory agent, in turn, owns the `search`, `write`, `update`, and `delete` tools that touch the `MemoryService`.

**Why:**
- The memory agent can deduplicate ("we already know this") and revise old entries ("update the existing fact rather than appending a duplicate"). A raw DB write from every sub-agent cannot.
- One LLM-mediated source of truth for the *shape* of memory: types, tags, summarization length, conflict handling all evolve in one place rather than in N domain modules.
- The cost (one extra LLM hop) is bounded by being fire-and-forget for writes and pull-once for reads at supervisor pre-turn.

**Alternatives considered:**
- Direct `MemoryService` injection into every agent. Rejected because every domain would re-implement dedup, and dedup quality varies wildly.
- A hybrid where reads go direct and writes go through the memory agent. Rejected as premature: a single boundary is simpler until profiling says otherwise.

### Pre-turn memory hint pull into state

Before the supervisor routes, a `memoryHints` field on the state is populated by `MemoryService.searchTopK(latest_user_message, K=5)`. The supervisor's prompt references these hints when picking a domain and when drafting a direct reply.

**Why:**
- Cheap, deterministic, and side-effect-free: a single DB query before the LLM call beats a memory-agent invocation on every turn.
- Avoids the cold-start "the assistant forgot" feeling without forcing every domain agent to remember to call `memory.search`.

**Alternatives considered:**
- Memory agent called by the supervisor on every turn. Rejected as wasteful for a query that is a one-liner in SQL.
- No automatic pull at all, agents must ask. Rejected because in practice they would forget, and users would notice.

### All Sonnet 4.6 for now, per-`AgentSpec` model override later

Every LLM call in this change targets `claude-sonnet-4-6`. `AgentSpec.model?: string` exists from day one and is consulted by the graph factory; it just is not set anywhere yet.

**Why:**
- One model means one prompt-cache namespace, one place to debug, one quirk profile while the spine is taking shape.
- Sonnet 4.6 handles routing, memory dedup, and the first domain's logic without strain. Optimizing model assignment before profiling is premature.
- The cost of swapping later is one field per AgentSpec; the risk of doing it now is masking architectural bugs as model-quirk bugs.

**Alternatives considered:**
- Haiku for the supervisor, Sonnet for sub-agents. Rejected for now; revisit once the supervisor's prompt and routing accuracy are stable enough to A/B.
- Opus for everything. Rejected as unnecessary expense at this stage.

### Single live session, `sessionId` reserved

The MVP runs one session at a time. `sessionId` is a first-class field on every state object and every checkpointer key from day one, but in this change it is hard-coded to `"default"`.

**Why:**
- Carrying the field through the architecture from the start makes the eventual multi-session change additive rather than invasive.
- Hard-coding for now keeps the test harness trivial and avoids speculative wiring.

**Alternatives considered:**
- Omit `sessionId` entirely until multi-session is needed. Rejected because checkpoint keys, log prefixes, and entity columns would all need adding later.

### Not yet wired to the ear-protocol transcript stream

The orchestration is invoked from a test harness (a Vitest spec or a one-off NestJS command) only. The existing `EarGateway` does not forward `final_transcript` events to the orchestrator in this change.

**Why:**
- The bridge is a one-line subscription, but choosing where to draw it (per-utterance turn? buffer until silence? cancel in-flight on barge-in?) is its own design decision and would bloat this change.
- Shipping the spine without the bridge means the spine is testable in isolation, which is exactly the maturity gate the next change needs.

**Alternatives considered:**
- Wire the bridge in this change as a thin pass-through and treat barge-in as a future change. Plausible, but adds bridging glue that would be re-touched the moment the first real domain ships; cleaner to keep this change strictly spine.

## Risks

- **Routing accuracy.** A supervisor that mis-routes degrades every domain. Mitigation: explicit `RouteSchema`, logged inputs and outputs, and the `examples` field of each `AgentSpec` is included verbatim in the supervisor's prompt so domains can teach the supervisor what they handle.
- **Tool-schema generation fidelity.** `class-validator-jsonschema` does not cover every decorator combination. Mitigation: a smoke-test at boot that round-trips each DTO through the generator and a structural-output validator, failing fast if any tool's schema is unparseable.
- **Memory write loops.** A naive `rememberTool` could re-record the same fact on every turn. Mitigation: the memory agent's write tool is required by its system prompt to search-then-write, and the `MemoryService.write` method does dedup-by-content-hash as a hard backstop.
- **LangGraph.js API drift.** LangGraph.js iterates fast. Mitigation: pin to a known-good minor and wrap the `Command`/`StateGraph` surface in a single module so a version bump is one place to fix.
- **SQLite contention.** `better-sqlite3` is synchronous. Mitigation: WAL mode, plus the memory agent's writes are debounced through a queue rather than firing on every tool call.

## Migration / Sequencing

This change has no users and no prior state. There is no migration. The sequencing inside the change is captured in `tasks.md`; nothing outside the change needs to coordinate.
