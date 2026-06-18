## Context

`apps/core/src/` currently holds 13 sibling directories with no organizing principle:

```
src/
├── agents/        ← orchestration runtime (registry, factories, supervisor)
├── conversation/  ← root turn-handling service
├── config/        ← env config
├── db/            ← TypeORM datasource
├── deepgram/      ← Deepgram STT client
├── ear/           ← WebSocket gateway + transport-level wiring
├── ear-sessions/  ← glue: routes audio finals into the orchestrator
├── llm/           ← Anthropic client + model registry
├── memory/        ← MemoryService + remember tool + memory agent spec
├── notes/         ← notes domain (short + long-note)
├── recording/     ← audio file persistence
├── session/       ← per-session audio + transcript pipeline
└── wake/          ← wake-word coordinator
```

Self-registration via `AgentRegistry.register(spec)` in `OnModuleInit` already works (see `apps/core/src/notes/notes.module.ts:14-23` and `apps/core/src/memory/memory.module.ts:28-37`). The mechanism is sound; what is missing is (a) a directory layout that surfaces the four kinds of module that live in this codebase, and (b) an explicit contract listing what a domain module is allowed to depend on.

The change is a pure refactor: file moves + relative-import rewrites + one small behavioral change (memory drops its `AgentSpec` registration). No business logic moves; no runtime semantics change beyond the supervisor no longer seeing `memory_search` in its routing table.

Stakeholders: the only consumer of `apps/core/src/` internals is `apps/core` itself. `mac-ear` and `packages/ear-protocol` are unaffected.

## Goals / Non-Goals

**Goals:**

- One organizing principle for every module in `apps/core/src/`: each module lands in exactly one of `integrations/`, `conversation/`, `tools/`, `domains/`, and the choice is mechanical given the kind of module.
- Domain modules import `ConversationModule` and nothing else from the pipeline. They never reach into `EarModule`, `EarSessionsModule`, `SessionService`, `EarRegistry`, or `WakeCoordinator`. This is enforced by reading import statements in code review and by the contract e2e test.
- A single contract e2e test bootstraps the real `AppModule` (with mocked external clients) and asserts the registration contract holds. The same test passes before and after the refactor — it is the proof the refactor preserved behavior.

**Non-Goals:**

- New domains, new tools, new integrations.
- Changes to runtime behavior beyond removing the memory `AgentSpec`.
- Changes to any external API, wire protocol, file path, env var, or DB schema.
- Refactoring code inside each moved module (only paths in imports change).
- Splitting modules into smaller pieces, merging modules, or extracting interfaces.

## Decisions

### Decision: Four top-level categories, not three or five

The categories are `integrations/`, `conversation/`, `tools/`, `domains/`. Each maps to a different kind of dependency:

| Category | What it is | Depends on |
|---|---|---|
| `integrations/` | Adapters to external systems (DB, LLM API, STT API) | external SDKs only |
| `conversation/` | The voice pipeline + orchestration kernel | `integrations/` |
| `tools/` | Side-services callable by domains (memory store + `remember` tool) | `integrations/` |
| `domains/` | Self-registering capabilities the supervisor can route to | `conversation/` (kernel re-exports), `tools/` |

**Alternatives considered:**

- *Three categories* (drop `tools/`, fold memory into `domains/`): rejected because memory is no longer a supervisor-routable domain — it has no `AgentSpec` after this change. Putting it in `domains/` would be misleading.
- *Five categories* (separate `kernel/` from `conversation/`): rejected. The orchestration kernel (`AgentRegistry`, `GraphFactory`, supervisor) only makes sense in the context of `conversation/`; nothing outside `conversation/` consumes the kernel except domains, and domains reach it through `ConversationModule`. Hiding the kernel inside `conversation/kernel/` is enough.

### Decision: `conversation/` is one root with four sub-areas, flat inside

```
conversation/
├── kernel/        ← AgentRegistry, GraphFactory, tool-factory,
│                    sub-agent.factory, agent.tokens, agent.types,
│                    supervisor/{...}
├── ear/           ← gateway, registry, session/, recording/, wake/
├── sessions/      ← (was ear-sessions/) router, runner, flush-hook
│                    registry, session handle, errors
├── conversation.service.ts
├── session-registry.service.ts
└── conversation.module.ts
```

`wake/`, `session/`, and `recording/` collapse into `conversation/ear/` as subdirectories. They are all parts of the audio capture pipeline that only the `EarModule` consumes. Flat-inside-`ear/` was chosen over nested-by-domain because the four pieces of the pipeline (gateway, wake, session, recording) are siblings and need to import each other freely.

**Alternative considered:** keep `wake/`, `session/`, `recording/` as siblings of `ear/` under `conversation/`. Rejected — they have no consumer outside the audio pipeline, so giving them peer status is noise.

### Decision: `ConversationModule` is the only public-facing module for domains

After the refactor, `ConversationModule` re-exports `AgentRegistry` (from `conversation/kernel/`) and `FlushHookRegistry` (from `conversation/sessions/`). A domain module's `imports:` array contains `ConversationModule` and nothing else from the pipeline. The contract is enforced by reading the domain module file in code review; the e2e test verifies the resulting wiring works end-to-end.

This concretely means `NotesModule` changes from:

```ts
@Module({ imports: [EarModule, EarSessionsModule], ... })
```

to:

```ts
@Module({ imports: [ConversationModule], ... })
```

`ConversationModule` becomes a `@Global()` module so domains do not need to repeat the import transitively. `MemoryModule` (now under `tools/`) is consumed by direct import; it does not need `ConversationModule` because it no longer registers an `AgentSpec`.

**Alternative considered:** a `DomainKitModule` that re-exports the registries. Rejected as one indirection too many; `ConversationModule` is already the obvious home for the domain-facing surface.

### Decision: Memory drops its `AgentSpec` registration

`MemoryAgentService.spec` is no longer registered with `AgentRegistry`. The supervisor will not see `memory_search` in its routing table. The class itself can stay (returning the spec object) or be deleted in this change — we delete it to avoid dead code. `MemoryService` and `RememberToolProvider` remain.

If a future change wants supervisor-level memory routing, it adds back a memory domain (likely under `domains/memory/`) that wraps `MemoryService` from `tools/memory/`. The split between "memory the storage" and "memory the routable domain" is now explicit in the directory tree.

**Why:** the user already runs `remember` as a fire-and-forget tool from other domains; the supervisor-level `memory_search` route was not exercised. Removing it now keeps the supervisor routing table small and the memory module's responsibilities single.

### Decision: TDD-style refactor sequence

```
Step 1 — Baseline   : add contract e2e test against current tree;
                       run full test suite; commit when green.
Step 2 — Move files : git mv directories per the migration map;
                       global find-replace import paths;
                       update AppModule import paths;
                       run full test suite; commit when green.
Step 3 — Contract   : delete MemoryAgentService AgentSpec
                       registration; make ConversationModule
                       re-export the registries; switch
                       NotesModule.imports to [ConversationModule];
                       update contract e2e expectations (drop
                       memory_search from expected list); run
                       full test suite; commit when green.
```

The baseline contract e2e test is what makes the file moves safe — it asserts behavior survives the move before any contract changes. Step 3 is the only step that changes observable behavior (one `AgentSpec` disappears).

**Alternative considered:** one big PR with all three steps. Rejected because if the contract e2e test fails after a single commit it's clear which step broke it; merging the steps obscures that.

### Decision: Migration map (one-shot table)

| Current path | New path |
|---|---|
| `src/db/` | `src/integrations/database/` |
| `src/llm/` | `src/integrations/llm/` |
| `src/deepgram/` | `src/integrations/deepgram/` |
| `src/agents/` | `src/conversation/kernel/` |
| `src/agents/supervisor/` | `src/conversation/kernel/supervisor/` |
| `src/wake/` | `src/conversation/ear/wake/` |
| `src/session/` | `src/conversation/ear/session/` |
| `src/recording/` | `src/conversation/ear/recording/` |
| `src/ear/` | `src/conversation/ear/` |
| `src/ear-sessions/` | `src/conversation/sessions/` |
| `src/conversation/` | `src/conversation/` (root files stay) |
| `src/memory/` | `src/tools/memory/` |
| `src/notes/` | `src/domains/notes/` |
| `src/config/` | `src/config/` (unchanged) |
| `src/types/` | `src/types/` (unchanged) |

## Risks / Trade-offs

- **[Risk] git history continuity** — large directory moves can confuse `git log --follow` if individual files are renamed in the same commit as their directory move. → **Mitigation:** use `git mv <dir> <new-dir>` per directory; do not edit file contents in the same commit as the move. Step 2's commit is paths-only.

- **[Risk] test imports use relative paths that all break at once** — `tsc` compilation will fail in many files simultaneously after step 2; fixing them piecemeal is slow. → **Mitigation:** apply a single global find-replace against `apps/core/{src,tests}/**/*.ts` keyed off the migration map. Run `tsc --noEmit` after each find-replace pass; stop when it goes green.

- **[Risk] contract e2e test masks an import-cycle regression** — Nest can boot with a circular module graph; the e2e test would still pass while the cycle slows down boot or causes nondeterministic init order. → **Mitigation:** after step 2, run `npx nx graph` or `madge --circular apps/core/src` (or equivalent) and require zero cycles. Add this as a CI gate in a follow-up change; out of scope here.

- **[Risk] supervisor changes routing silently** — removing the `memory_search` `AgentSpec` changes the supervisor's behavior on prompts like "вспомни X". → **Mitigation:** explicit acceptance in the proposal; the user has confirmed memory is to stay as a tool. The proposal calls out reintroduction in a future spec.

- **[Trade-off] flat `conversation/ear/` collapses three former top-level modules** — colocating `gateway`, `wake`, `session`, `recording` makes the audio pipeline more compact but makes `ear/` the largest single directory in the tree. Acceptable; nothing else needs these files.

- **[Trade-off] `@Global()` on `ConversationModule`** — convenient for domains but hides the dependency from the module graph. Acceptable because the domain contract is explicit: domains rely on `ConversationModule`'s registries by design, not by accident.

## Migration Plan

This is an in-place refactor on `main`; there is no production deployment to gate.

1. Land step 1 (baseline contract e2e) as its own commit / PR.
2. Land step 2 (file moves + import rewrites) as its own commit / PR. Reviewer's job is to read the diff for the migration table and confirm `tsc` + `vitest` are green.
3. Land step 3 (memory spec drop + `ConversationModule` re-exports) as its own commit / PR. Reviewer's job is to confirm the contract e2e test was updated to drop `memory_search` from the expected `AgentRegistry` list and still passes.

Rollback: revert the commit. No DB migration, no env var change, no protocol change.

## Open Questions

- *Should we land all three steps in one PR or three?* — Default to three for reviewer sanity. If the user prefers one PR for speed, the order above still applies as commits inside that PR. Decided at PR time, not in this spec.
- *Should `conversation/ear/wake/` keep `wake-coordinator.ts` as a single file or grow a folder?* — Single file for now; if a future change adds multi-Ear scoring it becomes a folder. Not blocking this refactor.
