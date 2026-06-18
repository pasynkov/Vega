## ADDED Requirements

### Requirement: List-view surface below the overlay orb

The Mac Ear SHALL extend the existing overlay window with a list-view section rendered directly below the orb (and below the optional `caption` line). The list section SHALL be driven by `list_view_update` messages from Core:

- A `list_view_update {view: {open: true, ...}}` SHALL show the section and replace its rendered items with the payload's `items` array verbatim.
- A `list_view_update {view: {open: false, ...}}` SHALL collapse the section (no items rendered, panel resizes back).
- The section SHALL render its `view.title` as a small header above the items (if present), then one row per item.
- Each row SHALL render `item.label`. Rows whose `done` is `true` SHALL be rendered with a struck-through label and a checkmark or filled-bullet glyph; rows whose `done` is `false` SHALL render with an empty-bullet glyph.
- An empty `items` array SHALL render a single placeholder line with the localized "пусто" string.
- The list section SHALL NOT scroll; the NSPanel SHALL grow vertically to fit the rendered items so the entire list is visible (constrained by `NSScreen.visibleFrame`, with sane upper bounds to avoid covering the whole screen).
- The section SHALL appear and disappear with the same fade animation envelope as the rest of the overlay (~200 ms show/hide), but its internal content (items list) SHALL update instantly without a per-row crossfade.

The list view SHALL be tracked by a per-channel `seq` in the view-model that ignores any `list_view_update` whose `seq` is not strictly greater than the last applied one. Disconnect SHALL reset the per-channel `seq` and collapse the section.

#### Scenario: open snapshot shows the list

- **WHEN** the Ear receives `{type: "list_view_update", seq: 1, view: {title: "Список покупок", items: [{id: "a", label: "молоко 1 л", done: false}, {id: "b", label: "яйца", done: true}], open: true}}`
- **THEN** the overlay panel SHALL grow to fit the list section
- **AND** the title "Список покупок" SHALL be rendered above the items
- **AND** "молоко 1 л" SHALL be rendered with an empty-bullet glyph
- **AND** "яйца" SHALL be rendered struck-through with a filled-bullet glyph

#### Scenario: empty items array renders placeholder

- **WHEN** the Ear receives `{type: "list_view_update", seq: 2, view: {title: "Список покупок", items: [], open: true}}`
- **THEN** the list section SHALL render a single line "пусто"

#### Scenario: close collapses the list section

- **WHEN** the Ear has a visible list section and receives `{type: "list_view_update", seq: 5, view: {items: [], open: false}}`
- **THEN** the list section SHALL collapse
- **AND** the orb SHALL remain visible until an `overlay_update {kind: idle}` arrives

#### Scenario: stale seq is dropped

- **WHEN** the Ear has applied a `list_view_update` with `seq: 7` and then receives one with `seq: 5`
- **THEN** the older message SHALL be discarded
- **AND** the rendered list SHALL remain at the `seq: 7` snapshot

## MODIFIED Requirements

### Requirement: Interactive overlay window

The Mac Ear SHALL render an interactive overlay window driven by `overlay_update` messages from Core. The overlay SHALL be implemented as an `NSPanel` with:

- `styleMask` containing `.borderless` and `.nonactivatingPanel`
- `level` set to `.floating`
- `backgroundColor = .clear`, `isOpaque = false`, `hasShadow = false`
- `ignoresMouseEvents = true` at all times (the overlay is purely informational; cancelling a session is done by going silent, not by clicking)
- `collectionBehavior` allowing it to appear on every Space and stay above fullscreen apps

The overlay SHALL anchor under the menu-bar status item: its top-right corner sits ≈6 pt below the status icon's bottom-right corner (clamped to the screen), so it reads as a dropdown from the tray icon. When the status-item frame is not available yet, the overlay SHALL fall back to the top-right corner of the screen containing the menu-bar item. Its content SHALL be a SwiftUI view composed of:

- An orb visual (SwiftUI `Canvas` or shape with state-driven gradient + pulse animation) sized ~96 pt, plus an SF Symbol glyph centered inside the orb that uniquely identifies the current `kind` (`mic.fill` for listening, `waveform` for capturing, `sparkle` for thinking, `gearshape.fill` for processing, `checkmark` for success, `exclamationmark` for error, `list.bullet` for view).
- An optional top text section showing `state.hint` (collapses if absent).
- An optional bottom text section showing `state.caption` (collapses if absent).
- An optional list-view section rendered below the caption (driven by the separate `list_view_update` channel — see "List-view surface below the overlay orb").
- A rounded-rect background using `.ultraThinMaterial` with `cornerRadius: 22`.
- Fade-in/scale-up appearance and fade-out/scale-down disappearance, animated over ~200 ms. Content transitions (kind/hint/caption) SHALL apply instantly, without crossfade, so the visual matches the cue sound that arrived with the same update.

The overlay SHALL be visible whenever the current `state.kind` is not `idle` OR a list-view surface is currently open for the device. On `idle` with no list view open it SHALL hide. The Ear SHALL NOT hide the overlay in response to `session_end` (Core- or Ear-initiated); the overlay is intentionally decoupled from session lifecycle so the user keeps seeing a `thinking` / `capturing` state while the orchestrator dispatches between sessions. The overlay SHALL hide only when (a) the orb `state.kind` is `idle` AND no list view is open, (b) WebSocket disconnect from Core, (c) user-initiated pause or app shutdown.

#### Scenario: Overlay appears on first non-idle update

- **WHEN** the Ear receives `{ type: "overlay_update", seq: 1, state: { kind: "listening" } }` and the overlay is currently hidden
- **THEN** the overlay window SHALL fade in within ~200 ms with the listening orb visual
- **AND** no top or bottom text section SHALL be rendered

#### Scenario: Overlay shows hint and caption together

- **WHEN** the Ear receives `{ type: "overlay_update", seq: 7, state: { kind: "processing", hint: "Сохраняю заметку…", caption: "купи молоко" } }`
- **THEN** the overlay SHALL render the processing orb, the hint above, and the caption below

#### Scenario: Overlay survives session_end (bridge state during dispatch)

- **WHEN** the Ear has a visible overlay (e.g. `thinking`) and receives `{ type: "session_end", sessionId: <S>, reason: "endpoint" }` for the active session
- **THEN** the overlay SHALL stay visible with its current state
- **AND** the next `overlay_update` Core emits (e.g. `arm_capture` follow-up `capturing`, domain `success`, or implicit `idle`) SHALL drive the transition

#### Scenario: Overlay collapses on idle update only when no list view is open

- **WHEN** the Ear receives `{ type: "overlay_update", seq: N, state: { kind: "idle" } }` and no list-view surface is currently open
- **THEN** the overlay SHALL fade out and hide

#### Scenario: Overlay stays visible on idle while list view is open

- **WHEN** the Ear has an open list-view surface and receives `{ type: "overlay_update", seq: N, state: { kind: "idle" } }`
- **THEN** the overlay SHALL remain visible (the list section keeps the panel on-screen)
- **AND** the next `list_view_update {open: false}` plus `overlay_update {kind: idle}` SHALL be what fully collapses the panel

### Requirement: Audible feedback cues

The Ear SHALL play a system sound on wake-word detection ("wake cue") locally — without waiting on any Core message. The Ear SHALL play a different system sound when entering `continuous` capture via `arm_capture` (`ack_continue` / Submarine) locally, also without waiting on a separate cue message. Every other audible cue SHALL be driven by the `state.sound` field of `overlay_update` messages: when present, the Ear SHALL play the named cue exactly once at the moment the update is rendered.

The MVP cue assets: `wake` → `Purr.aiff`; `endpoint` → `/System/Library/Sounds/Pop.aiff`; `error` → `/System/Library/Sounds/Basso.aiff`; the `ack_*` family uses the existing macOS system sounds. The choice is a one-line constant per cue and may evolve without re-spec.

`list_view_update` messages SHALL NOT carry any sound; the list-view surface is purely visual. Any audio acknowledgement for a shopping action SHALL ride on a separate `overlay_update` from the domain handler (e.g. `kind: success, sound: ack_done` after `add_item`).

The Ear SHALL NOT handle a `play_cue` message; that message type has been removed from the protocol.

#### Scenario: Successful capture cycle

- **WHEN** the user says "Vega, write down to buy milk"
- **THEN** the wake cue SHALL play once at wake-word detection (local)
- **AND** an `overlay_update` carrying `state.sound: "ack_done"` (or `"endpoint"` on a non-domain-handled flow) SHALL play exactly once when received
- **AND** no other cue SHALL play during the cycle

#### Scenario: Session ends with error

- **WHEN** Core closes the session with a `session_end` reason other than `vad` or `endpoint`, or the WebSocket disconnects mid-session
- **THEN** the error cue SHALL play if Core supplied it via an `overlay_update` before the disconnect (`state.sound: "error"`), or the Ear's local disconnect handler SHALL play `error` locally
- **AND** the status item SHALL transition back to `idle` (or `error` if the disconnect persists)
- **AND** the overlay SHALL hide

#### Scenario: list_view_update carries no sound

- **WHEN** the Ear receives a `list_view_update` with any payload
- **THEN** the Ear SHALL render the list surface change silently
- **AND** any acknowledgement sound SHALL ride only on a separate `overlay_update.state.sound`
