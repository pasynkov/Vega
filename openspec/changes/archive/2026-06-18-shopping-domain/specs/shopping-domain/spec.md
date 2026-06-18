## ADDED Requirements

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

### Requirement: ShoppingAgent system prompt + supervisor routing

The shopping agent SHALL be a single supervisor-side AgentSpec (no continuous session, no session-bound runner). Its system prompt SHALL instruct the model to:

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
