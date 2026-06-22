## ADDED Requirements

### Requirement: Mac Ear consumes the shared Swift packages

The Mac Ear executable target SHALL depend on the local SPM packages `packages/ear-core/swift/` (product `EarCore`) and `packages/ear-ui/swift/` (product `EarUI`), in addition to `packages/ear-protocol/swift/` (product `EarProtocol`). Cross-platform code that previously lived inside `apps/mac-ear/Sources/VegaEar/` SHALL be sourced from `EarCore` or `EarUI` rather than duplicated in the executable target.

The executable target SHALL retain the following Mac-only files: `main.swift`, `AppDelegate`, `StatusItemController`, `OverlayWindowController`, `MicDeviceCatalog`, and the `OpenWakeWordDetector` glue. All other Swift files SHALL be removed from the executable target after Phase 1, because their canonical home is `EarCore` or `EarUI`.

#### Scenario: SessionCoordinator is imported from EarCore

- **WHEN** the Mac executable references `SessionCoordinator`
- **THEN** the import SHALL resolve to the `EarCore` module
- **AND** there SHALL be no `SessionCoordinator.swift` file under `apps/mac-ear/Sources/VegaEar/`

#### Scenario: Overlay rendering uses EarUI

- **WHEN** the `OverlayWindowController` instantiates the overlay content view
- **THEN** it SHALL construct a SwiftUI view exported from `EarUI` (not a view defined in the executable target)

### Requirement: Mac Ear declares both `wake` and `mic`/`speaker` capabilities on register; never `vad`

The Mac Ear SHALL continue to register with `capabilities: ["mic","wake","speaker","display"]` (the existing set, possibly without `display` if not previously included). It SHALL NOT include `vad` in its registration in v1: the Mac's session-entry trigger is wake-word, and Core's wake-precondition rule continues to apply to the Mac.

#### Scenario: Mac register payload omits vad

- **WHEN** the Mac Ear sends `register`
- **THEN** `capabilities` SHALL include `"wake"`
- **AND** `capabilities` SHALL NOT include `"vad"`

## MODIFIED Requirements

### Requirement: Interactive overlay window

The Mac Ear SHALL render an interactive overlay window driven by `overlay_update` messages from Core. The overlay SHALL be implemented as an `NSPanel` with:

- `styleMask` containing `.borderless` and `.nonactivatingPanel`
- `level` set to `.floating`
- `backgroundColor = .clear`, `isOpaque = false`, `hasShadow = false`
- `ignoresMouseEvents = true` at all times (the overlay is purely informational; cancelling a session is done by going silent, not by clicking)
- `collectionBehavior` allowing it to appear on every Space and stay above fullscreen apps

The overlay's content view SHALL be an `EarUI.OverlayView` instance bound to a `EarCore.OverlayViewModel`. The content view SHALL NOT be defined locally in the Mac executable target. The overlay SHALL render the v1 "seamless morph" mark — a single SwiftUI `Canvas` morphing across `idle`, `listening`, `capturing`, `thinking`, `processing`, `success`, `error`, `view`, `immersive` — together with the optional `hint` (above), `caption` (below), and the embedded list-view surface. Theming SHALL come from the shared dark palette in `EarUI.Theme`; the executable SHALL NOT specify colors directly.

The overlay window SHALL anchor under the menu-bar status item. When the status-item frame is available, the overlay SHALL appear with a **drop-from-tray animation**: starting at a position whose top edge sits at the status item's bottom edge (so the panel is initially hidden behind the menu bar), then translating downward over ~220 ms to its resting position (top-right corner ≈ 6 pt below the status icon), concurrent with opacity 0→1. The horizontal anchor SHALL track the status item's centerline (clamped to `NSScreen.visibleFrame`). When the status-item frame is not available (e.g., overflow menu hides it), the overlay SHALL fall back to a simple fade-in at the resting position.

On hide the overlay SHALL reverse: translate upward into the menu-bar region concurrent with opacity 1→0 over ~180 ms, then `orderOut(_:)`.

The overlay SHALL be visible whenever the current `state.kind` is not `idle` OR a list-view surface is currently open for the device. On `idle` with no list view open it SHALL hide. The Ear SHALL NOT hide the overlay in response to `session_end` (Core- or Ear-initiated); the overlay is intentionally decoupled from session lifecycle so the user keeps seeing a `thinking` / `capturing` state while the orchestrator dispatches between sessions. The overlay SHALL hide only when (a) the orb `state.kind` is `idle` AND no list view is open, (b) WebSocket disconnect from Core, (c) user-initiated pause or app shutdown.

Content transitions (kind / hint / caption changes) SHALL apply to the morph mark via the `TimelineDriver` exported from `EarUI`; no per-update crossfade SHALL be layered on top of the morph.

#### Scenario: Overlay drops from the tray on first non-idle update

- **WHEN** the Ear receives `{ type: "overlay_update", seq: 1, state: { kind: "listening" } }` and the overlay is currently hidden and the status-item frame is available
- **THEN** the overlay window SHALL appear with its top edge at the status item's bottom edge and opacity 0
- **AND** SHALL animate downward to its resting position concurrent with opacity 0→1 over ~220 ms
- **AND** the rendered content SHALL be the EarUI listening morph state

#### Scenario: Overlay falls back to fade-in when the status-item frame is unavailable

- **WHEN** the Ear receives a non-idle `overlay_update` while the status item is in the menu-bar overflow (no frame available)
- **THEN** the overlay SHALL fade in at its resting position over ~200 ms (no translation)

#### Scenario: Overlay shows hint and caption together

- **WHEN** the Ear receives `{ type: "overlay_update", seq: 7, state: { kind: "processing", hint: "Сохраняю заметку…", caption: "купи молоко" } }`
- **THEN** the overlay SHALL render the EarUI processing morph state, the hint above, and the caption below

#### Scenario: Overlay survives session_end (bridge state during dispatch)

- **WHEN** the Ear has a visible overlay (e.g. `thinking`) and receives `{ type: "session_end", sessionId: <S>, reason: "endpoint" }` for the active session
- **THEN** the overlay SHALL stay visible with its current state
- **AND** the next `overlay_update` Core emits SHALL drive the transition

#### Scenario: Overlay collapses on idle update

- **WHEN** the Ear receives `{ type: "overlay_update", seq: N, state: { kind: "idle" } }`
- **THEN** the overlay SHALL reverse-animate (translate upward + fade out) over ~180 ms and hide
- **AND** the next visible overlay SHALL require a new non-idle update from Core
