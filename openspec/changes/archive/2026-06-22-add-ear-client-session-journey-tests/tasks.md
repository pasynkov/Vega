## 1. Test rig scaffolding

- [x] 1.1 Add a test-only `JourneyOverlayController: OverlayControlling` to `packages/ear-core/Tests/EarCoreTests/SessionCoordinatorMocks.swift` (or a sibling `JourneyRig.swift` file under the same dir, whichever keeps the existing mocks file small) that holds an injected `OverlayViewModel`, forwards `applyOverlayUpdate` / `applyListViewUpdate` to it AND records the raw messages
- [x] 1.2 Add a `CoordinatorJourneyRig` factory analogous to the existing `CoordinatorTestRig.make`, but wiring the new `JourneyOverlayController` (with a fresh `OverlayViewModel`) in place of `MockOverlayController`; expose `vm: OverlayViewModel` on the rig for assertions
- [x] 1.3 Verify the new rig compiles and `swift test --package-path packages/ear-core` still passes (no behaviour change to existing tests)

## 2. Journey scenarios

- [x] 2.1 Add `packages/ear-core/Tests/EarCoreTests/SessionJourneyTests.swift` skeleton (XCTestCase, imports, journey helper closures if D3 indicates duplication ≥ 3 tests)
- [x] 2.2 `testJourney_BasicWakeToSuccessToIdle` — drive register → wake → session_start → partial → final → overlay(thinking) → overlay(success) → core_session_end(endpoint); assert `vm.kind` sequence, sticky `vm.caption`, status ends `.idle`
- [x] 2.3 `testJourney_ContinuousArm_AckAsBadge` — wake → arm_capture(continuous) → assert `MockCuePlayer.played` contains `ackContinue` AND a second `SessionStart` is emitted without a fresh wake → final → core_session_end
- [x] 2.4 `testJourney_AskMode_ListenWindow` — idle → arm_capture(ask) → assert `cueListen` cue + ask-mode `SessionStart` emitted → final → end
- [x] 2.5 `testJourney_Immersive_ModeBridge` — regular session active → arm_capture(immersive) → assert previous `EarSessionEnd` emitted AND new immersive `SessionStart` opens → final → end
- [x] 2.6 `testJourney_StickyCaption` — final "купи молоко" → overlay_update(thinking) without caption → `vm.caption == "купи молоко"`
- [x] 2.7 `testJourney_ListViewOpenDuringSession` — full session that includes `list_view_update(open: true, items)` followed by `overlay_update(idle)` → `vm.isVisible == true`, `vm.listViewItems` not empty
- [x] 2.8 `testJourney_ListViewCloseCollapses` — list view open → `list_view_update(open: false)` → `vm.listViewItems` empty AND `vm.isVisible` matches non-list state (or hidden if idle)
- [x] 2.9 `testJourney_DisconnectMidThinking` — reach overlay(thinking) → socket disconnect → `vm.isVisible == false`, active session cleared, status `.idle`
- [x] 2.10 `testJourney_SttErrorEndsWithErrorOverlay` — core_session_end(reason: sttError, detail: "deepgram dropped") → status states include `.error("deepgram dropped")` AND `vm.kind == .error`
- [x] 2.11 `testJourney_StaleOverlaySeqDuringJourney` — within a valid journey, inject an overlay_update with a stale seq → assert it is dropped (no view-model state mutation; `vm.kind` unchanged)

## 3. Reverse-TDD bug log

- [x] 3.1 For every journey test that surfaces a real bug while writing this change, mark with `XCTSkip("BUG: <one-liner> — follow-up: <change-name>")` or `XCTExpectFailure { … }` AND open a follow-up change proposal under `openspec/changes/<change-name>/`
- [x] 3.2 Do NOT modify any file under `packages/ear-core/Sources/` or `packages/ear-ui/Sources/` in this change — only `Tests/EarCoreTests/` is in scope

## 4. Validation

- [x] 4.1 Run `swift test --package-path packages/ear-core`; new file SHALL build and either all tests pass or every failure is `XCTSkip`/`XCTExpectFailure` per §3.1
- [x] 4.2 ~~Run `xcodebuild -project apps/ios-ear/VegaEariOS.xcodeproj -scheme EarCore test`~~ — deferred: `EarCore` scheme inside `VegaEariOS.xcodeproj` is not configured for the test action ("Scheme EarCore is not currently configured for the test action"). `swift test --package-path packages/ear-core` already runs the journey tier on Darwin with no platform conditionals; an iOS-simulator run would be a tautological re-execution of the same Swift code. Re-enable if the project scheme gains a test action.
- [x] 4.3 Confirm no production-code file changed in this branch (`git diff --stat -- packages/ear-core/Sources packages/ear-ui/Sources apps/` is empty)
- [x] 4.4 Run `openspec validate add-ear-client-session-journey-tests --strict` and resolve any complaints
