## Why

We have one production domain (notes) that drove the kernel/orchestration plumbing. To validate that the kernel actually decouples domains — and to give the assistant a second, structurally different surface — we add a "shopping list" domain. It's a flat, mutable list with display semantics: we add/remove/toggle items by voice and we want to *see* the list as a visual overlay on the Ear, not as audio or a saved file. This exercises three things the platform doesn't have yet:

1. **Per-domain isolated storage** — a real second SQLite that lives next to the shared one, with a reusable factory so future domains (todo, recipes, ...) don't copy-paste DataSource bootstrap.
2. **A generic list-view overlay channel** — a wire surface beyond the orb, so any domain can paint a structured collection on the Ear and the Ear stays domain-agnostic.
3. **A new orb `kind: view`** — semantics for "I'm showing you something" distinct from listen / capture / think.

## What Changes

- New domain module `shopping` under `apps/core/src/domains/shopping/` with its own `ShoppingItem` entity, `ShoppingStorageService`, agent spec, prompts, and a tool bundle (`add_item`, `list_items`, `mark_bought`, `delete_item`, `clear_list`, `show_list`, `close_list_view`).
- New isolated SQLite at `output/db/shopping.sqlite` provisioned through a reusable `DomainDbFactory` (in `apps/core/src/integrations/database/`) that any future domain can call by name to obtain an own DataSource.
- **BREAKING (internal protocol)**: extend `@vega/ear-protocol` with a new Core→Ear message `list_view_update` (`{type, seq, view: { title?, items: [{id, label, done}], open }}`) and add `view` to the overlay `kind` enum. Bumps protocol; mac-ear ships the matching decoder.
- New `ListViewService` on the backend — single per-device writer, monotonic `seq`, 60 s auto-close timer per device that resets on every refresh; `close_list_view` and the timer both emit a final `{open: false}` and an `overlay_update {kind: idle}`.
- mac-ear extends the existing overlay window with a list section below the orb: rendered when the view-model has `items` and `viewOpen: true`, no scroll, panel auto-resizes; `done` items strike-through; empty list shows "(пусто)". `kind: view` uses an `list.bullet` SF Symbol in the orb so the user knows the overlay is currently presenting a list.
- `show_list` and the per-mutation refresh always emit a fresh `list_view_update` carrying the full current items snapshot — no patch protocol, no client-side merging.

## Capabilities

### New Capabilities
- `shopping-domain`: the shopping-list domain — entity, storage, tool catalog, prompts, and the `ListViewService` lifecycle.

### Modified Capabilities
- `ear-protocol`: adds the `list_view_update` Core→Ear message and the `view` value for overlay `state.kind`.
- `overlay-channel`: adds the `view` kind to the overlay state model; documents that `view` does NOT auto-pulse a spinner and is the canonical paint when a list is shown.
- `mac-ear`: extends the overlay window with a list section below the orb (collapses when no view is open), renders the `view` orb glyph (`list.bullet`), and handles the new `list_view_update` decoder branch.

## Impact

- `packages/ear-protocol`: schema addition of `ListViewUpdateMessage` + `ListItem` schema; extension of `OverlayKindEnum` with `view`; round-trip fixtures + tests for every new wire shape; Swift mirror types and decoder branch.
- `apps/core`: new `DomainDbFactory` (provisions a per-domain SQLite at `output/db/<name>.sqlite`, entities loaded by glob from `<domainDir>/**/*.entity.{ts,js}`); new `ShoppingModule`, `ShoppingItem` entity, `ShoppingStorageService` (case-insensitive name upsert, soft delete via `deletedAt`, clear-all in one statement); new `ListViewService` (per-device queue, seq, 60 s timer reset on mutate, idle emit on close); new shopping tool bundle and `ShoppingAgentService` registered in the AgentRegistry; supervisor prompt updated so haiku knows when to route to shopping.
- `apps/mac-ear`: `OverlayViewModel` gains `items: [ListItem]?`, `viewTitle: String?`, `viewOpen: Bool`; `OverlayView` adds a list section below the orb that collapses cleanly; `Orb` adds the `view` kind branch with `list.bullet` glyph; `SessionCoordinator` / `EarSocket` decode and dispatch `list_view_update`.
- Storage: `output/db/shopping.sqlite` is created on first boot of the domain; the new file is git-ignored alongside `output/db/`.
- No backwards-compatibility shim — protocol is internal; mac-ear and core ship together.
