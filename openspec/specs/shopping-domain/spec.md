# shopping-domain Specification

## Purpose

The Vega shopping-list domain. A flat, voice-controlled list of items the user wants to buy. Items can be added (with optional quantity, unit, note), marked bought, deleted, or cleared. The current list can be presented as an overlay surface on the Ear via the generic `list_view_update` channel. The capability also formalises the reusable per-domain DataSource pattern (`DomainDbFactory`) — shopping is the first consumer; future domains (todo, recipes, …) reuse the same plumbing.

## Requirements

### Requirement: Shopping items are persisted in an isolated SQLite database

The shopping domain SHALL persist items in a dedicated SQLite database at `output/db/shopping.sqlite`, distinct from the shared `vega.sqlite`. The database SHALL be provisioned through a reusable `DomainDbFactory` exposed by `apps/core/src/integrations/database/`. Other domains MAY use the same factory to obtain their own isolated DataSource by passing their domain name. The shopping module SHALL NOT register its entity with the shared `DbService` glob.

#### Scenario: Shopping DataSource is independent from the shared one

- **WHEN** the application boots with both `DbModule` and `ShoppingModule`
- **THEN** two SQLite files SHALL exist on disk: `output/recordings/vega.sqlite` and `output/db/shopping.sqlite`
- **AND** `ShoppingItem` SHALL be present only in `shopping.sqlite`
- **AND** the shared `Memory` and conversation-session entities SHALL be present only in `vega.sqlite`

### Requirement: ShoppingItem schema

A `ShoppingItem` SHALL have these columns:

- `id` (UUID v4, primary key)
- `name` (string, non-empty, ≤ 200 chars)
- `note` (nullable text)
- `quantity` (nullable real)
- `unit` (nullable string, ≤ 32 chars)
- `status` (enum: `pending`, `bought`)
- `deletedAt` (nullable datetime — soft-delete marker)
- `createdAt`, `updatedAt` (datetimes managed by the ORM)

A "live" item is any row with `deletedAt IS NULL`. Queries that surface items to the user (`list_items`, `show_list`, refresh after mutation) SHALL filter on `deletedAt IS NULL`.

#### Scenario: Soft delete hides items from view but keeps the row

- **WHEN** a user issues `delete_item(id)` for an existing pending item
- **THEN** the row SHALL remain in the database with `deletedAt` set to the current timestamp
- **AND** subsequent `list_items()` calls SHALL NOT return that row

### Requirement: add_item upserts by name and pending status

The `add_item(name, quantity?, unit?, note?)` tool SHALL look up an existing live item by case-insensitive name match with `status = pending`. If a match exists, the tool SHALL overwrite that row's `quantity`, `unit`, and `note` from the call args (any of which MAY be null to clear the field) and bump `updatedAt`. If no match exists, the tool SHALL insert a new pending row with the supplied fields. The tool SHALL NOT merge quantities and SHALL NOT create a duplicate pending row for the same name.

If a same-name row already exists with `status = bought` (regardless of `deletedAt`), the tool SHALL still insert a fresh pending row — the bought row represents a closed prior purchase and SHALL NOT be re-opened by `add_item`.

#### Scenario: Adding the same item twice updates the existing pending row

- **WHEN** `add_item("молоко", 1, "л")` is called and then `add_item("молоко", 2, "л")` is called
- **THEN** the database SHALL contain exactly one pending row for "молоко" with `quantity = 2`, `unit = "л"`
- **AND** the row's `createdAt` SHALL be from the first call
- **AND** the row's `updatedAt` SHALL be from the second call

#### Scenario: Adding after a prior purchase opens a new pending row

- **WHEN** a bought, non-deleted row exists for "яйца" and `add_item("яйца", 10, "шт")` is called
- **THEN** a new pending row SHALL be inserted alongside the bought row
- **AND** `list_items()` SHALL return both rows

### Requirement: mark_bought and delete_item operate by id

The `mark_bought(id)` and `delete_item(id)` tools SHALL operate on the row whose primary key matches `id` (the LLM resolves item identity through `list_items()` before invoking either tool). Each tool SHALL be a no-op (returning `{ ok: true, changed: false }`) when the id does not exist or the row is already in the target state.

#### Scenario: mark_bought is idempotent

- **WHEN** `mark_bought(id)` is called twice on the same item
- **THEN** the second call SHALL return `{ ok: true, changed: false }`
- **AND** `updatedAt` SHALL NOT advance on the second call

### Requirement: clear_list soft-deletes every live row

The `clear_list()` tool SHALL set `deletedAt = NOW` on every row currently having `deletedAt IS NULL`, regardless of status. After the call, `list_items()` SHALL return an empty list.

#### Scenario: clear_list wipes pending and bought together

- **WHEN** the list contains 3 pending and 2 bought rows and `clear_list()` is called
- **THEN** all 5 rows SHALL have `deletedAt` set
- **AND** `list_items()` SHALL return `[]`

### Requirement: show_list opens a list view on the Ear

The `show_list()` tool SHALL read the current live items, emit a `list_view_update` to the active device containing `{ open: true, view: { title, items: [{id, label, done}] } }`, and emit `overlay_update {kind: view}`. The `label` SHALL be a human-readable composition `<name> [<quantity> <unit>]` rendered by the storage layer (e.g. `"молоко 2 л"`, `"хлеб"`). The `done` flag SHALL be `true` for `status = bought` and `false` for `pending`. The `title` SHALL be the constant string `"Список покупок"`.

When `show_list` is invoked while a list view is already open for the device, the tool SHALL refresh the existing view (re-emit `list_view_update` with the new snapshot, reset the auto-close timer) without closing-and-reopening.

When the live list is empty, the tool SHALL still emit `{ open: true, items: [] }` and let the Ear render the empty placeholder.

#### Scenario: show_list opens the view with the current snapshot

- **WHEN** `show_list()` is called and the live list contains two items
- **THEN** Core SHALL emit one `list_view_update` with `view.open = true`, `view.title = "Список покупок"`, and `view.items.length = 2`
- **AND** Core SHALL emit one `overlay_update {state.kind: "view"}` on the same device

#### Scenario: show_list on an empty list still opens the view

- **WHEN** `show_list()` is called and no live items exist
- **THEN** Core SHALL emit `list_view_update {view: {open: true, items: []}}` so the Ear shows the empty placeholder

### Requirement: ListViewService manages list-view lifecycle per device

Core SHALL host a `ListViewService` that is the only component allowed to emit `list_view_update` wire messages. It SHALL track per-device whether a view is currently open, the last items snapshot, and a 60 s auto-close timer. On any mutation tool while the view is open (`add_item`, `mark_bought`, `delete_item`, `clear_list`), the service SHALL re-emit `list_view_update` with the fresh snapshot and SHALL reset the auto-close timer.

The auto-close timer SHALL expire 60 s after the last update for that device. On expiry, `ListViewService` SHALL emit `list_view_update {open: false}` and SHALL call `OverlayService.set(deviceId, { kind: "idle" })` so the orb collapses too.

The `close_list_view()` tool SHALL trigger the same close path immediately: emit `{open: false}` + `{kind: idle}` and cancel the timer.

`ListViewService.close` SHALL accept an optional `silentOverlay` flag. When set, the close path SHALL skip the `OverlayService.set({kind: idle})` call so the caller can paint a different orb state without a visible flicker through idle (used by the wake-word path: list collapses, orb transitions directly to `listening`).

`list_view_update` SHALL carry a strictly monotonic per-device `seq` starting at `1` on each new WebSocket connection. On disconnect, the service SHALL discard the device's view state.

#### Scenario: mutation refreshes an open view and resets the timer

- **WHEN** a list view is open for a device and `add_item("молоко", 1, "л")` succeeds
- **THEN** `ListViewService` SHALL emit a fresh `list_view_update` carrying the updated snapshot
- **AND** the auto-close timer for that device SHALL be reset to 60 s

#### Scenario: auto-close timer fires after 60 s of no activity

- **WHEN** a list view is open and no mutation or refresh has happened for 60 s
- **THEN** `ListViewService` SHALL emit `list_view_update {open: false}`
- **AND** `OverlayService` SHALL emit `overlay_update {kind: idle}` for the same device

#### Scenario: close_list_view closes immediately

- **WHEN** the LLM invokes `close_list_view()` while a view is open
- **THEN** `ListViewService` SHALL emit `list_view_update {open: false}`
- **AND** `OverlayService` SHALL emit `{kind: idle}`
- **AND** the auto-close timer SHALL be cancelled

#### Scenario: wake-word collapses the list view without flicker

- **WHEN** a list view is open and the user triggers the wake word
- **THEN** Core SHALL close the list view with `silentOverlay: true` (no `{kind: idle}` paint)
- **AND** Core SHALL immediately paint `overlay_update {kind: listening}`
- **AND** the Ear SHALL transition directly from the view orb to the listening orb without passing through idle

### Requirement: ShoppingAgent system prompt + supervisor routing

The shopping agent SHALL expose a supervisor-side AgentSpec used for short-turn routing by the kernel supervisor. (The immersive session-spec described below lives alongside it and is engaged only when the user enters immersive mode.) Its system prompt SHALL instruct the model to:

- Pick exactly one of the available tools per turn.
- Use `list_items()` first when the user references an item by name (so the LLM resolves the id before `mark_bought` / `delete_item`).
- Map verbs `купи`, `купить`, `надо` to `add_item`; `купил`, `взял`, `отметь` to `mark_bought`; `удали`, `убери` to `delete_item`; `очисти`, `сотри список` to `clear_list`; `покажи`, `что в списке` to `show_list`; `закрой`, `убери список` to `close_list_view`.
- Parse `quantity` and `unit` freely from natural language ("2 кило" → `quantity: 2, unit: "кг"`; "пачка" → `quantity: 1, unit: "пачка"`); leave both null if the user did not say a quantity.
- Always finish a turn with an empty assistant text (TTS off) — the cue and overlay are the user-facing acknowledgement.

The kernel supervisor's prompt and registry SHALL be updated so haiku-routed turns can dispatch to the `shopping` domain when the utterance is recognisably about a shopping list.

#### Scenario: Supervisor routes a shopping utterance

- **WHEN** the user says "надо купить молока"
- **THEN** the supervisor SHALL emit a `route` call with `goto: "shopping"`
- **AND** the shopping agent SHALL invoke `add_item("молоко", null, null, null)` exactly once
- **AND** Core SHALL emit a success overlay (`kind: success`, `hint: "Добавил"` or equivalent, `ttl: 1500`)

### Requirement: Shopping session-spec for immersive mode

The shopping domain SHALL expose a second `AgentSpec` built by `buildShoppingSessionSpec(sessionTools)`, parallel to the existing supervisor-spec. The session-spec SHALL contain the same domain tools (`add_item`, `list_items`, `mark_bought`, `delete_item`, `clear_list`, `show_list`, `close_list_view`) plus the session-bound tool `close_immersive_session`. The system prompt SHALL be ≈95% identical to the supervisor-spec prompt (intent maps for add/mark/delete/show), extended with one rule:

> Если пользователь сказал «закрой покупки» / «хватит» / «выходим» / «закончил» — вызови `close_immersive_session`.

The session-spec SHALL be the spec passed to `EarSessionRouter.arm` when an immersive shopping session is opened. The supervisor-spec SHALL remain unchanged.

#### Scenario: Session-spec is wired into immersive arm

- **WHEN** the supervisor opens an immersive session for the shopping domain
- **THEN** `router.arm.ownerSpec` SHALL be the shopping session-spec, not the supervisor-spec

#### Scenario: Session-spec handles close-utterance

- **WHEN** an immersive shopping session receives a final `"закрой покупки"`
- **THEN** the session-spec agent SHALL call `close_immersive_session`
- **AND** the runner SHALL release the session with reason `"user"`

### Requirement: close_immersive_session tool

`close_immersive_session` SHALL be a session-bound tool registered in `buildShoppingSessionSpec`. The tool SHALL return `{release: true, reason: "user"}` (a valid `SessionToolResult`) so the `SessionAgentRunner` per-final-turn strategy releases the session via the standard release-by-tool path. The tool SHALL take a single optional `intent` field for logging.

#### Scenario: close_immersive_session returns release marker

- **WHEN** `close_immersive_session({intent: "user-close"})` is invoked
- **THEN** the tool SHALL return a `SessionToolResult` with `release: true, reason: "user"`

### Requirement: Shopping sessionBegin paints immersive entry

The shopping domain SHALL provide a `sessionBegin(deviceId)` hook registered with `ImmersiveDomainRegistry`. When called, the hook SHALL:

1. Load the live shopping items from `ShoppingStorageService`.
2. Build a `ListView` snapshot.
3. Emit a `list_view_update` with the snapshot via `ListViewService.refresh(deviceId, snapshot, "shopping:immersive_begin")`.
4. Emit `overlay_update` with `{kind: "immersive"}` via `OverlayService.set(deviceId, ...)`.

#### Scenario: sessionBegin paints entry on arm

- **WHEN** an immersive shopping session is bound and `sessionBegin(deviceId)` is invoked
- **THEN** Core SHALL emit a `list_view_update` carrying the current live items
- **AND** Core SHALL emit an `overlay_update` with `state.kind: "immersive"`

### Requirement: Shopping module registers in ImmersiveDomainRegistry

`ShoppingModule` SHALL implement `OnApplicationBootstrap` (or `OnModuleInit`) and call `registry.register({name: "shopping", sessionSpec, sessionBegin})` once during startup. The registration SHALL happen before the supervisor first builds its prompt so the prompt block lists `shopping`.

#### Scenario: Shopping appears in registry list

- **WHEN** the application boots
- **THEN** `registry.list()` SHALL include `"shopping"` by the time the kernel supervisor runs its first turn
- **AND** the supervisor's prompt SHALL mention `shopping` as an available immersive domain
