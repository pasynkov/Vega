## Context

Vega has one production domain (notes) that drove every kernel piece: supervisor routing, sub-agent factory, kernel-provided tool builders, the session-bound agent runner, the overlay channel. The platform now needs a second domain to validate the kernel actually decouples domains and to give the assistant a visual list surface beyond a single text caption.

Constraints already baked in:
- Wake-word triggered short turns are the normal entry; continuous mode is only for dictation.
- Overlay is decoupled from session lifecycle and only collapses on `{kind: idle}` or WS disconnect.
- The orchestration kernel exposes shared tool builders under `apps/core/src/conversation/kernel/tools/`; domains inject them into their `AgentSpec.tools`.
- The protocol is internal: TypeScript + Swift mirror; both sides ship together. No backwards-compat shim.

User decisions taken into design before this doc:
- Per-domain isolated SQLite (`output/db/shopping.sqlite`), exposed through a reusable factory.
- LLM is responsible for fuzzy/lemma matching by name; storage exposes a `list_items()` tool so the LLM can resolve ids before mutating.
- Soft delete via `deletedAt`; `clear_list` is a single soft-delete of everything live.
- `show_list` does NOT open a continuous session (deferred). Instead the auto-close timer (60 s) takes care of letting the view linger after a single command.
- Wire shape for the list is generic (`list_view_update` with `items: [{id, label, done}]`) so future domains (todo, recipes, …) can reuse it.
- A new orb kind `view` represents "I'm showing you content"; no spinner, distinct glyph.

## Goals / Non-Goals

**Goals:**
- A second domain shipped end-to-end (storage → tools → prompts → wire → mac-ear UI).
- A reusable `DomainDbFactory` so adding a third domain doesn't repeat the DataSource dance.
- A generic list-view wire surface that mac-ear renders the same way for any domain.
- A new orb kind that makes the "I'm showing you a list" state visually unambiguous.
- LLM-driven name matching so storage stays dumb and the LLM can ask clarifying questions later if needed.

**Non-Goals:**
- Continuous-session "stay open and keep listening" mode for shopping (deferred — auto-close timer is enough for now).
- Multi-tenant or multi-user lists. There is one user and one device.
- Drag-and-drop, swipe-to-delete, or any mouse interaction on the list view (overlay still `ignoresMouseEvents = true`).
- Search, filter, or pagination of the list — the panel auto-resizes to fit.
- Sync, undo history, or audit log beyond `createdAt`/`updatedAt`/`deletedAt`.
- A categories model. Items are flat strings — categorisation can come later.

## Decisions

### Decision 1: DomainDbFactory (per-domain isolated DataSource)

Add `apps/core/src/integrations/database/domain-db.factory.ts` exposing `createDomainDataSource({name, entities}): DataSource`. The factory:
- resolves the file path to `<repo-root>/output/db/<name>.sqlite` (and `mkdir -p` the parent),
- builds a TypeORM `DataSource` with `type: "better-sqlite3"`, `synchronize: true`, WAL mode pragma, busy-timeout 5 s,
- returns the data source un-initialised; the calling module owns the lifecycle (`OnModuleInit` to initialize, `OnApplicationShutdown` to destroy).

`ShoppingModule` calls the factory in `OnModuleInit`, registers its repository through `DataSource.getRepository(ShoppingItem)`, and tears it down on shutdown.

Why:
- Mirrors the shared `DbService` pattern (TypeORM + better-sqlite3 + WAL + busy-timeout) so the bootstrap is familiar.
- Keeps shared `vega.sqlite` glob untouched — adding a shopping entity to the global glob would erase the isolation user asked for.
- Factory pattern means todo/recipes/etc. become a one-line call.

Alternatives considered:
- Reusing `DbService` and just renaming the entities table — rejected: user explicitly asked for an isolated db.
- Letting the shopping module own the entire DataSource construction inline — rejected: this is exactly the bootstrap we want to centralize before a third domain copies it.

### Decision 2: Wire — separate `list_view_update` channel, not embedded in overlay_update

The list view is a structurally different payload (an array, dynamic height) and has its own lifecycle (open / refresh / close on a 60 s timer). Embedding it inside `overlay_update.state` would force every overlay update to carry the list payload, or split overlay payloads into "patches" — both of which fight the "every update is a complete snapshot" invariant we already have.

Decision: a separate top-level Core→Ear message `list_view_update {type, seq, view: { title?, items, open }}`. The orb status moves through `overlay_update` as before; "we are showing a list" is communicated by `overlay_update {kind: view}` (orb glyph). When the list view closes, Core emits both `list_view_update {open: false}` AND `overlay_update {kind: idle}` so the panel collapses cleanly.

Why:
- Preserves the simple "complete state record" invariant on overlay_update.
- Keeps the orb channel and the content channel orthogonal and individually monotonic — easier to reason about, easier to debug from logs.
- Future domains that want a list (todo, recipes) reuse the same channel.

Alternatives considered:
- Extend `overlay_update.state` with `list?: {items, ...}` — rejected: ties orb updates to list updates and breaks the no-patches rule on the list (a mark_bought-driven refresh would need to also carry the current orb kind).
- Use a different SwiftUI window — rejected by user: "не отдельная панель, тяни тот же overlay вниз".

### Decision 3: `kind: view` in overlay state model (vs reusing existing kinds)

The orb already has 7 kinds; `view` is the 8th. Why a new value:
- `idle` means "hide me", which contradicts "we are presenting content".
- `processing` / `thinking` imply work in progress — wrong feeling for a static list display.
- `listening` / `capturing` imply microphone activity — wrong feeling when the user is reading.

`view` is the canonical "I'm presenting content now" state. The orb renders with no spinner, `list.bullet` glyph on mac-ear, and a calm gradient.

### Decision 4: ListViewService is the single per-device writer

Mirror the `OverlayService` shape: per-device map, monotonic `seq` per channel per connection, 60 s auto-close timer, single emit point. All shopping tools (`add_item`, `mark_bought`, `delete_item`, `clear_list`, `show_list`, `close_list_view`) call `ListViewService` — none reach into the WebSocket directly.

`ListViewService` exposes one mutation primitive: `refresh(deviceId, snapshot)` which re-emits with a new snapshot and resets the timer; and `close(deviceId)` which emits `{open: false}` and cancels the timer. On `open`, `show_list` calls `refresh` (it's an idempotent open). The closing path on timer expiry calls `close` followed by `OverlayService.set({kind: idle})`.

### Decision 5: LLM does name matching; storage stays dumb

`list_items()` returns `[{id, name, status, quantity, unit, note}]`. The LLM uses this output to pick the row to mutate by id. Storage exposes nothing fuzzier than case-insensitive equality (used only inside `add_item` upsert).

Why:
- "Купи молока", "купил молоко", "удали молочко" all map to the same item — Russian declensions, diminutives, and partial matches. A storage-side string matcher would need a lemmatiser; the LLM already handles this trivially.
- Concurrent decisions ("the user probably meant the pending one, not the bought one") need natural-language judgement, not SQL.
- Cost: one extra LLM tool call per mutate. Acceptable; haiku is cheap and fast for this prompt shape.

The supervisor → shopping route uses haiku (already the default for supervisor + notes-supervisor); the shopping agent itself uses haiku unless we discover routing/judgement quality gaps.

### Decision 6: `add_item` upserts by (LOWER(name), status=pending, deletedAt=NULL)

The user said "просто обновляем с новым количеством. не мержим, не дублируем". The cleanest reading: a single pending row per (name, ignoring case). Subsequent `add_item` calls on the same name replace `quantity`, `unit`, `note` with the new values (any of which may be null to clear a previous value).

A separate bought row may coexist (closed prior purchase). `add_item` does NOT touch bought rows — it always opens a new pending row when no pending row exists.

### Decision 7: Auto-close timer (60 s) + close_list_view tool

The user explicitly chose A+B (LLM close tool + timer) and asked for 60 s. Implementation:
- Every mutation while view open → `ListViewService.refresh(snapshot)` → resets timer.
- `close_list_view` → immediate close, cancels timer.
- Timer expires → `close()`.

The timer is per-device (mirrors overlay ttl). If the user opens the view a second time while it's already open, that second `show_list` simply refreshes; the timer also resets.

### Decision 8: mac-ear renders list view inside the same NSPanel, no scroll, panel grows

The user explicitly said "scroll не надо, растягиваем" and "давай тот же overlay вниз". Implementation:
- `OverlayViewModel` gains `items: [ListItem]?`, `viewTitle: String?`, `viewOpen: Bool`, and a `lastListSeq: Int`.
- `OverlayView` adds an `if vm.viewOpen` block below the caption that renders the title + items via a `VStack`.
- The NSPanel is set up with `contentSize` driven by SwiftUI intrinsic sizing; on view open/close the panel re-anchors so the top stays under the status item even as it grows downward (overlay anchor logic already handles arbitrary sizes since the panel resizes its origin to put top-right under the status icon).
- Empty `items` → render single "(пусто)" line.

Hard upper bound on the panel height: clamp to `min(<computed>, NSScreen.visibleFrame.height - 80)`. Above that, the panel just doesn't grow further — visually the bottom items get cut off, which we accept for the first iteration (the user said no scroll).

## Risks / Trade-offs

- **Two SQLite files double the failure surface.** Mitigation: `DomainDbFactory` reuses the same pragmas and busy-timeout as `DbService`. Both files live under `output/`, both are git-ignored. If either fails to initialize on boot, the affected module fails to start and the other one keeps running.
- **No mouse interaction means the user can't tap to mark items bought.** Acceptable for v1 — voice is the only input by design. If we change `ignoresMouseEvents` later we have to think through the wake/click overlap on the menu-bar icon.
- **Panel can grow taller than the screen if the user piles 50+ items in.** Mitigation in this iteration: cap the panel height at `screen.visibleFrame.height - 80`; later iteration may add a "and 12 more…" tail.
- **List on mac-ear has no per-row animation.** Acceptable — overlay was already tuned for instant content swaps without per-row crossfade.
- **LLM-driven name matching costs ~1 extra haiku call per mutate.** Acceptable; latencies in our trace are dominated by sub-agent tool-loop overhead, not by routing.
- **Generic `list_view_update` is presently used by only one domain.** Mitigation: the message shape is simple enough that overgeneralising costs almost nothing now and saves a future protocol bump.

## Migration Plan

1. Add `ListViewUpdateMessageSchema` and extend `OverlayKindEnum` with `view` in `@vega/ear-protocol` (TypeScript + Swift mirror + fixtures + tests).
2. Add `DomainDbFactory` + `ShoppingItem` entity + `ShoppingStorageService` + `ListViewService`.
3. Add shopping tools, agent spec, prompts; register `ShoppingModule` in the AgentRegistry.
4. Update the supervisor prompt and registry so `goto: shopping` is routable.
5. Update mac-ear: view-model fields, `OverlayView` list section, `Orb` `view` glyph, `EarSocket` decoder branch, `SessionCoordinator` dispatch.
6. End-to-end test on macOS: "надо купить молока" → add → success ttl; "покажи список" → view appears; "купил молоко" → list refreshes with strike; "очисти список" → list empties; "закрой" → list collapses; timer-driven close after 60 s.
7. Spec sync + archive.
