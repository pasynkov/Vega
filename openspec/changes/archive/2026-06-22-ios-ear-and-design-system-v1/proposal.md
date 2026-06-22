## Why

Vega is currently usable only at the Mac. A phone-shaped Ear unlocks the assistant when the user is away from the desk — kitchen, walking, errand-running — and is the natural home for the shopping list. The mac and (future) iOS surfaces also need a coherent visual language: the existing overlay was a placeholder, while the v1 design (`design/Vega v1`) defines a single "seamless morph" mark that the user reads at a glance across devices. Doing the iPhone client and the visual system together avoids landing two consecutive redesigns of the same code and lets us extract the cross-platform Swift core once, with tests in place, before two clients diverge.

## What Changes

- Introduce `packages/ear-core/swift/` — cross-platform Swift package containing the session coordinator, socket transport, audio engine, Opus encoder, silence detector, preferences, device-identity service, and cue player. Both Mac and iOS Ears depend on it.
- Introduce `packages/ear-ui/swift/` — SwiftUI design system: the morph-mark Canvas, timeline driver, list view, dark theme tokens, palette, and embedded `Golos Text` + `JetBrains Mono` fonts.
- Introduce `apps/ios-ear/` — Xcode iOS application (iOS 26+) hosting the shared UI full-screen. Foreground-only microphone (no background audio mode), no wake-word detector, VAD-triggered sessions, server endpoint configured via iOS Settings.bundle.
- Refactor `apps/mac-ear/` into a thin AppKit shell (status item, `NSPanel` wrapper, CoreAudio device catalog) consuming `ear-core` and `ear-ui`. Behavior is preserved (wake-word, sample rate, cues) but the panel now lands on a "drop from tray" animation originating from the status-item frame, and the overlay renders the new morph mark.
- Add a `vad` capability to the `register` event so a device can declare "I have no wake-word and will open sessions on voice activity instead." When such a device emits `session_start`, Core SHALL accept it without a preceding `wake_detected`.
- **BREAKING (Swift consumers only)**: existing imports inside `apps/mac-ear/` change from local file targets to the new `EarCore` / `EarUI` modules. Wire protocol, Core code, and downstream TS/Swift consumers outside `apps/mac-ear` are unaffected.

## Capabilities

### New Capabilities

- `ios-ear`: iPhone Ear application — lifecycle, microphone & audio session policy, VAD-triggered sessions, full-screen overlay rendering, endpoint configuration through iOS Settings.bundle, dev-sideload distribution.
- `ear-shared-swift`: structure and ownership of the two new Swift packages (`ear-core`, `ear-ui`), which files live where, and how the Mac and iOS shells consume them.
- `overlay-design-v1`: the visual contract — palette, embedded fonts, the morph-mark visual language, per-`OverlayKind` motion, list-view layout, and the platform-specific entry metaphors (`drop from tray` on macOS, `expand` on iOS).

### Modified Capabilities

- `ear-protocol`: add `vad` to the `Capability` enum and document the session-entry trigger contract (a `vad`-capable device opens `session_start` on voice activity, with no preceding `wake_detected`).
- `mac-ear`: now consumes `ear-core` and `ear-ui` instead of bundling logic and UI in the executable target; the overlay window animates in from the status-item frame ("drop from tray") and renders the v1 morph mark instead of the placeholder orb.

## Impact

- **New code**: `packages/ear-core/swift/`, `packages/ear-ui/swift/`, `apps/ios-ear/` (Xcode project, not SwiftPM, because Settings.bundle + entitlements + signing).
- **Refactored code**: every file under `apps/mac-ear/Sources/VegaEar/` either moves to a shared package or shrinks to glue. `apps/mac-ear/Package.swift` adds local SPM dependencies on the two new packages.
- **Protocol / Core**: `packages/ear-protocol/src/schema.ts` and its Swift mirror gain a `vad` capability variant. Core's `ear.gateway.ts` `session_start` handler already accepts a `session_start` without a preceding `wake_detected`, so no Core enforcement change is required in this scope — the `vad` capability formalizes the contract for future enforcement and for client implementors. The Zod round-trip fixture set gains a `vad`-device example.
- **Tests**: a new `apps/mac-ear/Tests/VegaEarTests` characterization suite (XCTest) lands in Phase 0 to lock current behavior. It then migrates with the code into `ear-core/Tests`. iOS app gains `ios-earTests` (unit) and is manually verified on a physical device — no UI automation.
- **Dependencies**: no new SPM dependencies; existing `socket.io-client-swift` is reused on iOS. `onnxruntime-swift-package-manager` remains a Mac-only dep (iOS does not link it).
- **Distribution**: iOS build is dev-signed for personal sideload; no App Store submission, no TestFlight wiring in this change. Future TestFlight is out of scope here.
- **Assets**: `Golos Text` (OFL) and `JetBrains Mono` (Apache 2.0) font files ship inside `ear-ui` Resources. Licenses are committed alongside.
- **Behavior parity gate**: at the end of every phase the mac-ear app SHALL still pass its characterization tests and SHALL still be usable end-to-end against a local Core. Any phase that fails this gate blocks the next.
