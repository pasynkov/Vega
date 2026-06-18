## ADDED Requirements

### Requirement: `ConversationModule` SHALL be the single public-facing module for domains

`ConversationModule` SHALL be marked `@Global()` and SHALL re-export `AgentRegistry` (from `conversation/kernel/`) and `FlushHookRegistry` (from `conversation/sessions/`) in its `exports:` array, so that any module that imports `ConversationModule` can have those two services injected into its constructor.

A domain module under `apps/core/src/domains/` SHALL import `ConversationModule` (and nothing else from the pipeline) in its `@Module({ imports: [...] })` array to obtain `AgentRegistry` and `FlushHookRegistry`. Domain modules SHALL NOT import `EarModule`, `EarSessionsModule`, `EarGateway`, `EarRegistry`, `SessionService`, or `WakeCoordinator` directly.

#### Scenario: A domain module wires itself up

- **WHEN** a domain module declares `@Module({ imports: [ConversationModule] })` and injects `AgentRegistry` and `FlushHookRegistry` into its constructor
- **THEN** NestJS DI SHALL resolve both services without error
- **AND** the domain's `OnModuleInit` SHALL be able to call `AgentRegistry.register(spec)` and `FlushHookRegistry.set(name, hook)` against the same instances the orchestration kernel uses at runtime

#### Scenario: A domain module attempts to import the ear pipeline

- **WHEN** a domain module's `@Module({ imports: [...] })` array contains `EarModule` or `EarSessionsModule`
- **THEN** the change SHALL be rejected at code review as a violation of the domain-isolation contract
