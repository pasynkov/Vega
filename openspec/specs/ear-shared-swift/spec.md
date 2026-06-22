# ear-shared-swift Specification

## Purpose
TBD - created by archiving change ios-ear-and-design-system-v1. Update Purpose after archive.
## Requirements
### Requirement: Two shared Swift packages — `ear-core` and `ear-ui`

The repository SHALL host two new Swift packages under `packages/`:

- `packages/ear-core/swift/` exporting a library product `EarCore`. Contents: cross-platform session/audio/transport logic with no SwiftUI, AppKit, or UIKit imports. The `swift-tools-version` SHALL be at least `5.9`. Platforms SHALL include `.macOS(.v13)` and `.iOS(.v26)`. The package SHALL depend on `EarProtocol` (from `packages/ear-protocol/swift/`). The package SHALL contain test target `EarCoreTests` covering the session coordinator, socket transport, audio engine, opus encoder, silence detector, preferences, device-identity service, and cue player.
- `packages/ear-ui/swift/` exporting a library product `EarUI`. Contents: SwiftUI views, the morph-mark Canvas, the timeline driver, the list view, the dark theme tokens, and embedded font Resources. The `swift-tools-version` SHALL be at least `5.9`. Platforms SHALL include `.macOS(.v13)` and `.iOS(.v26)`. The package SHALL depend on `EarCore` (for state enums) and `EarProtocol` (for wire shapes). It SHALL contain no AppKit or UIKit imports. It SHALL contain test target `EarUITests` covering the timeline driver and the theme token table.

`EarCore` SHALL NOT import `EarUI`. `EarUI` SHALL import `EarCore`. The dependency graph is acyclic: `EarProtocol ← EarCore ← EarUI`.

#### Scenario: EarCore is consumable headlessly

- **WHEN** a developer runs `swift test` from `packages/ear-core/swift/`
- **THEN** the test target SHALL build and run with no SwiftUI / AppKit / UIKit linkage
- **AND** the tests SHALL run on both macOS and Linux toolchains (no platform-specific frameworks pulled in)

#### Scenario: EarUI is consumable on iOS

- **WHEN** a developer builds a target depending on `EarUI` against an iOS 26 SDK
- **THEN** the build SHALL succeed
- **AND** all views, the morph mark, and the list view SHALL compile without macOS-only conditionals

### Requirement: File ownership boundary

The following files SHALL live in `packages/ear-core/swift/Sources/EarCore/`: `SessionCoordinator.swift`, `EarSocket.swift`, `AudioEngine.swift`, `OpusEncoder.swift`, `SilenceDetector.swift`, `Preferences.swift`, `DeviceIdentityService.swift`, `CuePlayer.swift`, and their supporting types. The following files SHALL live in `packages/ear-ui/swift/Sources/EarUI/`: `OverlayView.swift`, `OverlayViewModel.swift`, `MorphMark.swift` (new), `TimelineDriver.swift` (new), `ListView.swift` (new), `Theme.swift` (new), and the embedded fonts under `Resources/Fonts/`.

The following files SHALL remain Mac-shell-only in `apps/mac-ear/Sources/VegaEar/`: `main.swift`, `AppDelegate.swift`, `StatusItemController.swift`, `OverlayWindowController.swift`, `MicDeviceCatalog.swift`, `OpenWakeWordDetector.swift`, `WakeWordDetector.swift`. No file from this list SHALL be moved into the shared packages.

#### Scenario: Cross-platform files are absent from the executable target

- **WHEN** an audit lists Swift files in `apps/mac-ear/Sources/VegaEar/`
- **THEN** the list SHALL NOT contain `SessionCoordinator.swift`, `EarSocket.swift`, `AudioEngine.swift`, `OpusEncoder.swift`, `SilenceDetector.swift`, `Preferences.swift`, `DeviceIdentityService.swift`, `CuePlayer.swift`, `OverlayView.swift`, or `OverlayViewModel.swift`
- **AND** the executable target SHALL still build

### Requirement: Embedded fonts ship inside `EarUI`

`EarUI` SHALL embed `Golos Text` (weights 400, 500, 600, 700) and `JetBrains Mono` (weights 400, 500) as Resources under `Sources/EarUI/Resources/Fonts/`. The package SHALL include the upstream `OFL.txt` (Golos Text) and `LICENSE` (JetBrains Mono) alongside the font files. `EarUI` SHALL expose a `Theme.registerFonts()` function that registers the fonts with the host process's font system at first call; the function SHALL be idempotent.

The host app SHALL call `Theme.registerFonts()` once at launch (or `EarUI` SHALL call it lazily on first `View` body evaluation; the chosen approach SHALL be consistent across both clients).

#### Scenario: Font registration is idempotent

- **WHEN** `Theme.registerFonts()` is called twice in the same process lifetime
- **THEN** the second call SHALL be a no-op (no duplicate registration, no error thrown)

#### Scenario: Resolved font name matches the design

- **WHEN** SwiftUI requests `.custom("Golos Text", size: 17)` after `Theme.registerFonts()` has been called
- **THEN** the resolved font SHALL be the embedded Golos Text (not a fallback)

### Requirement: Test targets pass on every commit boundary

The two new test targets `EarCoreTests` and `EarUITests` SHALL be green on every merge commit reachable from `main`. The CI / local `swift test` invocation SHALL include both packages. A failing `EarCoreTests` SHALL block any commit that touches `packages/ear-core/swift/`, `apps/mac-ear/`, or `apps/ios-ear/`.

#### Scenario: A change that breaks SessionCoordinator is caught

- **WHEN** a developer modifies `SessionCoordinator.swift` and breaks the `idle → armed` transition test
- **THEN** `swift test` SHALL fail under `packages/ear-core/swift/`
- **AND** the failing test SHALL identify the broken transition by name

### Requirement: EarCoreTests includes a session-journey test layer

`packages/ear-core/Tests/EarCoreTests/` SHALL contain a session-journey test layer that drives `SessionCoordinator` through complete, ordered, realistic session lifecycles AND feeds the resulting `OverlayUpdateMessage` / `ListViewUpdateMessage` events into a real `OverlayViewModel`, asserting the union of (a) the events the coordinator emits to the socket / cue player / status controller AND (b) the resulting view-model state at every checkpoint.

Journey tests SHALL cover at minimum:

- A basic wake-to-success-to-idle journey ending in `core_session_end(endpoint)`, asserting the full `OverlayViewModel.kind` sequence and the sticky `liveCaption` set from `final_transcript`.
- A continuous-arm journey (ack-as-badge): wake → `arm_capture(continuous)` → coordinator plays `ackContinue` and opens a follow-up session without a fresh wake → `core_session_end`.
- An ask-mode arm journey: idle → `arm_capture(ask)` → cue + session open → `final_transcript` answer → end.
- An immersive-mode bridge journey: regular session → `arm_capture(immersive)` mid-flow → coordinator emits a clean `EarSessionEnd` for the previous session and opens an immersive one → end.
- A sticky-caption journey: `final_transcript "X"` → subsequent `overlay_update(thinking)` carrying no caption → `OverlayViewModel.liveCaption` SHALL remain `"X"` (the payload `caption` channel is independent and may be `nil`; the sticky channel is `liveCaption`).
- A list-view-open journey: `list_view_update(open: true)` mid-session → `OverlayViewModel.visible` SHALL remain `true` after an `overlay_update(idle)` while the list view is still open.
- A list-view-close journey: list-view open → `list_view_update(open: false)` → overlay SHALL collapse to the non-list view-model state.
- A mid-thinking disconnect journey: socket disconnect after `overlay_update(thinking)` and before any `core_session_end` → overlay hidden, view-model reset to idle, status SHALL surface `.error("Core unreachable")` (the existing coordinator contract on socket loss).
- An `sttError`-ended journey: `core_session_end(reason: sttError, detail: …)` → `StatusController.setState(.error(detail))` AND `OverlayViewModel.kind == .error`.
- A stale-`seq` journey: within an otherwise-valid journey, an out-of-order `overlay_update` with a stale `seq` SHALL be dropped without affecting the running view-model state.

The journey-test layer SHALL NOT modify production code. Any production-code bug surfaced by a journey test SHALL be recorded via `XCTSkip` or `XCTExpectFailure` with an inline reason naming a follow-up change, and SHALL be fixed in a separate change.

The journey-test layer SHALL reuse the existing `MockWakeDetector`, `MockAudioCapturing`, `MockEarSocket`, `MockCuePlayer`, `MockStatusController` from `SessionCoordinatorMocks.swift`. A new test-only `OverlayControlling` implementation that forwards updates to a real `OverlayViewModel` MAY be introduced; it SHALL live next to the existing mocks under `Tests/EarCoreTests/`.

#### Scenario: Wake-to-success journey drives the full overlay sequence

- **WHEN** a journey test triggers wake on the coordinator, emits `overlay_update(listening)`, a `final_transcript`, `overlay_update(thinking)`, `overlay_update(success)`, then `core_session_end(reason: endpoint)`, then a trailing `overlay_update(idle)`
- **THEN** the journey rig's real `OverlayViewModel` SHALL have observed the kind sequence `[listening, thinking, success, idle]`
- **AND** `OverlayViewModel.liveCaption` SHALL equal the text emitted in the `final_transcript`
- **AND** `MockStatusController.states` SHALL include `.idle` after the session ends

#### Scenario: Sticky live caption survives a state-only overlay update

- **WHEN** a journey emits `final_transcript "купи молоко"` followed by `overlay_update(kind: thinking)` with no caption field
- **THEN** the journey rig's real `OverlayViewModel.liveCaption` SHALL still equal `"купи молоко"` after the thinking update
- **AND** `OverlayViewModel.caption` SHALL be `nil` (the payload caption channel is independent of the sticky channel)

#### Scenario: List-view open keeps overlay visible past idle

- **WHEN** a journey opens a list view via `list_view_update(open: true, items: […])` and later applies `overlay_update(kind: idle)`
- **THEN** the journey rig's real `OverlayViewModel.visible` SHALL be `true`

#### Scenario: Mid-thinking socket disconnect hides overlay

- **WHEN** a journey reaches `overlay_update(kind: thinking)` and the socket then reports disconnected before any `core_session_end`
- **THEN** the journey rig's real `OverlayViewModel.visible` SHALL be `false`
- **AND** `OverlayViewModel.kind` SHALL be `.idle` (vm reset by `hide()`)
- **AND** `MockStatusController.states` SHALL include a `.error(_)` entry carrying the "Core unreachable" marker

#### Scenario: SttError session-end renders error overlay

- **WHEN** a journey receives `core_session_end(reason: sttError, detail: "deepgram dropped")`
- **THEN** `MockStatusController.states` SHALL include `.error("deepgram dropped")`
- **AND** the journey rig's real `OverlayViewModel.kind` SHALL be `.error`

#### Scenario: Reverse-TDD on surfaced bugs

- **WHEN** a journey test reveals a real bug in `SessionCoordinator` or `OverlayViewModel`
- **THEN** the failing test SHALL be marked `XCTSkip` or `XCTExpectFailure` with an inline reference to a follow-up change name
- **AND** the production code in this change SHALL remain unmodified

