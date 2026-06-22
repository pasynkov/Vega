## Context

The current Ear codebase lives in a single Swift Package executable target `apps/mac-ear/Sources/VegaEar/` — 2,546 lines mixing AppKit shell, AVFoundation audio pipeline, ONNX wake-word, socket.io transport, and SwiftUI overlay. There is one consumer (macOS), so the lack of separation has not yet bitten us, but every line is reachable to every other line.

Three forces converge in this change:

1. **A new client surface.** iPhone needs its own app. Foreground-only mic, no wake-word, full-screen overlay.
2. **A new visual language.** The v1 design (`design/Vega v1/`) introduces a "seamless morph" — a single mark that transforms through `idle → listening → capturing → thinking → processing → success → view → idle`. Both clients render the same morph.
3. **A behavior contract that must not regress.** The existing Mac Ear is the user's only working entry point today. Any refactor that breaks wake-word capture, session boundaries, cue playback, or device-id persistence breaks production.

Constraint: phases must land in a sequence where the Mac Ear continues to work end-to-end at every commit boundary, and where automated tests detect any drift before merge.

Stakeholders: a single user (the project owner). Distribution is dev-sideload; no App Store review pressure. Server endpoint is on a private LAN / Tailscale.

## Goals / Non-Goals

**Goals:**

- An iOS app that, while open in the foreground, captures voice on activity and surfaces the same overlay states as the Mac.
- A shared Swift core (`ear-core`) and a shared SwiftUI design system (`ear-ui`) that both clients consume.
- A protocol extension allowing a device to declare "VAD-triggered, no wake-word" and have Core accept its sessions as first-class.
- A v1 visual language realized on both Mac and iOS, with the Mac panel sliding down from the menu-bar status item ("drop from tray").
- A characterization test suite locked around current Mac Ear behavior before the first file moves.
- A phase order in which every gate is a green Mac Ear build + green tests, so any phase that breaks the gate is reverted without losing other phases' work.

**Non-Goals:**

- Background microphone capture on iOS (no `UIBackgroundModes: audio`).
- Lock-screen / Dynamic Island integration (no ActivityKit, no Live Activities).
- App Store or TestFlight submission in this change.
- CarPlay.
- Light theme (dark only).
- iOS wake-word — explicitly dropped; VAD replaces it.
- Snapshot tests for the morph mark — animation under `TimelineView` is timestamped and not stable for pixel-diff. Manual visual review at the gate.
- Performance work on the Mac Ear audio pipeline. Sample rate, Opus bitrate, ring buffer sizing stay as today.
- Renaming or re-organizing the existing Core (NestJS) module layout beyond what the `vad` capability requires.

## Decisions

### Decision: Two packages, not one (`ear-core` + `ear-ui`)

We extract the cross-platform Swift code into **two** SPM packages rather than one.

Rationale: the audio + transport layer has zero SwiftUI dependency and can be unit-tested headlessly. Putting it in the same package as SwiftUI views forces every test target to compile UIKit/AppKit ifdef'd code and drag in animation timing. A clean import wall keeps the audio test suite fast and platform-agnostic.

Alternative considered: one `ear-shared` package with separate library products. Rejected — products in the same package still share the same compilation context, and the convenience is not worth the diffuse boundary.

Layout:

```
packages/
  ear-protocol/swift/   ← already exists (socket.io events + Codable DTOs)
  ear-core/swift/       ← NEW. depends on ear-protocol.
                          targets: EarCore (lib), EarCoreTests
                          contents: SessionCoordinator, EarSocket,
                                    AudioEngine, OpusEncoder, SilenceDetector,
                                    Preferences, DeviceIdentityService,
                                    CuePlayer
                          platforms: .macOS(.v13), .iOS(.v26)
                          no UI imports, no AppKit, no UIKit
  ear-ui/swift/         ← NEW. depends on ear-core (for state enums).
                          targets: EarUI (lib), EarUITests
                          contents: MorphMark (Canvas), TimelineDriver,
                                    OverlayView, ListView, Theme,
                                    fonts in Resources
                          platforms: .macOS(.v13), .iOS(.v26)
                          SwiftUI only — no AppKit, no UIKit
apps/
  mac-ear/    ← thin AppKit shell, depends on EarCore + EarUI
  ios-ear/    ← Xcode project, depends on EarCore + EarUI
```

### Decision: Mac Ear remains an SPM executable; iOS Ear is an Xcode project

`apps/mac-ear/` stays as it is — SPM executable target, `swift run`-able. `apps/ios-ear/` is created as an Xcode project (`.xcodeproj`), because:

- `Settings.bundle` is an Xcode-specific resource convention.
- iOS code-signing and provisioning profiles are Xcode-managed.
- `Info.plist` keys (`NSMicrophoneUsageDescription`, `UIBackgroundModes` absence, deployment target) live in the target's settings.
- The dev workflow is "open in Xcode, hit Run on connected device" — no headless build path matters for v1.

The Xcode project depends on the SPM packages via local references. Both packages stay swift-tools-version 5.9 to be consumed identically by SPM and Xcode.

### Decision: VAD-triggered session as a protocol-level capability, not a per-event flag

A device declares its capabilities once at `register`. Adding `vad` to `Capability` is symmetric with the existing `mic`/`wake`/`speaker`/`display` and tells Core the device's session-entry contract for the duration of the connection.

```
register.capabilities = ["mic", "speaker", "vad"]   ← iOS
register.capabilities = ["mic", "wake", "speaker"]  ← Mac
```

Core's session-entry validator inspects the device's registration: if `vad` is present, a `session_start` is accepted without a preceding `wake_detected`. If `wake` is present and `vad` is not, the current rule (`session_start` requires a prior `wake_detected`) stands.

Alternatives considered:

- **Mode flag on `session_start`** (e.g., `trigger: "vad" | "wake"`). Rejected — the device's capability is stable across the connection; encoding it per-message wastes bytes and invites mismatch.
- **A separate event `vad_session_start`**. Rejected — multiplies the event catalog for what is fundamentally the same shape.

### Decision: "Seamless morph" rendered as a single SwiftUI Canvas

The morph mark is one SwiftUI `Canvas` view driven by `TimelineView(.animation)`. The same `Canvas` draws every state — `listening` is a halo + dot, `capturing` is the dot expanding into wave bars, `thinking` is two counter-rotating arcs, etc. We do **not** swap out subviews per state, because the design's defining property is that the mark transforms.

A `TimelineDriver` owns the state-to-keyframe mapping: given the current `OverlayKind` and `Date()` from `TimelineView`, it returns a `MorphState` struct (ring radius, halo opacity, arc rotation, etc.) that the `Canvas` draws.

Why Canvas, not Shape + Animation: `Canvas` lets us draw the dot, the ring, the wave bars, and the check tick in one pass with no view-tree churn. `Shape`s would require a tree restructure at every transition.

Alternative considered: `Lottie` JSON exported from the design tool. Rejected — Lottie pulls a runtime dep, the design is small enough to express in Swift, and we want the audio-state-to-visual driver in our code rather than baked into a frame timeline.

### Decision: "Drop from tray" implemented in `OverlayWindowController`

The animation belongs to the Mac shell, not to the shared UI package — iOS has no tray and no concept of "drop." Implementation: when `overlay_update` triggers a visible state, the controller reads `NSStatusItem.button?.window?.frame`, places the `NSPanel` with its top edge at the status item's bottom edge, makes it transparent, then animates `setFrame(...)` downward to the resting position concurrent with opacity 0→1 using `NSAnimationContext` over ~220ms. Reverse on hide.

If the status item is hidden (overflow on a small menu bar), fall back to the current behavior — fade in at the resting position.

### Decision: VAD trigger uses the existing `SilenceDetector`

The Mac already runs a `SilenceDetector` to terminate sessions (138 lines). We invert its second output — same energy threshold, same hysteresis — to detect **onset** (silence → voice). The iOS coordinator subscribes to onset events and emits `session_start`; the Mac coordinator continues to use wake-word onset and SilenceDetector for offset only.

This keeps a single VAD implementation tuned for one device class. The detector's parameters live in `Preferences` so they can diverge per-device later.

### Decision: iOS endpoint configuration via `Settings.bundle`

The iOS app does not show an in-app settings screen for the endpoint URL. The user opens Settings.app → Vega Ear and edits a single text field. The app reads the value from `UserDefaults.standard.string(forKey: "server_endpoint")` on launch and on `UIApplication.didBecomeActiveNotification`.

Rationale: one knob, one user, no UI work. iOS Settings.bundle costs ~15 lines of plist.

Alternative considered: in-app onboarding screen. Rejected — overkill for a single field. Can be added later without breaking compatibility (read from `UserDefaults` either way).

### Decision: Phase 0 lands characterization tests **before** any file moves

Before the first import is changed, an XCTest target lands in `apps/mac-ear/Tests/VegaEarTests/` covering the contracts that must not regress: SessionCoordinator state transitions, EarSocket event lifecycle (with a mocked socket), AudioEngine pipeline (PCM in → Opus out), SilenceDetector onset/offset, Preferences round-trip, OverlayViewModel state binding.

These tests are then carried across the refactor — Phase 1 moves them with the code into `ear-core/Tests`. The same tests must be green at every commit boundary.

Alternative considered: ship the iOS app first behind a feature flag. Rejected — there is no feature flag mechanism in a Swift app, and the code is not currently testable enough to refactor in parallel with new development.

### Decision: Mac keeps wake-word; iOS does not link `onnxruntime`

`OpenWakeWordDetector.swift` (334 lines) stays in `mac-ear` shell — it is platform-policy specific to the Mac's always-listening model. The ONNX runtime SPM dependency stays declared on the mac-ear target only. The iOS target does not link it.

Rationale: even though OpenWakeWord works on iOS, foreground-only operation means the wake-word would not be useful (the app is visible, the user can tap). Avoiding the ONNX dependency keeps the iOS binary small and avoids any battery / CPU surprises.

### Decision: Dark theme only, no theme switching

`Theme` in `ear-ui` exposes a fixed dark palette derived from `design/Vega v1`. No `@Environment(\.colorScheme)` branching. If a future light theme is needed, it can be added by widening `Theme` without touching call sites.

## Risks / Trade-offs

- [Phase 0 tests may discover existing bugs that look like contract violations] → Document each anomaly in `tasks.md` and decide per-case whether to lock it in (test passes today's behavior) or fix it (test the intended behavior). Default: lock it in. We are not chasing pre-existing bugs in this change.
- [The Mac panel "drop from tray" animation may feel janky on multi-monitor setups where the status item is on a non-primary screen] → Fall back to fade-in if the status-item screen does not match the panel's target screen. Test on a single-monitor setup before merge; multi-monitor is a known follow-up.
- [VAD on iOS can be triggered by HVAC noise, traffic, music] → SilenceDetector already uses energy thresholding with hysteresis. On iOS, expose the threshold and minimum-voice-duration in Settings.bundle as a hidden second knob; default to a conservative threshold and tune from real-world use. No live calibration UI in v1.
- [Settings.bundle changes require the user to leave the app to reconfigure] → Acceptable for one user with a stable endpoint. Document the path in the spec.
- [Embedded fonts inflate binary size] → Golos Text (~250KB) + JetBrains Mono (~250KB) is negligible compared to ONNX (~5MB on Mac) and the socket.io-client transitive footprint. Not a concern.
- [`Canvas` redraws at the TimelineView cadence may cost CPU on iOS during long `listening` states] → `TimelineView(.animation)` schedules at frame rate only while on screen. Foreground-only means the cost is bounded to the time the user has the screen on. Monitor in real-world use.
- [Phase 4's Mac UI swap could regress visible behavior even with green tests, because the morph mark is new] → Phase 4 gate includes a manual visual review of every `OverlayKind` and the `view` (shopping list) state.
- [Two characterization-test migrations (Phase 0 lands tests in `mac-ear`; Phase 1 moves them into `ear-core`)] → The migration is a file-move, not a rewrite. If the test was green in Phase 0 against the original code and green in Phase 1 against the extracted code, the extraction was lossless. If Phase 1 changes any test logic, that is the bug.

## Migration Plan

Each phase is a single PR-shaped commit boundary. The gate at the end of every phase is identical: `swift test` in every Swift package green, manual launch of the Mac Ear works against a local Core (wake → speak → response → cue), no protocol-level errors in Core logs.

1. **Phase 0** — land `apps/mac-ear/Tests/VegaEarTests/` covering the contracts above. No production code changes. Gate: tests green against today's code.
2. **Phase 1** — create `packages/ear-core/swift/`. Move the cross-platform files one commit at a time, updating `mac-ear`'s imports in the same commit. Carry the tests into `ear-core/Tests/`. Gate: tests green from new location, `mac-ear` runs.
3. **Phase 2** — extend `packages/ear-protocol/` with `vad` in the `Capability` enum (both TS and Swift). Update Core's session-entry validation to accept `session_start` without `wake_detected` for `vad` devices. Add fixture coverage. Gate: protocol round-trip tests green, supervisor unit tests green.
4. **Phase 3** — create `packages/ear-ui/swift/`. Build `Theme`, `MorphMark`, `TimelineDriver`, `OverlayView`, `ListView`. Embed fonts. Add `EarUITests` for `TimelineDriver` (state → keyframe is deterministic) and `Theme` (color values match the design palette). Manual visual review of every `OverlayKind` in an SPM playground or test app. Gate: tests green, visual review approved.
5. **Phase 4** — wire `mac-ear`'s `AppDelegate` to instantiate `EarUI.OverlayView` instead of the legacy view. Implement the drop-from-tray animation in `OverlayWindowController`. Delete the legacy SwiftUI views from `mac-ear`. Gate: characterization tests green, manual run-through of all states, drop animation reviewed.
6. **Phase 5** — create `apps/ios-ear/` Xcode project. Add Info.plist, mic permission string, Settings.bundle. Wire `EarCore` and `EarUI`. Implement VAD-mode `SessionCoordinator` initialization (no wake-word). Deploy to a physical iPhone with iOS 26+. Manually verify every state, shopping list view, endpoint reconfiguration. Gate: all manual scenarios pass on device.

**Rollback strategy:** each phase is a single commit (or a tight cluster of commits) reachable from `main`. If a phase ships and a regression appears, the phase reverts cleanly because the previous phase ended in a known-green state. The change as a whole archives only after Phase 5 is verified on the user's iPhone.

## Open Questions

- iOS app icon and launch screen — design has overlay states but no app icon. Use a placeholder violet dot for v1, finalize after first device install.
- Device naming on iOS — `Preferences.deviceName` is `Host.current().localizedName` on Mac. On iOS, use `UIDevice.current.name` (e.g., "Nikita's iPhone") — confirm before Phase 5.
- VAD hysteresis defaults — tune empirically during Phase 5 with real microphone input; ship a conservative default that errs toward fewer false starts.
- Mac status-item drop animation on macOS 26 — animation API has not changed but macOS 26 menu-bar layout did; confirm `NSStatusItem.button.window.frame` still gives screen coordinates after that update. If not, fall back to fade-in.
