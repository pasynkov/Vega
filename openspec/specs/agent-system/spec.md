# agent-system Specification

## Purpose

The `agent-system` capability defines the contract every domain module follows to plug into Vega's LLM orchestration. It owns three things: the `AgentSpec` shape that domain modules export, the `AgentRegistry` that collects active specs at boot, and the tool-schema pipeline (`class-validator` DTO → JSON Schema → LangGraph `tool()`) that turns each domain's typed input classes into LLM-callable tools with runtime validation.

The capability is intentionally domain-agnostic. It contains no calendar, mail, music, or memory logic. Its job is to make adding a new domain a single NestJS module rather than a rewrite of the router.
## Requirements
### Requirement: `AgentSpec` is the only contract a domain module exposes

Every domain module SHALL provide exactly one `AgentSpec` value to the dependency injection container, bound to the `AGENT_SPEC` injection token as a multi-injection provider. The shape SHALL be exactly:

```ts
interface AgentSpec {
  name: string                                // unique routing id, no spaces
  description: string                         // one line, supervisor-visible
  examples: string[]                          // sample utterances this domain handles
  systemPrompt: string                        // prepended to the sub-agent's loop
  tools: Tool[]                               // LangGraph tools built via makeTool()
  enabled: boolean | (() => boolean)          // feature flag
  model?: string                              // optional per-agent model override
}
```

#### Scenario: Domain module registers a single spec

- **WHEN** a NestJS module exports an `AgentSpec` provider against the `AGENT_SPEC` token
- **THEN** the spec SHALL be visible to `AgentRegistry.list()` at boot
- **AND** the registry SHALL include the spec only when `enabled` evaluates to `true`

#### Scenario: Two domains accidentally use the same name

- **WHEN** the application boots with two registered `AgentSpec` values whose `name` field is identical
- **THEN** the graph factory SHALL throw at boot with a message naming the conflicting providers
- **AND** the daemon SHALL NOT proceed to accept turns

#### Scenario: Domain reserves a forbidden name

- **WHEN** any registered `AgentSpec.name` equals `"__end__"` or `"supervisor"` or `"pre-supervisor"`
- **THEN** the graph factory SHALL throw at boot with a message that the name is reserved by the orchestration runtime

### Requirement: `AgentRegistry` exposes domain metadata to the supervisor

The `AgentRegistry` service SHALL be the only abstraction the supervisor uses to learn what domains exist. It SHALL expose:

- `list(): AgentSpec[]` — every registered spec whose `enabled` evaluates true at call time;
- `get(name): AgentSpec | undefined` — lookup by routing id;
- `metaForSupervisor(): SupervisorDomainMeta[]` — projection containing only the fields the supervisor's prompt needs: `name`, `description`, `examples`.

The registry SHALL re-evaluate `enabled` on every call rather than caching, so a feature-flag flip takes effect on the next turn.

#### Scenario: Supervisor prompt reflects only active domains

- **WHEN** a domain's `AgentSpec.enabled` evaluates to `false`
- **THEN** `AgentRegistry.metaForSupervisor()` SHALL omit that domain
- **AND** the next supervisor invocation SHALL build its prompt without that domain
- **AND** the supervisor SHALL NOT be able to route to that domain (the graph node still exists, but the supervisor's structured-output enum will not include it)

### Requirement: Tool factory turns class-validator DTOs into LangGraph tools

The `makeTool({dto, name, description, handler})` helper SHALL be the only sanctioned way to produce a tool inside a domain. It SHALL:

1. Generate a JSON Schema for the DTO via `class-validator-jsonschema.validationMetadatasToSchemas` at the moment the tool is constructed.
2. Pass that JSON Schema to LangGraph's `tool({schema, ...})` so the LLM sees the same shape the runtime will accept.
3. Wrap `handler` so that, on every LLM tool call, raw arguments are run through `class-transformer.plainToInstance(dto, raw)` and then through `class-validator.validate(dto)` before `handler(dto, ctx)` runs.
4. Throw a structured `ToolValidationError` (caught and turned into a tool error message in the sub-agent loop) if validation fails.

#### Scenario: LLM sends arguments that satisfy the DTO

- **WHEN** the LLM invokes the tool with raw arguments that pass DTO validation
- **THEN** the handler SHALL receive a fully-typed DTO instance
- **AND** the tool's return value SHALL be passed back to the LLM as the tool result

#### Scenario: LLM sends arguments that violate the DTO

- **WHEN** the LLM invokes the tool with arguments that fail DTO validation
- **THEN** the wrapper SHALL NOT invoke the handler
- **AND** the wrapper SHALL emit a tool-call error containing the failed validation messages
- **AND** the sub-agent loop SHALL surface the failure as a normal tool-result error so the LLM can retry

### Requirement: Boot-time DTO smoke test

The capability SHALL ship a boot-time test that iterates every `AgentSpec`'s tool array and asserts each tool's underlying DTO produces a non-empty JSON Schema with a `type: "object"` root. The intent is to catch incompatible decorator combinations the day they are added, not the day a user first triggers the tool.

#### Scenario: A DTO produces an unusable schema

- **WHEN** any registered tool's DTO produces a JSON Schema lacking a `type: "object"` root or with no `properties`
- **THEN** the smoke test SHALL fail with a message identifying the offending DTO class
- **AND** Core SHALL refuse to start

### Requirement: Sub-agents may be invoked in session-bound mode

The capability SHALL recognise a second sub-agent invocation mode in addition to the post-endpoint `handleTurn` path: **session-bound invocation**, driven by `tool-driven-ear-sessions.runSessionAgent`. In session-bound invocation, the same `AgentSpec` is reused: its `systemPrompt`, `tools`, and (if present) `model` SHALL be the only sources of behaviour. No new fields SHALL be added to `AgentSpec`.

The distinction between modes SHALL be encoded in the runtime context passed to tool handlers, not in the spec shape. Specifically, a tool handler invoked from inside a session-bound sub-agent SHALL receive an `EarSessionHandle` on its context; the same handler invoked from the post-endpoint path SHALL receive `undefined` in that slot.

#### Scenario: AgentSpec shape is unchanged

- **WHEN** an implementer inspects the `AgentSpec` interface after this change
- **THEN** its field set SHALL be exactly the set described in the existing `AgentSpec` requirement
- **AND** no `sessionBound` boolean, no separate "session agent" type, and no parallel spec interface SHALL exist

#### Scenario: Tool handler can detect session-bound context

- **WHEN** a tool handler is invoked from a session-bound sub-agent loop
- **THEN** its context SHALL include an `EarSessionHandle` for the active session
- **AND** the same handler invoked from a post-endpoint turn SHALL receive context without an `EarSessionHandle`

### Requirement: Session-bound tools may declare release semantics

Tools that end a session-bound sub-agent loop SHALL signal release by returning a `SessionToolResult` of shape `{ release: true, reason: "endpoint" | "timeout" | "stt_error" | "user", ... }`. Tools intended to be used only inside a session-bound loop (e.g. `append_text`, `finalize_note`) MAY rely on `EarSessionHandle` being present on context; when invoked outside a session-bound loop they SHALL throw `ToolUsedOutsideSessionError` rather than silently no-op.

#### Scenario: Release-shape return ends the session

- **WHEN** a session-bound tool returns `{ release: true, reason: "endpoint" }`
- **THEN** the sub-agent runner SHALL treat the loop as terminated
- **AND** SHALL release `EarSessionRouter` ownership for that session

#### Scenario: Session-only tool invoked from post-endpoint turn

- **WHEN** the supervisor (or a non-session sub-agent) calls a tool that requires `EarSessionHandle`
- **THEN** the tool SHALL throw `ToolUsedOutsideSessionError`
- **AND** the error SHALL be surfaced to the calling LLM as a normal tool-call error

