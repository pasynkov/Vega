## Why

The `apps/core` backend has grown to 13 top-level module directories with no organizing principle: integration clients (`db`, `llm`, `deepgram`), orchestration runtime (`agents`), audio pipeline (`ear`, `session`, `wake`, `recording`, `ear-sessions`), domains (`notes`), and cross-cutting tools (`memory`) all sit side-by-side. New domains will keep landing — at the current rate of growth the top level becomes unreadable and the contract a new domain must satisfy is implicit, scattered across `EarModule`, `EarSessionsModule`, and `AgentRegistry`. We need an explicit domain contract and a directory layout that surfaces it before the next domain lands.

## What Changes

- **Reorganize `apps/core/src/` into four top-level categories**: `integrations/` (deepgram, database, llm), `conversation/` (root pipeline: kernel + ear + sessions + wake), `tools/` (side-services: memory), `domains/` (notes).
- **Formalize domain self-registration contract**: a domain module imports **only** `ConversationModule` (which re-exports `AgentRegistry` and `FlushHookRegistry`), registers its `AgentSpec` in `OnModuleInit`, and optionally registers a flush hook. Domains SHALL NOT import `EarModule`, `EarSessionsModule`, `SessionService`, or other pipeline internals directly.
- **Memory becomes a pure tool, not a domain**: `MemoryAgentService` SHALL no longer register a `memory_search` `AgentSpec` with the supervisor. `MemoryService` and `RememberToolProvider` remain available via direct import from `tools/memory/`. A future change can reintroduce supervisor-level memory routing if needed.
- **Add a contract end-to-end test** (`apps/core/tests/e2e/contract.e2e.test.ts`) that bootstraps the full `AppModule` with mocked Deepgram and LLM clients, asserts the post-init `AgentRegistry` and `FlushHookRegistry` state, and drives one `ConversationService.handleTurn()` short-note exchange through the real wiring.
- **BREAKING** (internal only): every `import "../<module>/..."` inside `apps/core/src/` changes path. No public API or wire-protocol change.

Out of scope: new domains, new tools, runtime behavior changes, transport / API changes, any change to `mac-ear` or `ear-protocol`.

## Capabilities

### New Capabilities

- `backend-module-layout`: defines the four-category source layout for `apps/core/src/` (`integrations/`, `conversation/`, `tools/`, `domains/`), the placement rule for each kind of module, and the domain-registration contract — what a domain module is allowed to import and what it must do in `OnModuleInit`. Future "where does this live?" decisions resolve against this spec.

### Modified Capabilities

- `memory`: drop the requirement that `MemoryAgentService` registers a `memory_search` `AgentSpec` with the supervisor `AgentRegistry`. `MemoryService` write/search behavior and the `rememberTool` are unchanged.
- `conversation`: add a requirement that `ConversationModule` is the single public-facing module domains import to obtain `AgentRegistry` and `FlushHookRegistry` (re-exported). Existing `handleTurn`, checkpointer, and session-registry requirements are unchanged.

## Impact

- **Affected code (move + import-path rewrite)**: every file under `apps/core/src/` (13 directories migrate; all relative imports rewrite). Roughly 60-80 files touch import paths only; no logic edits.
- **Affected tests**: all files under `apps/core/tests/` rewrite their relative imports against the new tree. New `tests/e2e/contract.e2e.test.ts`.
- **NestJS module graph**: `NotesModule` and `MemoryModule` stop importing `EarModule` / `EarSessionsModule` directly; they import `ConversationModule` instead. `ConversationModule` re-exports `AgentRegistry` and `FlushHookRegistry`.
- **Dependencies**: none added or removed.
- **APIs**: no external API change. Internal NestJS DI tokens (`MEMORY_SEARCH_PORT`, `CHECKPOINTER`, etc.) keep their identifiers but move with their modules.
- **Risk**: pure refactor; correctness gated by (a) the new contract e2e test going green before and after, and (b) the existing vitest suite continuing to pass.
