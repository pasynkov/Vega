## 0. Characterization tests on the current Mac Ear (Phase 0)

- [x] 0.1 Test target `VegaEarTests` already exists in `Package.swift`; extended with new files.
- [x] 0.2 `SessionCoordinatorTests` (22 tests): wake-opens-session, second-wake-ignored, paused-wake-ignored, setPaused-during-active-emits-end, stopActiveSession, simulateWake, arm_capture for continuous/ask/immersive (each plays correct cue), arm_capture-while-active-ignored, core session_end (endpoint / stt_error / unknown sessionId), wake_ack(yield) terminates session, overlay_update forwarded + sound played, list_view_update forwarded, socket disconnect resets overlay, shutdown wiring, onSessionStateChange firing, audio frames forwarded only with active session.
- [x] 0.3 `EarSocketHandlersTests`: defaults are no-ops, each slot overridable independently. Note: the concrete `EarSocket` (real SocketManager) is not exercised in unit tests — its integration is covered transitively through `SessionCoordinatorTests` via the `EarSocketing` mock, and end-to-end against a real Core during the Phase 0 manual gate.
- [x] 0.4 `AudioPipelineTests`: `PcmPassthroughEncoder` round-trip + empty input + flush, plus `RingBuffer` capacity / drain / under-capacity behavior. `AudioEngine` (AUHAL) is hardware-bound and not unit-tested; verified manually at the Phase 0 gate.
- [x] 0.5 `SilenceDetectorTests` extended: calibration window, endpoint after speech-then-silence, endpoint never fires without prior speech, empty PCM tolerated, existing endpoint-suppressed test preserved.
- [x] 0.6 `PreferencesTests` extended: micUID defaults nil, micUID clears to nil, threshold boundaries (0.0 / 1.0) nudged inward, on-disk permissions are 0o600, corrupt persisted file ignored on load.
- [x] 0.7 `OverlayViewModelTests` (13 tests): initial hidden, first non-idle makes visible, hint+caption render together, idle hides when no list, idle stays visible when list open, stale seq dropped (overlay + list view), list items render with title, list close collapses panel, hide() resets all state + seq counters, applyUnknown renders listening fallback, applyUnknown stale seq ignored.
- [x] 0.8 `swift test` from `apps/mac-ear/`: 58 tests green. Build clean.
- [ ] 0.9 Manually verify the Mac Ear still runs end-to-end against a local Core (wake → speak → response → cue → idle)
- [ ] 0.10 Commit Phase 0 as a single atomic change; gate the next phase on this commit

**Phase 0 production-code touches (Plan B from explore):**
- Introduced protocols rather than concrete-type constructor params, so SessionCoordinator can be tested with mocks: `EarSocketing`, `AudioCapturing`, `CuePlaying`, `StatusControlling`, `OverlayControlling`. `WakeWordDetector` was already a protocol; `AudioFrameProducer` was already a protocol.
- Concrete classes conform without behavior change: `EarSocket`, `AudioEngine`, `CuePlayer`, `StatusItemController`, `OverlayWindowController`.
- `OverlayWindowController` gained thread-safe entry points (`showOverlay`, `hideOverlay`, `applyOverlayUpdate`, `applyListViewUpdate`) that marshal to the main thread internally. `SessionCoordinator` switched from `overlay.viewModel.*` direct calls to these methods.
- `SessionCoordinator` gained a test-only `waitForPendingWork()` helper that drains its serial queue.
- `EarProtocol.RawOverlayState` got a `public` memberwise init (it was inadvertently internal).
- `swift build` clean, end-to-end manual run (Step 0.9) deferred to the user.

## 1. Extract `packages/ear-core/swift/` (Phase 1)

- [x] 1.1 Create `packages/ear-core/swift/Package.swift` with platforms `.macOS(.v13)`, `.iOS(.v26)`, product `EarCore`, dependency `EarProtocol`
- [x] 1.2 Move `SessionCoordinator.swift` to `packages/ear-core/swift/Sources/EarCore/`, update its imports, update its call sites in `apps/mac-ear/` to `import EarCore`
- [x] 1.3 Move `EarSocket.swift` to `EarCore/`; update call sites
- [x] 1.4 Move `AudioEngine.swift` to `EarCore/`; update call sites
- [x] 1.5 Move `OpusEncoder.swift` to `EarCore/`; update call sites
- [x] 1.6 Move `SilenceDetector.swift` to `EarCore/`; update call sites
- [x] 1.7 Move `Preferences.swift` to `EarCore/`; update call sites
- [x] 1.8 Move `DeviceIdentityService.swift` to `EarCore/`; update call sites
- [x] 1.9 Move `CuePlayer.swift` to `EarCore/`; update call sites
- [x] 1.10 Move `OverlayViewModel.swift` to `EarCore/` (it's a logic/state type; UI lives in EarUI later); update call sites
- [x] 1.11 Add `apps/mac-ear/Package.swift` local SPM dependency on `packages/ear-core/swift/`; remove the moved files from the executable target's `path`
- [x] 1.12 Move every test from `apps/mac-ear/Tests/VegaEarTests/` into `packages/ear-core/swift/Tests/EarCoreTests/`; rewire imports
- [x] 1.13 Run `swift test` in both packages; all tests SHALL be green
- [ ] 1.14 Manually verify the Mac Ear still runs end-to-end against a local Core
- [x] 1.15 Audit: `apps/mac-ear/Sources/VegaEar/` SHALL no longer contain the moved files; the executable SHALL still build
- [ ] 1.16 Commit Phase 1; gate the next phase

## 2. `vad` capability in the protocol (Phase 2)

- [x] 2.1 Add `"vad"` to the `Capability` Zod enum in `packages/ear-protocol/src/schema.ts` with an inline comment describing the wake-wordless entry contract
- [x] 2.2 Add `case vad` to the Swift `Capability` enum in `packages/ear-protocol/swift/Sources/EarProtocol/EarProtocol.swift` with the matching comment
- [x] 2.3 Update the protocol README / inline docs to state: "A `vad`-capable device opens `session_start` on voice-activity detection with no preceding `wake_detected`. Core does not enforce the wake precondition today; clients SHALL still follow the contract appropriate to their declared capabilities."
- [x] 2.4 Add a fixture example to `packages/ear-protocol/fixtures/examples.json` for a `register` payload whose `capabilities` includes `"vad"`
- [x] 2.5 Update the TS round-trip test to include the new fixture
- [x] 2.6 Update the Swift round-trip test (`packages/ear-protocol/swift/Tests/EarProtocolTests/`) to include the new fixture
- [x] 2.7 Run `pnpm test` in `packages/ear-protocol/` and `swift test` in `packages/ear-protocol/swift/`; all green
- [ ] 2.8 Run `pnpm test` in `apps/core/` to confirm Core's existing wake/session unit tests are still green (no enforcement change expected)
- [ ] 2.9 Commit Phase 2; gate the next phase

## 3. Build `packages/ear-ui/swift/` with the v1 design (Phase 3)

- [x] 3.1 Create `packages/ear-ui/swift/Package.swift` with platforms `.macOS(.v13)`, `.iOS(.v26)`, product `EarUI`, dependencies `EarCore`, `EarProtocol`
- [ ] 3.2 Add font files: download `Golos Text` (weights 400/500/600/700) and `JetBrains Mono` (weights 400/500); place under `Sources/EarUI/Resources/Fonts/`; commit `OFL.txt` and `LICENSE` alongside
- [x] 3.3 Implement `Theme.swift`: palette tokens, typographic roles, `Theme.registerFonts()` (idempotent via a once-token)
- [x] 3.4 Implement `MorphMark.swift`: single SwiftUI `Canvas` driven by a `MorphState` value type
- [x] 3.5 Implement `TimelineDriver.swift`: pure function `(OverlayKind, elapsed) -> MorphState`; one keyframe block per state matching the per-state visual definitions in the `overlay-design-v1` spec
- [x] 3.6 Implement `OverlayView.swift`: composes `MorphMark`, optional `hint`/`caption`, and optional `ListView`; supports `compact` and `fullScreen` layout modes
- [x] 3.7 Implement `ListView.swift`: title with done/total counter, rows with bullet + label, struck-through done state, "(пусто)" placeholder
- [x] 3.8 Move the existing `OverlayView.swift` body content from `EarCore` (Phase 1 location) into the new `EarUI.OverlayView`; delete the old file once call sites are migrated
- [x] 3.9 Add `EarUITests/ThemeTests.swift` asserting each palette token's SRGB components within 1/255
- [x] 3.10 Add `EarUITests/TimelineDriverTests.swift` asserting determinism — same inputs → same `MorphState`
- [ ] 3.11 Add a SwiftUI preview / harness target (or test app) cycling every `OverlayKind` so the developer can visually review the morph
- [x] 3.12 Run `swift test` in `packages/ear-ui/swift/`; all green
- [ ] 3.13 Visually review every overlay state and the list view layout on both macOS and an iOS simulator; record any issues and either fix or defer per the no-regression policy
- [ ] 3.14 Commit Phase 3; gate the next phase

## 4. Mac Ear adopts EarUI and the drop-from-tray animation (Phase 4)

- [x] 4.1 Add local SPM dependency on `packages/ear-ui/swift/` in `apps/mac-ear/Package.swift`
- [x] 4.2 In `AppDelegate`, replace the legacy overlay view construction with `EarUI.OverlayView(layout: .compact, viewModel: …)`
- [x] 4.3 Delete the legacy `OverlayView.swift` / `OverlayViewModel.swift` references from the executable target if any remain after Phase 1 / 3
- [x] 4.4 In `OverlayWindowController`, read `NSStatusItem.button?.window?.frame` on show; place the `NSPanel` so its top edge sits at the status-item bottom edge, opacity 0
- [x] 4.5 Animate `NSPanel.setFrame(_:display:animate:)` downward to the resting position concurrent with opacity 0→1 over ~220 ms using `NSAnimationContext`
- [x] 4.6 On hide, reverse: translate upward into the menu-bar region concurrent with opacity 1→0 over ~180 ms; call `orderOut(_:)` on completion
- [x] 4.7 Fall back to a fade-in at the resting position when the status-item frame is unavailable (overflow menu)
- [x] 4.8 Call `EarUI.Theme.registerFonts()` once at app launch
- [x] 4.9 Re-run every test in `EarCoreTests` and `EarUITests`; all green
- [ ] 4.10 Manually exercise every `OverlayKind` (idle, listening, capturing, thinking, processing, success, error, view, immersive) on macOS; confirm the drop animation feels right and the morph transitions are smooth
- [ ] 4.11 Manually exercise the list-view surface (shopping flow) end-to-end
- [ ] 4.12 Commit Phase 4; gate the next phase

## 5. iOS Ear app (Phase 5)

- [ ] 5.1 Create `apps/ios-ear/ios-ear.xcodeproj` with a single iOS app target, minimum deployment iOS 26.0, SwiftUI lifecycle (`@main App`)
- [ ] 5.2 Add local SPM package references in the Xcode project to `packages/ear-core/swift/`, `packages/ear-ui/swift/`, `packages/ear-protocol/swift/`
- [x] 5.3 Set Info.plist `NSMicrophoneUsageDescription` to "Vega Ear слушает голосовые команды, пока приложение открыто."
- [x] 5.4 Confirm Info.plist does NOT set `UIBackgroundModes` to `audio`
- [x] 5.5 Add `Settings.bundle/Root.plist` with a single `PSTextFieldSpecifier` for key `server_endpoint`, title "Server endpoint" ("Адрес сервера"), default `ws://localhost:3000`
- [x] 5.6 Implement `App.swift` reading `UserDefaults.standard.string(forKey: "server_endpoint")` on launch and on `UIApplication.didBecomeActiveNotification`; tear down and reconnect the WebSocket when the value changes
- [x] 5.7 Configure `AVAudioSession` with `.playAndRecord`, mode `.voiceChat`, options `.duckOthers | .defaultToSpeaker`; activate on `.active`, deactivate on `.inactive`/`.background`
- [x] 5.8 Persist `deviceId` (UUID v4) under `UserDefaults` key `device_id`; generate once on first launch
- [x] 5.9 Report `deviceName` as `UIDevice.current.name` (fallback `"iPhone"`)
- [x] 5.10 Wire `EarCore.SessionCoordinator` in VAD mode: subscribe to `SilenceDetector` onset events to emit `session_start`; subscribe to offset events to emit `session_end` with reason `vad`
- [x] 5.11 Set the root view to `EarUI.OverlayView(layout: .fullScreen, …)` bound to a view-model that consumes `overlay_update` and `list_view_update`
- [x] 5.12 Call `EarUI.Theme.registerFonts()` once at app launch
- [x] 5.13 Hide the status bar during non-idle overlay states
- [ ] 5.14 Add `ios-earTests` unit target with a smoke test that the app launches in the simulator without throwing
- [ ] 5.15 Manually deploy to a physical iPhone running iOS 26+ and walk through the seven-item verification checklist from the `ios-ear` spec; record results in this tasks file as completed items
- [ ] 5.16 Commit Phase 5; ready for archive

## 6. Cross-phase tooling and CI hygiene

- [ ] 6.1 Update root `package.json` scripts to invoke `swift test` for every Swift package as part of the project's test command (if a unified test runner exists)
- [ ] 6.2 Update `.gitignore` for the Xcode project's local user data (`*.xcuserdata`, etc.)
- [ ] 6.3 Update the project README's "Apps" section to mention `apps/ios-ear/` and how to build it locally
- [ ] 6.4 Note the embedded font licenses in the project's NOTICE / LICENSE-list if one exists
