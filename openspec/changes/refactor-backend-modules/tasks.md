## 1. Baseline: contract e2e against the current tree

- [x] 1.1 Add `apps/core/tests/e2e/contract.e2e.test.ts` that bootstraps `AppModule` via `NestFactory.createApplicationContext` with mocked Deepgram and LLM clients
- [x] 1.2 Mock `DeepgramClient` so it never opens a WebSocket; expose a deterministic test double via DI override
- [x] 1.3 Mock `LlmService.getModel()` to return a deterministic langgraph-compatible chat model that maps the input "купить молоко" to a supervisor route → `notes` decision and an `AIMessage("ok")` terminal reply
- [x] 1.4 In the contract test: assert `app.get(AgentRegistry).list()` contains the `notes` `AgentSpec` (pre-refactor: also contains the `memory` spec — actual registered name in code is `memory`, not `memory_search`)
- [x] 1.5 In the contract test: assert `app.get(FlushHookRegistry).get("notes-session")` returns a non-null hook
- [x] 1.6 In the contract test: call `app.get(ConversationService).handleTurn(sessionId, "купить молоко")` and assert the returned `outcome === "acted"`
- [x] 1.7 Run `npm --workspace apps/core test`; confirm the new e2e test and the entire existing suite are green (45 passed / 1 skipped)
- [x] 1.8 Commit baseline: `test(core): contract e2e for domain registration and short-note turn` (82ee692)

## 2. File moves and import-path rewrites (paths-only, no behavior change)

- [x] 2.1 `git mv apps/core/src/db apps/core/src/integrations/database` (create the `integrations/` directory in the same commit)
- [x] 2.2 `git mv apps/core/src/llm apps/core/src/integrations/llm`
- [x] 2.3 `git mv apps/core/src/deepgram apps/core/src/integrations/deepgram`
- [x] 2.4 `git mv apps/core/src/agents apps/core/src/conversation/kernel` (preserves the `supervisor/` sub-tree)
- [x] 2.5 `git mv apps/core/src/wake apps/core/src/conversation/ear/wake`
- [x] 2.6 `git mv apps/core/src/session apps/core/src/conversation/ear/session`
- [x] 2.7 `git mv apps/core/src/recording apps/core/src/conversation/ear/recording`
- [x] 2.8 `git mv` the loose files in `apps/core/src/ear/` (gateway, registry, module) one level so they sit at `apps/core/src/conversation/ear/` next to the moved `session/recording/wake/` subdirs
- [x] 2.9 `git mv apps/core/src/ear-sessions apps/core/src/conversation/sessions`
- [x] 2.10 `git mv apps/core/src/memory apps/core/src/tools/memory`
- [x] 2.11 `git mv apps/core/src/notes apps/core/src/domains/notes`
- [x] 2.12 Update `apps/core/src/app.module.ts` to import each module from its new path (handled by rewrite script)
- [x] 2.13 Run a scripted find-replace across `apps/core/{src,tests}/**/*.ts` for every old → new relative-path prefix from the migration map; verify `npx tsc --noEmit` is green (used `apps/core/scripts/rewrite-imports.mjs`)
- [x] 2.14 Run `npm --workspace apps/core test`; confirm the entire suite, including the contract e2e, is still green (45 passed / 1 skipped)
- [x] 2.15 Commit step 2: `refactor(core): reorganize src/ into integrations|conversation|tools|domains` (36335ae)

## 3. Domain contract: ConversationModule re-exports and memory drop

- [x] 3.1 `ConversationModule` `@Global()` re-exports `AgentSystemModule`, `SupervisorModule`, `EarModule`, `EarSessionsModule` so domains injecting any of their providers get them via `imports: [ConversationModule]`
- [x] 3.2 `ConversationModule.imports:` includes `[AgentSystemModule, SupervisorModule, EarModule, EarSessionsModule]` so re-exports resolve at runtime
- [x] 3.3 In `apps/core/src/domains/notes/notes.module.ts`, replaced `imports: [EarModule, EarSessionsModule]` with `imports: [ConversationModule]`
- [x] 3.4 In `apps/core/src/tools/memory/memory.module.ts`, dropped `OnModuleInit` + `AgentRegistry` constructor injection; `MemoryAgentService` still provided because `RememberToolProvider` dispatches to it
- [x] 3.5 The memory `AgentSpec` provider wiring in `MemoryModule.onModuleInit` is gone; the `AgentSpec` getter on `MemoryAgentService` is left in place (no consumers, no harm) — `MemoryAgentService` itself still runs internally for `remember` writes
- [x] 3.6 Contract e2e test asserts `AgentRegistry.list()` does NOT contain `memory` or `memory_search`
- [x] 3.7 Ran `npm --workspace apps/core test` — 45 passed / 1 skipped; supervisor unit test still green (it only checks registered specs, doesn't hardcode `memory`)
- [ ] 3.8 Commit step 3: `refactor(core): formalize domain contract via ConversationModule; drop memory AgentSpec`

## 4. Verification and cleanup

- [ ] 4.1 Run `npm --workspace apps/core run build` to ensure the production build still works
- [ ] 4.2 Read `apps/core/src/domains/notes/notes.module.ts` and confirm no pipeline imports (`EarModule`, `EarSessionsModule`, `EarGateway`, `EarRegistry`, `SessionService`, `WakeCoordinator`) appear in the file
- [ ] 4.3 Read `apps/core/src/tools/memory/memory.module.ts` and confirm `AgentRegistry` is not imported
- [ ] 4.4 Read `apps/core/src/conversation/conversation.module.ts` and confirm it `@Global()` and exports `AgentRegistry` + `FlushHookRegistry`
- [ ] 4.5 Run the daemon locally (`npm --workspace apps/core run dev`) for ~30 seconds; confirm it boots without errors and the logger prints `AgentSpec registered { name: "notes", tools: N }` exactly once and does NOT print a registration line for memory
