## Context

`packages/ear-core` has two parallel tested layers today:

```
EarSocket → SessionCoordinator → OverlayController (& StatusController, CuePlayer)
                  │
                  └─ also calls into OverlayViewModel via OverlayController.applyOverlayUpdate
```

- `SessionCoordinatorTests` (22 tests) exercises `SessionCoordinator` against `MockOverlayController`, which simply *records* each incoming `OverlayUpdateMessage` into a list. It never runs the message through `OverlayViewModel`. So those tests verify "did Coordinator emit the right overlay message?" but not "what would the user actually see across a full session?".
- `OverlayViewModelTests` (13 tests) drives `OverlayViewModel` directly with synthetic messages, asserting per-message transitions. It never sees a session shape — no wake, no ack, no end.

The seam between the two is where "screens swap in the wrong order" / "caption disappeared after a thinking update" bugs hide. Journey-tests close that seam by running a realistic ordered scenario through `SessionCoordinator` while feeding the resulting `OverlayUpdateMessage`s into a **real** `OverlayViewModel`, and then asserting `vm.kind` / `vm.caption` / `vm.listView…` at every checkpoint.

## Goals / Non-Goals

**Goals:**
- One test layer that observes the union of Coordinator behaviour + view-model state across realistic session journeys.
- Fast and deterministic. In-process, no real socket, no SwiftUI, no UIKit/AppKit, no audio bytes.
- Zero production-code changes.
- Strict reuse of existing mocks; minimum new test infrastructure.

**Non-Goals:**
- SwiftUI rendering / snapshot diff (not requested; see `add-ear-client-session-journey-tests` proposal §Out of scope).
- Real socket transport / cross-process e2e against Nest (deferred; would be a follow-up change `add-swift-e2e-bridge` if real socket regressions appear).
- Audio frame round-tripping (audio path verified live on device by product decision).
- Changing `SessionCoordinator` or `OverlayViewModel` semantics in any way.

## Decisions

### D1 — Place tests in `EarCoreTests`, not in a new package

**Decision:** Add the new file to `packages/ear-core/Tests/EarCoreTests/SessionJourneyTests.swift`. Do not create a new test target or new package.

**Why:** The system under test is `EarCore`. Existing mocks live in `EarCoreTests` and use `@testable import EarCore`. A new test target would force duplicate mock files or re-export internal symbols. Net cost ≪ benefit.

**Alternatives considered:**
- New `EarCoreScenarioTests` target — extra Package.swift edits, extra build product, no isolation upside.
- Place in `EarUITests` — wrong layer; this tests Coordinator behaviour, not UI.

### D2 — Run the real `OverlayViewModel` inside the journey rig

**Decision:** Introduce a test-only `JourneyOverlayController: OverlayControlling` whose `applyOverlayUpdate` / `applyListViewUpdate` forward to a real `OverlayViewModel` AND record the raw messages. Tests assert on `vm.kind` / `vm.caption` / `vm.listViewItems` / `vm.isVisible`.

**Why:** Asserting on the message stream alone (what `MockOverlayController` does today) misses bugs that live entirely inside `OverlayViewModel.apply` — seq drops, sticky-caption fallthrough, list-view-keeps-overlay-visible logic. Running the real view-model is the whole point of "journey" testing.

**Alternatives considered:**
- Modify `MockOverlayController` in place to also drive a `OverlayViewModel`. Rejected: would couple existing per-event tests to a new behaviour they don't need; risks accidental breakage. Keep `MockOverlayController` exactly as it is; add a sibling.
- Make `OverlayViewModel` optional on `MockOverlayController`. Rejected: same coupling concern, less explicit.

### D3 — Tiny journey-DSL only if it removes duplication

**Decision:** Default to plain inline driver calls (`rig.wake.trigger()`, `rig.socket.handlers.onCoreSessionEnd(...)`, `vm.apply(...)`) and direct `XCTAssertEqual`. Add a journey-DSL helper struct ONLY if ≥3 tests collapse to the same boilerplate that's worth abstracting.

**Why:** This is a closed set of ~10 tests. A bespoke DSL is itself code to maintain. Plain XCTAssertions read fine if the rig wiring is two lines.

**Alternatives considered:**
- Always introduce a fluent `journey.emit(.wake).expect(.listening).…` API. Rejected unless needed — adds surface area and indirection.

### D4 — Reverse-TDD on bugs surfaced

**Decision:** Same policy as `add-backend-e2e-harness` (see its proposal §What Changes #3): if a journey-test surfaces a real client-side bug, record as `XCTSkip("BUG: <one-line> — fix in follow-up <change-name>")` or `XCTExpectFailure { … }` with inline reason. Do NOT modify business code in this change.

**Why:** Keep proposal scope tight. Bugs are findings, not the work item.

**Alternatives considered:**
- Fix bugs inline. Rejected: scope creep; bugs deserve their own proposals with proper specs.

### D5 — No spec change to `mac-ear` or `ios-ear`

**Decision:** The only spec touched is `ear-shared-swift`. App-shell specs are untouched.

**Why:** Journey-tests live in the shared library. App shells do not gain or lose any requirement.

## Risks / Trade-offs

- **[Risk]** Journey-tests may catch real bugs that block the merge if we forgot the reverse-TDD policy. → Mitigation: D4 + explicit reverse-TDD note in proposal §Impact; reviewer enforces.
- **[Risk]** Test data setup for `WakeAck` / `arm_capture` / `core_session_end` payloads is verbose and easy to drift from protocol. → Mitigation: reuse helper factories already used by `SessionCoordinatorTests` (or extract to a small fixtures file if reused ≥3x). Round-trip safety is already covered by `RoundTripTests`.
- **[Risk]** `OverlayViewModel` is `@MainActor`-isolated in some Swift toolchain configs. Tests must run on the main actor to call `apply` synchronously. → Mitigation: mark journey-test methods `@MainActor` if compiler requires; otherwise rely on the same actor isolation the existing `OverlayViewModelTests` use (current file is not annotated, so this is already fine on macOS Swift 5.9+).
- **[Trade-off]** Journey-tests are higher value but slower (compose multiple events). With 10 scenarios at ~30 ms each, +0.3 s total — acceptable.
- **[Risk]** The `JourneyOverlayController` adapter could drift from `MockOverlayController` semantics. → Mitigation: it's a single file with ~30 LoC; keep it dumb (forward + record).

## Migration Plan

No migration. Pure test addition. To roll back: delete the new file.

## Open Questions

- Should "ack-as-badge" timing assertions be in this change or stay in `OverlayViewModelTests`? Current call: journey covers the user-visible end-to-end timing of badge → listening transition. Per-event timing stays in unit-level tests. If overlap proves redundant after writing, prune the unit-level copy in a follow-up.
- Whether to add a `testJourney_RegistrationFailure` (socket connect, no register-ack arrives, status stays offline) — left out of the initial list because the existing `SessionCoordinatorTests` already cover the `onStatusChange` path; can be added later if real bugs appear.
