## MODIFIED Requirements

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
