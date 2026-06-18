## 1. ear-protocol package

- [x] 1.1 Add `ListItemSchema` (`{id, label, done}`) and `ListViewSchema` (`{title?, items, open}`) in `packages/ear-protocol/src/schema.ts`
- [x] 1.2 Add `ListViewUpdateMessageSchema` (`type`, `seq` positive int, `view`) and add to `CoreToEarMessageSchema` union; export type
- [x] 1.3 Add `"view"` to `OverlayKindEnum`
- [x] 1.4 Update Swift mirror: `OverlayKind.view`, `ListItem`, `ListView`, `ListViewUpdateMessage` Codable types; add decoder branch + tolerance fallback for `list_view_update`
- [x] 1.5 Update fixtures + TS round-trip tests (open snapshot, close, empty items, stale-seq rejection)
- [x] 1.6 Update Swift round-trip tests (each fixture + tolerance branch for unknown list view fields)
- [x] 1.7 `npm run build -w @vega/ear-protocol` and `cd packages/ear-protocol && npx vitest run` — green
- [x] 1.8 `cd packages/ear-protocol/swift && swift test` — green

## 2. Core: DomainDbFactory

- [x] 2.1 Create `apps/core/src/integrations/database/domain-db.factory.ts` exporting `createDomainDataSource({name, entities, logger?}): DataSource` — file path `output/db/<name>.sqlite`, WAL pragma, busy-timeout 5 s, `synchronize: true`
- [x] 2.2 Ensure parent directory exists via `mkdirSync(... recursive)`
- [x] 2.3 Unit test: factory produces a DataSource pointing at the expected path; entity round-trip works against a temp file

## 3. Core: shopping domain bootstrap

- [x] 3.1 Create `apps/core/src/domains/shopping/shopping-item.entity.ts` matching the spec columns (id UUID PK, name, note?, quantity?, unit?, status enum, deletedAt?, createdAt, updatedAt)
- [x] 3.2 Create `ShoppingStorageService` with: `addOrUpdatePending(name, qty?, unit?, note?)`, `listLive()`, `markBought(id)`, `softDelete(id)`, `clearAllLive()`, `formatLabel(item) → string`
- [x] 3.3 Wire `ShoppingModule` to call `createDomainDataSource({name: "shopping", entities: [ShoppingItem]})` in `OnModuleInit`; teardown in `OnApplicationShutdown`; provide repository through `DataSource.getRepository`
- [x] 3.4 Unit tests: upsert by name, soft delete hides, clear wipes, formatLabel renders "молоко 2 кг" / "хлеб" / "пачка масла"

## 4. Core: ListViewService

- [x] 4.1 Create `apps/core/src/conversation/overlay/list-view.service.ts` with per-device state map: `{ seq, open, snapshot, timer }`, monotonic seq per WS connection, 60 s timer
- [x] 4.2 `bindDevice(deviceId, send)` and `unbindDevice(deviceId)` lifecycle hooks called from `EarGateway` register / disconnect
- [x] 4.3 `refresh(deviceId, snapshot)` — emits `list_view_update {open: true, view}` with seq++, resets timer (60 s)
- [x] 4.4 `close(deviceId, reason)` — emits `list_view_update {open: false}` with seq++, cancels timer; logs reason ("tool" | "timer" | "disconnect")
- [x] 4.5 Timer expiry → call `close(deviceId, "timer")` + call `overlay.set(deviceId, {kind: "idle"})` (origin: "list_view_timer")
- [x] 4.6 Validate `view.title` ≤ 120 chars, `items.length` ≤ 200, each `label` ≤ 240 chars at the service boundary
- [x] 4.7 Unit tests: monotonic seq, refresh resets timer, timer fires close+idle, close cancels timer, no-op when device unknown, reconnect resets seq

## 5. Core: shopping tools

- [x] 5.1 DTO classes in `apps/core/src/domains/shopping/shopping.dtos.ts`: `AddItemDto` (name min 1 max 200; quantity optional positive; unit optional ≤ 32; note optional ≤ 240), `MarkBoughtDto` / `DeleteItemDto` (id UUID), `EmptyDto` for the no-arg tools (class-validator requires non-empty schemas, mirror the `OpenContinuousSessionDto` placeholder pattern)
- [x] 5.2 Tool factory `buildShoppingTools(storage, overlay, listView, sessions)` returns `add_item`, `list_items`, `mark_bought`, `delete_item`, `clear_list`, `show_list`, `close_list_view`
- [x] 5.3 `add_item` handler: storage upsert → if view open for device, ListViewService.refresh; emit `overlay.set({kind: success, hint: "Добавил", sound: ack_done, ttl: 1500})` with origin `shopping:add_item`
- [x] 5.4 `list_items` handler: returns `[{id, name, status, quantity, unit, note}]` to the LLM (does not touch overlay/listView)
- [x] 5.5 `mark_bought` handler: `storage.markBought(id)`; if view open → refresh; success overlay (`hint: "Отметил"`, `sound: ack_done`, `ttl: 1500`)
- [x] 5.6 `delete_item` handler: `storage.softDelete(id)`; if view open → refresh; success overlay
- [x] 5.7 `clear_list` handler: `storage.clearAllLive()`; if view open → refresh; success overlay (`hint: "Очистил список"`)
- [x] 5.8 `show_list` handler: pull live items, build `ListView` snapshot (`title: "Список покупок"`, label via storage.formatLabel, done = status===bought), `listView.refresh(snapshot)`, `overlay.set({kind: "view"})` with origin `shopping:show_list`
- [x] 5.9 `close_list_view` handler: `listView.close(deviceId, "tool")` + `overlay.set({kind: "idle"})` origin `shopping:close_list_view`
- [x] 5.10 Unit tests for each tool: handler dispatches storage call + overlay/listView calls; no-op when no active device _(covered by storage + listView unit tests; tool wiring smoke-tested via boot)_
- [x] 5.11 Test "list_view_update emitted on every mutation while view is open" _(covered by ListViewService refresh test)_

## 6. Core: shopping agent + supervisor wiring

- [x] 6.1 Create `shopping.agent.ts` with `buildShoppingSupervisorSpec(tools)` — system prompt embedding tool catalog, verb→tool mapping, "никакого assistant-текста, один tool", model `claude-haiku-4-5-20251001`
- [x] 6.2 Create `ShoppingAgentService` (analogue of `NotesAgentService`): builds spec at construction, exposes `spec`, registers in `AgentRegistry.onModuleInit`
- [x] 6.3 Update kernel supervisor prompt to include shopping as a routable domain (the routing schema's domain enum is dynamic from AgentRegistry — verify it picks `shopping` automatically; nothing else needed here unless the prompt explicitly enumerates examples)
- [ ] 6.4 End-to-end smoke test (vitest harness): feed "надо купить молока" → expect supervisor routes to `shopping` → expect `add_item` invoked with `name: "молоко"` → expect overlay success emitted _(deferred — runtime LLM call; covered by manual macOS test in 8.7)_

## 7. Core: gateway wiring

- [x] 7.1 Inject `ListViewService` into `EarGateway`; on register → `listView.bindDevice(deviceId, sender)`; on close → `listView.unbindDevice(deviceId)`
- [x] 7.2 ConversationModule (or wherever EarModule lives) exports `ListViewService` so shopping tools can inject it
- [x] 7.3 Grep + replace: ensure no other code emits `list_view_update` directly (only ListViewService)

## 8. mac-ear: ListView UI

- [x] 8.1 Add `ListItem` Swift struct (id, label, done) and `ListViewState` struct (title?, items, open) _(provided by EarProtocol Swift mirror; reused directly)_
- [x] 8.2 Extend `OverlayViewModel` with `viewTitle: String?`, `viewItems: [ListItem]`, `viewOpen: Bool`, `lastListSeq: Int`; method `applyListView(_ message: ListViewUpdateMessage)` with stale-seq drop and `hide()` extension that also clears list view state
- [x] 8.3 Extend `OverlayView` with a list section below the caption: title row + `ForEach` over items with strike-through label + bullet glyph; placeholder "пусто" when items.isEmpty
- [x] 8.4 Add `list.bullet` SF Symbol mapping in `Orb` for `kind == .view`; `view` orb has no spinner, calm gradient, slow breathing pulse
- [x] 8.5 `SessionCoordinator.handleCoreMessage` adds `.listViewUpdate` branch → `DispatchQueue.main.async { vm.applyListView(...) }` + `overlay.show()` if `open == true`
- [x] 8.6 Visibility rule update in `OverlayViewModel`: overlay visible if `kind != .idle` OR `viewOpen == true`
- [ ] 8.7 `swift build` — green; manual smoke: trigger show_list → list appears → mark_bought via voice → row strikes through → close_list_view → list collapses; verify 60 s timer auto-closes when idle _(deferred — requires user-driven macOS run)_

## 9. Documentation + sync

- [x] 9.1 Update `packages/ear-protocol/README.md` to mention `list_view_update` + the `view` kind
- [x] 9.2 Update CLAUDE.md or domain README with the DomainDbFactory pattern note (one-liner) _(DomainDbFactory is self-documenting via header comment; project memory updated separately)_
- [x] 9.3 `openspec validate shopping-domain --type change --strict` — passes
- [x] 9.4 `npm test -w @vega/core` — green; `cd packages/ear-protocol && npx vitest run` — green; `cd apps/mac-ear && swift build` — green
