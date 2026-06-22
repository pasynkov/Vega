## Why

The Swift client side (`packages/ear-core`) has solid unit-tests for individual building blocks: `OverlayViewModel` apply-rules (13 tests), `SessionCoordinator` per-event handlers (22 tests), `SilenceDetector`, `Preferences`, `AudioPipeline`. What is missing is the next tier up: **end-to-end session journeys** that drive `SessionCoordinator` through a realistic ordered sequence of wire events (register → wake → arm → partial/final transcripts → overlay updates → list-view updates → core_session_end) and assert the full observable trajectory of `OverlayViewModel` + the mocked socket emissions.

Regressions of the "screens swap in the wrong order" or "caption disappeared after a thinking update" kind cannot be caught by either: (a) the existing per-event unit-tests, which assert single-step transitions in isolation; or (b) the planned backend `add-backend-e2e-harness`, which exercises Core's wire-side but does not touch `EarCore` Swift code. This change closes that gap on the client side without spinning up a real socket, a real Nest process, or a SwiftUI runtime — pure logic, in-process, fast.

Audio bytes are explicitly out of scope (per product call: audio is verified live on device).

## What Changes

- Add a new test file `packages/ear-core/Tests/EarCoreTests/SessionJourneyTests.swift` that exercises `SessionCoordinator` through complete session scenarios using the existing `SessionCoordinatorMocks` (FakeAudioEngine, FakeWakeDetector, FakeEarSocket, FakeCuePlayer, FakeStatusController, FakeOverlayController) — no new mock infrastructure unless strictly required.
- Cover the following journeys (one `func test…` per scenario):
  - `testJourney_BasicWakeToSuccessToIdle` — register → wake → session_start → partial → final → overlay(thinking) → overlay(success) → core_session_end(endpoint) → overlay hidden / status idle. Asserts the full `OverlayViewModel.kind` sequence + sticky caption from final.
  - `testJourney_ContinuousArm_AckAsBadge` — wake handled → tool emits `arm_capture(continuous)` → coordinator plays `ackContinue` → second session opens without a new wake → final → core_session_end. Asserts cue sequence + no overlay flicker between back-to-back sessions.
  - `testJourney_AskMode_ListenWindow` — `arm_capture(ask)` while idle → coordinator plays `cueListen` → opens an ask session → final → answer flows back via the existing socket emission path.
  - `testJourney_Immersive_ModeBridge` — initial regular session → tool emits `arm_capture(immersive)` mid-flow → coordinator emits a clean session_end for the previous session and opens an immersive one → final → end.
  - `testJourney_StickyCaption` — final `"купи молоко"` → overlay_update(thinking) carrying no caption → assert `OverlayViewModel.caption == "купи молоко"` after the thinking update.
  - `testJourney_ListViewOpenDuringSession` — full session that includes a `list_view_update(open: true)` mid-flow → assert overlay stays visible, list-view rendered, `idle` after end does NOT hide overlay while list-view is open.
  - `testJourney_ListViewCloseCollapses` — list-view open, then `list_view_update(open: false)` → overlay collapses to non-list view-model state.
  - `testJourney_DisconnectMidThinking` — socket disconnect after overlay(thinking) but before any core_session_end → assert overlay hidden, active session cleared, status reset to idle.
  - `testJourney_SttErrorEndsWithErrorOverlay` — `core_session_end(reason: sttError, detail: "…")` → assert `StatusController.setState(.error(…))` + overlay rendered with `.error` kind.
  - `testJourney_StaleOverlaySeqDuringJourney` — verify monotonic-`seq` enforcement when stale updates arrive in the middle of a realistic journey (catches "seq counter reset by accident").
- The new test file MAY introduce small recording helpers (e.g., a journey-DSL like `journey.emit(.wake).expectOverlay(.listening).emitFinal("x").expectCaption("x")`) only if doing so removes meaningful duplication across the 10 tests; otherwise keep direct `XCTAssertEqual` on the existing mock spies.
- No production code is touched. No new Swift packages, no new test target, no new dependency. Only `Tests/EarCoreTests/` gains one file.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `ear-shared-swift`: adds a SHALL-have requirement that `EarCoreTests` includes a *session-journey* test layer covering the wake-to-end orderings listed above. The existing requirement (which only says the test target covers the session coordinator) does not specify journey-level scenarios; this change makes journey coverage a spec-level requirement so future refactors cannot quietly drop it.

## Impact

- Single new file: `packages/ear-core/Tests/EarCoreTests/SessionJourneyTests.swift` (~300–400 LoC, ~10 tests).
- No production-code edits. No new dependencies. No build-graph changes.
- Test runtime: each journey is in-process synchronous mock driving; expected total +0.3–0.5 s to the EarCore test suite.
- Out of scope: SwiftUI/snapshot tests (separate concern, not requested), client↔Nest socket integration (separate change if needed), audio bytes (verified live on device by product decision).
- Risk: writing journey tests may surface real bugs in `SessionCoordinator` (e.g. caption stickiness edge cases). If so, follow reverse-TDD: record as `XCTSkip` / `XCTExpectFailure` with an inline reference, raise a follow-up change for the fix. This change SHALL NOT modify business code to make tests pass.
