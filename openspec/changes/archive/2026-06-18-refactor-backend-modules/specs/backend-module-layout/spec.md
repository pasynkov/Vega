## ADDED Requirements

### Requirement: `apps/core/src/` SHALL be organized into four top-level categories

Every NestJS module under `apps/core/src/` SHALL live inside exactly one of four top-level directories: `integrations/`, `conversation/`, `tools/`, `domains/`. The choice of directory for any module SHALL be determined by which of the four rules below the module satisfies.

- `integrations/` — adapters to external systems (databases, third-party APIs, SDKs). Modules under `integrations/` SHALL NOT import from `conversation/`, `tools/`, or `domains/`.
- `conversation/` — the voice/turn-handling pipeline plus the orchestration kernel. Modules under `conversation/` MAY import from `integrations/` and from peer modules under `conversation/`; they SHALL NOT import from `domains/` and SHALL NOT import from `tools/`.
- `tools/` — side-services callable by domain modules (e.g. the memory store and its `remember` tool). Modules under `tools/` MAY import from `integrations/`; they SHALL NOT import from `conversation/` or `domains/`.
- `domains/` — self-registering capabilities the supervisor can route to. Domain modules MAY import from `tools/` directly and MAY import `ConversationModule` to obtain `AgentRegistry` and `FlushHookRegistry`; they SHALL NOT import any other module under `conversation/`.

Two existing directories — `apps/core/src/config/` and `apps/core/src/types/` — are unaffected and remain at the top level.

#### Scenario: Adding a third-party REST client module

- **WHEN** an engineer adds a new module that wraps a third-party REST API
- **THEN** the module SHALL be placed under `apps/core/src/integrations/<name>/`
- **AND** its only imports SHALL be from `node_modules/`, from `apps/core/src/config/`, and from `apps/core/src/types/`

#### Scenario: Adding a routable domain

- **WHEN** an engineer adds a new domain that the supervisor should be able to route to
- **THEN** the module SHALL be placed under `apps/core/src/domains/<name>/`
- **AND** the module's `imports:` array SHALL contain `ConversationModule` and SHALL NOT contain `EarModule`, `EarSessionsModule`, or any other internal pipeline module

#### Scenario: Adding a non-routable side-service used by domains

- **WHEN** an engineer adds a side-service that domains call directly (e.g. a vector store, a calendar gateway) but that should not register an `AgentSpec` with the supervisor
- **THEN** the module SHALL be placed under `apps/core/src/tools/<name>/`
- **AND** consuming domains SHALL import the side-service's service classes directly (e.g. `import { FooService } from "../../tools/foo"`)

### Requirement: `conversation/` SHALL contain exactly four sub-areas plus root files

The `conversation/` directory SHALL be organized as follows:

- `conversation/kernel/` — the orchestration runtime: `AgentRegistry`, `GraphFactory`, `tool-factory`, `sub-agent.factory`, `agent.tokens`, `agent.types`, and `supervisor/` (containing the supervisor graph nodes and prompts).
- `conversation/ear/` — the audio capture pipeline: WebSocket gateway, ear registry, the per-session audio + transcript pipeline, the recording-store, and the wake-word coordinator. Subdirectories `ear/session/`, `ear/recording/`, and `ear/wake/` are permitted but optional.
- `conversation/sessions/` — the glue layer between the ear pipeline and the orchestrator: session router, session agent runner, flush-hook registry, session-handle types, session errors.
- `conversation/conversation.service.ts`, `conversation/session-registry.service.ts`, `conversation/conversation.module.ts` — root-level files for the `ConversationModule` itself.

No other sub-area SHALL be added to `conversation/` without modifying this requirement.

#### Scenario: Searching for the supervisor prompt

- **WHEN** an engineer wants to read or edit the supervisor system prompt
- **THEN** the file SHALL be located under `apps/core/src/conversation/kernel/supervisor/`

#### Scenario: Searching for the audio file writer

- **WHEN** an engineer wants to read or edit the audio recording-store
- **THEN** the file SHALL be located under `apps/core/src/conversation/ear/` (or a subdirectory thereof)

### Requirement: Domain modules SHALL self-register through the kernel contract

A domain module SHALL register itself with the orchestration kernel in its `OnModuleInit` hook by calling `AgentRegistry.register(spec)` with its `AgentSpec`. A domain module MAY additionally register a flush hook by calling `FlushHookRegistry.set(name, hook)` if it participates in long-running session capture. A domain module SHALL NOT register itself by any other mechanism (no `AGENT_SPEC` multi-providers, no static imports into the supervisor, no module-level side effects).

Both `AgentRegistry` and `FlushHookRegistry` SHALL be obtained by the domain module by importing `ConversationModule` in its `@Module({ imports: [...] })` array. `ConversationModule` SHALL be marked `@Global()` so the import does not need to be repeated transitively.

#### Scenario: A new domain module boots and self-registers

- **WHEN** `AppModule` boots and a domain module `FooModule` is included in its `imports:` array
- **THEN** `FooModule.onModuleInit()` SHALL execute exactly once
- **AND** after `AppModule` finishes initialization, `AgentRegistry.list()` SHALL contain the `AgentSpec` returned by `FooModule`'s `AgentSpec` provider
- **AND** if `FooModule` registered a flush hook for name `"foo"`, `FlushHookRegistry.get("foo")` SHALL return that hook

#### Scenario: A domain module attempts to reach into the ear pipeline directly

- **WHEN** a code-review reviewer reads a domain module's source file and sees `EarModule`, `EarSessionsModule`, `AgentSystemModule`, or `SupervisorModule` listed inside the module's `@Module({ imports: [...] })` array
- **THEN** the reviewer SHALL reject the change as a violation of this requirement
- **AND** the domain module SHALL be rewritten to declare `imports: [ConversationModule]` instead — type-only TypeScript imports of specific service classes (used to declare constructor parameter types) are not a violation

### Requirement: A contract end-to-end test SHALL verify the domain-registration wiring at boot

`apps/core/tests/e2e/contract.e2e.test.ts` SHALL bootstrap the real `AppModule` via `NestFactory.create` with mocked Deepgram and LLM clients, then assert that the post-boot `AgentRegistry` state and `FlushHookRegistry` state match the expected set of registered domains, and that `ConversationService.handleTurn` can drive one short exchange end-to-end through the real wiring.

The mocked LLM SHALL be deterministic — given a known input transcript it SHALL produce a known supervisor routing decision — so the test does not call the real Anthropic API. The mocked Deepgram client SHALL never connect to a network socket.

The test SHALL pass both before the file-reorganization commit and after it; the post-refactor test SHALL additionally assert that `AgentRegistry.list()` does NOT contain a `memory_search` spec (because memory becomes a tool in this same change).

#### Scenario: Test runs against the pre-refactor tree

- **WHEN** the contract e2e test is executed against the pre-refactor source tree
- **THEN** the test SHALL pass
- **AND** `AgentRegistry.list()` SHALL contain the `notes` `AgentSpec`

#### Scenario: Test runs against the post-refactor tree

- **WHEN** the contract e2e test is executed against the post-refactor source tree
- **THEN** the test SHALL pass
- **AND** `AgentRegistry.list()` SHALL contain the `notes` `AgentSpec`
- **AND** `AgentRegistry.list()` SHALL NOT contain a `memory_search` `AgentSpec`
- **AND** `FlushHookRegistry.get("notes")` SHALL return a non-null hook
- **AND** `ConversationService.handleTurn(sessionId, "купить молоко")` SHALL resolve with `outcome === "acted"` under the mocked supervisor
