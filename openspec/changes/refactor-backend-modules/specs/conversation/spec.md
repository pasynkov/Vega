## ADDED Requirements

### Requirement: `ConversationModule` SHALL be the single public-facing module for domains

`ConversationModule` SHALL be marked `@Global()` and SHALL re-export every other module under `conversation/` whose providers a domain might legitimately inject (kernel registries, session-control services, flush-hook registry). A domain module that does `imports: [ConversationModule]` SHALL be able to inject `AgentRegistry`, `FlushHookRegistry`, and any other service the kernel chooses to expose, without naming any pipeline module in its own `imports:` array.

A domain module under `apps/core/src/domains/` SHALL import **only** `ConversationModule` from the pipeline in its `@Module({ imports: [...] })` array. The forbidden tokens in a domain module's `imports:` array are `EarModule`, `EarSessionsModule`, `AgentSystemModule`, `SupervisorModule`, or any future pipeline module. Type-only references to specific service classes (e.g. `private sessions: SessionService`) are permitted — the contract is about the `@Module({ imports: [...] })` graph, not TypeScript type references.

#### Scenario: A domain module wires itself up

- **WHEN** a domain module declares `@Module({ imports: [ConversationModule] })` and injects `AgentRegistry` and `FlushHookRegistry` into its constructor
- **THEN** NestJS DI SHALL resolve both services without error
- **AND** the domain's `OnModuleInit` SHALL be able to call `AgentRegistry.register(spec)` and `FlushHookRegistry.set(name, hook)` against the same instances the orchestration kernel uses at runtime

#### Scenario: A domain module attempts to import the ear pipeline

- **WHEN** a domain module's `@Module({ imports: [...] })` array contains `EarModule`, `EarSessionsModule`, `AgentSystemModule`, or `SupervisorModule`
- **THEN** the change SHALL be rejected at code review as a violation of the domain-isolation contract
- **AND** the domain SHALL be rewritten to obtain those providers via `imports: [ConversationModule]` instead
