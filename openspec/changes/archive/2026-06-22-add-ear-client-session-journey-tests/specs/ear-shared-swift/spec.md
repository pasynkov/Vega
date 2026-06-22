## ADDED Requirements

### Requirement: EarCoreTests includes a session-journey test layer

`packages/ear-core/Tests/EarCoreTests/` SHALL contain a session-journey test layer that drives `SessionCoordinator` through complete, ordered, realistic session lifecycles AND feeds the resulting `OverlayUpdateMessage` / `ListViewUpdateMessage` events into a real `OverlayViewModel`, asserting the union of (a) the events the coordinator emits to the socket / cue player / status controller AND (b) the resulting view-model state at every checkpoint.

Journey tests SHALL cover at minimum:

- A basic wake-to-success-to-idle journey ending in `core_session_end(endpoint)`, asserting the full `OverlayViewModel.kind` sequence and the sticky `liveCaption` set from `final_transcript`.
- A continuous-arm journey (ack-as-badge): wake → `arm_capture(continuous)` → coordinator plays `ackContinue` and opens a follow-up session without a fresh wake → `core_session_end`.
- An ask-mode arm journey: idle → `arm_capture(ask)` → cue + session open → `final_transcript` answer → end.
- An immersive-mode bridge journey: regular session → `arm_capture(immersive)` mid-flow → coordinator emits a clean `EarSessionEnd` for the previous session and opens an immersive one → end.
- A sticky-caption journey: `final_transcript "X"` → subsequent `overlay_update(thinking)` carrying no caption → `OverlayViewModel.liveCaption` SHALL remain `"X"` (the payload `caption` channel is independent and may be `nil`; the sticky channel is `liveCaption`).
- A list-view-open journey: `list_view_update(open: true)` mid-session → overlay SHALL remain visible after an `overlay_update(idle)` while the list view is still open.
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
