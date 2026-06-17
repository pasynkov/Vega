## Why

Vega's current scope ends at "captured user utterance is saved as a transcript". To become an assistant rather than a tape recorder, Core must turn each transcript into a response or an action. That requires an LLM layer, but a personal assistant accumulates many tools across many domains — calendar, mail, music, home, notes, code, contacts, search. Modern LLM agents degrade as their tool count climbs past roughly seven; flat agents with fifty tools hallucinate names and pick wrong tools. The LLM layer therefore needs structure: a supervisor that routes each turn to one domain, sub-agents per domain with focused tool sets, long-term memory of facts about the user, and a plug-in point so adding a new domain is one module rather than a rewrite of the router.

This change introduces that orchestration spine — graph runtime, sub-agent contract, tool-schema pipeline, and memory subsystem — without committing to any specific application domain. The only domain shipped here is `memory` itself, because (a) memory is genuinely cross-cutting and every future domain will use it, and (b) shipping one real domain alongside the spine forces every contract to be exercised end-to-end. Calendar, mail, and the rest are deliberately out of scope; each will be its own future change contributing one `AgentSpec` to the registry.

## What Changes

- Add an LLM orchestration subsystem inside `apps/core`: a LangGraph.js `StateGraph` whose nodes are a `supervisor` plus N domain sub-agents. The supervisor uses explicit `Command(goto: ...)` routing rather than the implicit react-agent shim, so routing decisions are debuggable and unit-testable in isolation.
- Define an `AgentSpec` contract — `{name, description, examples, systemPrompt, tools, enabled}` — that every domain module exports as a NestJS DI provider. An `AgentRegistry` collects active specs at boot and builds the supervisor's prompt and the graph's node set from them. Adding a new domain is one module; the supervisor and the graph factory are domain-agnostic and never change when a domain is added.
- Tool schemas are declared as `class-validator` DTO classes, converted to JSON Schema via `class-validator-jsonschema` at boot for the LLM, and validated at runtime via `class-transformer.plainToInstance` plus `class-validator.validate` before each tool's handler runs. One DTO declaration drives both the LLM-facing schema and runtime validation. No Zod.
- Add a `memory` subsystem: a SQLite store via TypeORM holding `Memory` rows (`content`, `type`, `tags`, timestamps, an optional `embedding` column reserved for later semantic search), a `MemoryService`, and a `memory` domain agent whose tools are `search`, `write`, `update`, and `delete`. Other sub-agents receive a shared `rememberTool` that fires off the memory agent so behavioral facts, contacts, and episodic notes accumulate without polluting other agents' contexts.
- Add a `conversation` subsystem: a `ConversationService` that owns the session lifecycle, invokes the graph, and surfaces the supervisor's final spoken reply. Conversations persist across Core restarts via LangGraph's `SqliteSaver` checkpointer pointed at the same SQLite database used by `memory`.
- Wire orchestration into Core's NestJS bootstrap but do not yet hook it to the `ear-protocol` transcript stream. The MVP is invoked from a test harness only; bridging the listener to the LLM is a follow-up change once the spine is stable.
- Use Claude Sonnet 4.6 (`claude-sonnet-4-6`) for every LLM call. The agent-to-model mapping is a per-`AgentSpec` field so individual domains can later be moved to Haiku or Opus without touching the runtime.

## Capabilities

### New Capabilities
- `agent-system`: the `AgentSpec` contract, the registry, and the tool-schema pipeline (class-validator → JSON Schema → LangGraph `tool()`). The plug-in point every future domain depends on.
- `supervisor`: the main `StateGraph`, the supervisor node, the routing model, the conversation-state shape, and the rules for when to delegate versus respond directly.
- `memory`: the SQLite `Memory` table, the `MemoryService`, the memory agent, and the shared `rememberTool` other agents use to save facts.
- `conversation`: session lifecycle, the LangGraph `SqliteSaver` checkpointer, and the turn-handling entry point that downstream transports (ear-protocol, Telegram, chat UI) will call.

### Modified Capabilities

The existing `vega-core` capability gains the LLM orchestration spine described above. The ear-protocol / Deepgram / recording pipeline is untouched and no `vega-core/spec.md` requirements are modified in this change; the new behavior is captured fully by the four new capabilities above, which `vega-core` hosts.

## Impact

- New runtime dependencies: `@langchain/langgraph`, `@langchain/anthropic`, `@langchain/core`, `typeorm`, `better-sqlite3`, `class-validator`, `class-transformer`, `class-validator-jsonschema`, `reflect-metadata`.
- New external service dependency: Anthropic API. One new secret in Core's environment: `ANTHROPIC_API_KEY`.
- A SQLite database file appears under Core's data directory holding `Memory` rows and LangGraph conversation checkpoints. The path is configurable; default lives next to `recordings/`.
- No new external ports, no new network surface, no change to the existing ear-protocol contract.
- No production users. Orchestration runs only when explicitly invoked from the test harness in this change.
