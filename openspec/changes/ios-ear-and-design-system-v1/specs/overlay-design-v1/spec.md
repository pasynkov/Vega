## ADDED Requirements

### Requirement: Dark-only palette

`EarUI.Theme` SHALL expose the v1 dark palette as named tokens:

- `Theme.violet` = `#8B5CF6`
- `Theme.violetLight` = `#A78BFA`
- `Theme.violetLighter` = `#C4B5FD`
- `Theme.violetHighlight` = `#EFEAFF`
- `Theme.background` = a vertical gradient from `#0A0612` (top) to `#1B0F30` (bottom) with the violet glow tinted into the upper-right corner (radial gradient overlay, `#3B1B6B` at the focal point, fading to transparent over ~60% of the diagonal)
- `Theme.surface` = `rgba(255,255,255,0.04)` (used for cards and the list panel)
- `Theme.surfaceStroke` = `rgba(255,255,255,0.08)`
- `Theme.textPrimary` = `rgba(255,255,255,0.93)`
- `Theme.textSecondary` = `rgba(255,255,255,0.62)`
- `Theme.textTertiary` = `rgba(255,255,255,0.34)`

The theme SHALL be dark only. No `@Environment(\.colorScheme)` branching SHALL exist in `EarUI` views in v1. If a future light theme is added, the token names SHALL stay stable and only their resolved colors SHALL widen.

#### Scenario: Token table is testable

- **WHEN** `EarUITests` reads each named token
- **THEN** the resolved SRGB components SHALL match the v1 design (within 1/255 per channel)

### Requirement: Embedded fonts and typographic roles

`EarUI.Theme` SHALL expose typographic roles backed by the embedded fonts:

- `Theme.font.title(size: CGFloat)` → Golos Text 600 at the given size
- `Theme.font.body(size: CGFloat)` → Golos Text 400 at the given size
- `Theme.font.bodyMedium(size: CGFloat)` → Golos Text 500 at the given size
- `Theme.font.mono(size: CGFloat)` → JetBrains Mono 500, uppercase + .18em letter-spacing applied at the call site (used for timeline labels)

Views SHALL reach for these roles by name; raw `.custom("Golos Text", …)` calls outside `Theme` SHALL NOT appear in the codebase.

#### Scenario: Title role resolves to Golos Text 600

- **WHEN** a SwiftUI view uses `Theme.font.title(size: 22)`
- **THEN** the rendered text SHALL use Golos Text weight 600 at 22 pt

### Requirement: Seamless morph visual language

`EarUI.MorphMark` SHALL be a single SwiftUI `Canvas` that renders the current overlay state by drawing the morph mark — a dot, optionally surrounded by a ring, a halo, two counter-rotating arcs, wave bars, a ripple, or a check tick — into the same 240×240 pt region. The visual language SHALL be "seamless morph": the mark transforms between states without spawning or destroying subviews.

`EarUI.TimelineDriver` SHALL own the state-to-keyframe mapping. Given an `OverlayKind` and a `Date()` provided by an enclosing `TimelineView(.animation)`, it SHALL return a `MorphState` value type with fields driving each draw primitive (ring radius, halo opacity, arc rotation phase, wave bar heights, ripple radius, check progress). `MorphState` field values SHALL be a pure function of `(OverlayKind, elapsedSinceEntry)`; the same inputs SHALL produce the same outputs (no internal randomness).

Per-state visual definition:

- `idle` — a single dot at center, no ring, no halo. Idle ≠ hidden; the mark is drawn at low opacity (0.42) when the overlay is visible but the state is idle.
- `listening` — dot at center with a halo pulse (vHalo): halo radius oscillates 18→30 pt over 2.6 s ease-in-out, opacity 0.6→0.0 at outer edge.
- `capturing` — dot at center with an enlarging ring (radius growing 80→120 pt) and 5 vertical wave bars on the right side of the mark, each bar height driven by a slightly different phase.
- `thinking` — dot at center with two arcs (each ~120° of a circle) counter-rotating: one clockwise (`vSpin` 0.85 s), one counter-clockwise (`vSpinRev` 1.1 s).
- `processing` — dot at center with concentric ripple gates expanding 60→160 pt, opacity fading from 0.4 to 0.0.
- `success` — dot at center transforms into a tick: the dot's `y` extends down and right with a quick ease-out (~280 ms) tracing a check shape; the mark stays as a tick until the next state transition.
- `error` — dot at center pulses red-violet (`#8B5CF6` shifted toward `#FF6B8A`) at 0.7 s, no ring.
- `view` — dot at center scales down to 4 pt and a list panel slides in below; the dot acts as the panel's "drop indicator." Panel sizing rules are covered by the List view requirement.
- `immersive` — dot at center plus a slowly rotating violet aura (3.0 s rotation), wider halo than `listening`.

#### Scenario: Driver output is deterministic per state

- **WHEN** `TimelineDriver.morphState(kind: .listening, elapsed: 0.0)` is called twice
- **THEN** both calls SHALL return identical `MorphState` values

#### Scenario: State transition preserves the dot

- **WHEN** the mark transitions from `listening` to `capturing` at time `t`
- **THEN** the dot SHALL be drawn at the same screen position before and after the transition
- **AND** the ring SHALL appear via a continuous radius animation from 0 → its capturing target over ≤ 220 ms

### Requirement: Overlay layout

`EarUI.OverlayView` SHALL compose the morph mark with optional text and the list view:

- `MorphMark` occupies the central region.
- An optional `hint` line above the mark uses `Theme.font.title(size: 18)` in `Theme.textPrimary`, single line, truncated tail.
- An optional `caption` line below the mark uses `Theme.font.body(size: 15)` in `Theme.textSecondary`, single line, truncated tail.
- An optional `ListView` is rendered below the caption when `list_view_update {open: true}` is current; layout details are covered below.

The overlay's outer container exposes two layout modes:

- `compact` (Mac): the content fits inside a rounded-rect card (radius 22 pt, `Theme.surface` background, 1-pt `Theme.surfaceStroke`, blur material under it for AppKit). Max width ~360 pt.
- `fullScreen` (iOS): the content is centered on `Theme.background`, no card, sized to fill the available screen.

Both layout modes SHALL render the same `MorphMark`, the same text typography, and the same list view rendering.

#### Scenario: Compact mode renders a card

- **WHEN** `OverlayView` is presented in `compact` layout
- **THEN** a rounded card SHALL surround the morph + text + list content with corner radius 22 pt

#### Scenario: Full-screen mode fills the screen

- **WHEN** `OverlayView` is presented in `fullScreen` layout in an iOS host
- **THEN** the morph mark SHALL be centered in the screen
- **AND** the background SHALL be `Theme.background` covering the full screen including the safe-area insets

### Requirement: List view

`EarUI.ListView` SHALL render a `list_view_update`-driven panel:

- Title line at the top using `Theme.font.title(size: 22)`. Right-aligned to the title is a "done / total" counter (e.g. "2 / 6 куплено") in `Theme.font.body(size: 13)` and `Theme.textTertiary`.
- A vertical stack of rows. Each row contains: a 20×20 pt circular bullet (filled `Theme.violetLight` with a check glyph when `done`, hollow with 1.5-pt `Theme.textTertiary` stroke when not done), 14-pt gap, then the label.
- Labels in `Theme.font.body(size: 17)` in `Theme.textPrimary` for not-done, struck-through with line in `Theme.textTertiary` for done.
- An empty `items` array renders a single placeholder line in `Theme.textTertiary` reading the localized "(пусто)".

The list MAY scroll on iOS when it does not fit the screen (rare, the Mac side does not scroll today). The Mac compact card SHALL grow vertically to fit the content (matching today's `mac-ear` behavior).

#### Scenario: Done row renders struck-through

- **WHEN** a `ListView` row with `done: true, label: "хлеб"` is rendered
- **THEN** the label "хлеб" SHALL be struck through
- **AND** the bullet SHALL be filled `Theme.violetLight` with a check glyph

### Requirement: Platform entry metaphors

Two platform metaphors SHALL be supported:

- **macOS — "drop from tray":** the Mac shell's `OverlayWindowController` SHALL animate `NSPanel` in from the menu-bar status item's frame. The panel's top edge SHALL start at the status-item's bottom edge; it SHALL translate downward ~120 pt over ~220 ms while opacity rises 0 → 1. On hide it SHALL reverse over ~180 ms.
- **iOS — "expand":** the iOS host SHALL present `OverlayView` in `fullScreen` mode whenever the current `overlay_update.state.kind` is not `idle` (or a list view is open). The expand metaphor is realized by the morph mark's natural growth from the center; no Dynamic Island / Live Activity integration is in v1.

These metaphors SHALL belong to the host shells (`apps/mac-ear/`, `apps/ios-ear/`), not to `EarUI`. `EarUI` SHALL NOT contain AppKit / UIKit window-animation code.

#### Scenario: EarUI is window-animation-free

- **WHEN** an audit scans `packages/ear-ui/swift/Sources/EarUI/` for AppKit / UIKit imports
- **THEN** the result SHALL be empty
- **AND** the drop-from-tray animation SHALL be implemented in `apps/mac-ear/Sources/VegaEar/OverlayWindowController.swift`
