## ADDED Requirements

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
