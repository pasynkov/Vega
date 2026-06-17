## 1. Dependencies and bootstrap

- [x] 1.1 Add runtime dependencies to `apps/core/package.json`: `@langchain/langgraph`, `@langchain/anthropic`, `@langchain/core`, `typeorm`, `better-sqlite3`, `class-validator`, `class-transformer`, `class-validator-jsonschema`, `reflect-metadata`. Pin minor versions.
- [x] 1.2 Import `reflect-metadata` once at the very top of `apps/core/src/main.ts` so decorator metadata is available before any DI graph is built.
- [x] 1.3 Add `ANTHROPIC_API_KEY` and `VEGA_DB_PATH` to the typed config module. `VEGA_DB_PATH` defaults to `<repo>/recordings/vega.sqlite`. The key SHALL be redacted in logs the same way the existing keys are.
- [x] 1.4 Update `apps/core/.env.example` and the root `.env.example` with the two new variables.

## 2. `apps/core/src/db` — SQLite + TypeORM root

- [x] 2.1 Add `db.module.ts` that initializes a TypeORM `DataSource` against `VEGA_DB_PATH` with `synchronize: true` for MVP (a migrations setup is a later change).
- [x] 2.2 Enable SQLite WAL mode and `busy_timeout = 5000` on the underlying connection so writes from the memory agent and checkpointer do not collide.
- [x] 2.3 Expose the `DataSource` as a NestJS provider so submodules can inject repositories by entity.

## 3. `apps/core/src/llm` — Anthropic client

- [x] 3.1 Add `llm.module.ts` exporting a singleton `ChatAnthropic` configured with `claude-sonnet-4-6` and the API key from config.
- [x] 3.2 Expose a `getModel(spec?: {model?: string})` factory so future per-`AgentSpec` model overrides are a one-line change.
- [x] 3.3 Add a smoke-test that calls the model with a trivial prompt at startup behind a `VEGA_LLM_PING_ON_BOOT=1` env flag to surface bad keys early without paying the request on every boot.

## 4. `agent-system` capability — `AgentSpec` and tools pipeline

- [x] 4.1 Define `AgentSpec`, `AgentOutput`, and the `AgentToolHandler` interface in `apps/core/src/agents/agent.types.ts`.
- [x] 4.2 Define an `AGENT_SPEC` multi-injection token in `apps/core/src/agents/agent.tokens.ts` and an `AgentRegistry` service that gathers every `AgentSpec` provider registered against the token, filters by `enabled`, and exposes `list()`, `get(name)`, `metaForSupervisor()`.
- [x] 4.3 Implement `makeTool({dto, name, description, handler})` in `apps/core/src/agents/tool-factory.ts`. The factory uses `validationMetadatasToSchemas` to produce a JSON Schema for the LLM, wraps the handler in a `plainToInstance` + `validate` pipeline, and returns a LangGraph `tool` instance.
- [x] 4.4 Add a boot-time smoke test (`agent-system/tool-factory.spec.ts`) that round-trips every DTO known to the registry through the schema generator and asserts the schema is a non-empty object — fail fast on broken decorator combinations.
- [x] 4.5 Add `agent-system.module.ts` that wires `AgentRegistry` and re-exports the tool factory so domain modules import a single thing.

## 5. `supervisor` capability — state, routing model, graph node

- [x] 5.1 Define `VegaState` in `apps/core/src/agents/supervisor/state.ts` using `Annotation.Root({messages, sessionId, activeContext, memoryHints, lastAgentResult})`. Keep the annotation surface narrow; expand only when a real need appears.
- [x] 5.2 Implement the `RouteSchema` as a `class-validator` DTO: `goto: string` (one of the registered domain names plus `"__end__"`), `task?: string`, `speakText?: string`. Validate at runtime that `goto` is in `AgentRegistry.list()` ∪ `{"__end__"}`.
- [x] 5.3 Implement `supervisor.node.ts`. The node loads `memoryHints`, builds a system prompt from `AgentRegistry.metaForSupervisor()`, calls `model.withStructuredOutput(RouteSchema)`, and returns the appropriate `Command`.
- [x] 5.4 Implement `supervisor.prompt.ts`. The prompt template lists each domain as `<name>: <description>` plus its `examples`. The author-facing template lives here rather than in the node so prompt edits are isolated.
- [x] 5.5 Add `pre-supervisor.node.ts` — a deterministic node that calls `MemoryService.searchTopK(latest_message, 5)` and writes the result into `state.memoryHints`. This node fires once per turn before `supervisor`.
- [x] 5.6 Unit-test the supervisor node with a stubbed model: given a registry of two fake domains and a fake user message, assert the returned `Command` matches the expected `goto` and `task`.

## 6. `supervisor` capability — graph factory

- [x] 6.1 Implement `graph.factory.ts` that, at boot, queries `AgentRegistry` for active specs, wires the `pre-supervisor → supervisor → <domain> → supervisor → __end__` graph with explicit `Command` ends, and attaches the `SqliteSaver` checkpointer.
- [x] 6.2 The factory MUST throw at boot if any registered `AgentSpec.name` collides with another or with `"__end__"`. Routing relies on these names being unique.
- [x] 6.3 Compile the graph once at boot and expose the compiled instance through DI. Recompilation is not supported in this change; domain registration is boot-time only.

## 7. `agent-system` — react-agent sub-node wrapper

- [x] 7.1 Implement `makeSubAgentNode(spec: AgentSpec)` in `apps/core/src/agents/sub-agent.factory.ts`. The factory builds a `createReactAgent({llm: getModel(spec), tools: spec.tools, prompt: spec.systemPrompt})` agent once, then returns a graph-node function that extracts the supervisor's task from `state.messages`, invokes the react-agent, parses the response into `AgentOutput`, and returns `Command(goto: "supervisor", update: {messages, lastAgentResult})`.
- [x] 7.2 The sub-agent's final response is required to be either plain text (treated as `summary`) or a JSON object matching `AgentOutput`. The wrapper handles both; a stricter contract can land in a later change once usage patterns are clear.
- [x] 7.3 Sub-agent errors are caught at the wrapper and surface as `{status: "error", summary: "<message>"}` rather than throwing up the graph; the supervisor decides what to say to the user.

## 8. `memory` capability — TypeORM entity and service

- [x] 8.1 Define `Memory` entity in `apps/core/src/memory/memory.entity.ts`: `id: uuid`, `content: text`, `type: 'behavioral'|'factual'|'episodic'`, `tags: simple-array`, `contentHash: text` (sha256, indexed, unique), `createdAt`, `updatedAt`, `embedding?: blob` (nullable, reserved).
- [x] 8.2 Implement `MemoryService` with `search(query, type?, limit)`, `searchTopK(query, k)`, `write(content, type, tags)`, `update(id, content)`, `delete(id)`. `write` SHALL skip insertion when an existing row's `contentHash` matches, returning the existing id.
- [x] 8.3 `search` MVP uses SQLite `LIKE` on `content` with simple tokenization. Vector search is explicitly out of scope; the column is there so a later change can add it without migration.
- [x] 8.4 Unit-test `MemoryService`: write/search/update/delete round-trip; dedup-on-write returns the existing id; search-by-type filters correctly.

## 9. `memory` capability — memory agent

- [x] 9.1 Implement `memory.tools.ts` with four tools (`search`, `write`, `update`, `delete`) each fronted by a `class-validator` DTO and built through `makeTool`. The tool handlers call `MemoryService`.
- [x] 9.2 Implement `memory.agent.ts` exporting an `AgentSpec` with name `"memory"`, description tuned for the supervisor ("save, recall, and revise facts about the user"), `examples` covering recall and save flows, a system prompt that instructs the agent to search before writing.
- [x] 9.3 Implement `remember.tool.ts` — a shared LangGraph tool with a single `fact: string` argument whose handler fires off a memory-agent invocation. The handler returns immediately; the underlying agent runs asynchronously so a `rememberTool` call never blocks the calling sub-agent's response loop.
- [x] 9.4 Export `RememberToolProvider` from `memory.module.ts` so any domain module can inject it into its tools array.
- [x] 9.5 Register the memory `AgentSpec` against the `AGENT_SPEC` injection token from `memory.module.ts`.

## 10. `conversation` capability

- [x] 10.1 Implement `ConversationService` in `apps/core/src/conversation/conversation.service.ts`: `handleTurn(sessionId, userText): Promise<string>` loads state from the checkpointer keyed by `sessionId`, appends the human message, invokes the compiled graph, returns the supervisor's `speakText`.
- [x] 10.2 Implement a `SessionRegistry` that maps `sessionId → metadata` (created-at, last-active-at). MVP holds only the hard-coded `"default"` session, but the structure is there.
- [x] 10.3 Add the `SqliteSaver` checkpointer construction against `VEGA_DB_PATH` and inject it into the graph factory.
- [x] 10.4 Add an integration-level test (`conversation.spec.ts`) that drives a multi-turn conversation through the real graph against an in-memory SQLite, exercising: (a) "remember I prefer espresso" → memory write; (b) "what coffee do I drink?" → memory search via supervisor → speak; (c) restart `ConversationService` and assert the memory survives.

## 11. Wire into `AppModule`

- [x] 11.1 Register `DbModule`, `LlmModule`, `AgentSystemModule`, `MemoryModule`, `SupervisorModule`, `ConversationModule` in `apps/core/src/app.module.ts` in dependency order.
- [x] 11.2 Do not register the orchestrator on the existing `EarGateway`. Hooking the listener is explicitly a later change.

## 12. Test harness

- [x] 12.1 Add `apps/core/test/orchestrator.harness.ts` — a tiny script callable via `npm --workspace @vega/core run dev:llm-harness` that opens a stdin REPL, forwards each line to `ConversationService.handleTurn("default", line)`, and prints the spoken reply.
- [x] 12.2 Document the harness in `apps/core/README.md` under a new "LLM harness" subsection: how to run it, what env vars it needs, and that it is the only entry point in this change.

## 13. Documentation and follow-up tracking

- [x] 13.1 Add a one-paragraph note to `README.md` at the repo root pointing to `openspec/changes/llm-orchestration-mvp/` as the architecture reference until the change is archived.
- [x] 13.2 Open a follow-up TODO in `proposal.md`'s "Impact" once tasks are done: the next change must bridge `EarGateway.final_transcript` events to `ConversationService.handleTurn`.
