import XCTest
import EarProtocol
@testable import EarCore

// Session-journey tier. Drives `SessionCoordinator` through realistic
// ordered lifecycles AND observes a real `OverlayViewModel` via
// `JourneyOverlayController` to assert the union of "what the
// coordinator emitted" + "what the view-model now displays".
//
// Per-event behaviour stays in `SessionCoordinatorTests` and
// `OverlayViewModelTests`. This file is the seam between them.
@available(macOS 14, iOS 17, *)
@MainActor
final class SessionJourneyTests: XCTestCase {

    private func triggerWake(_ rig: CoordinatorJourneyRig, score: Float = 0.9) {
        rig.wake.trigger(score: score)
        rig.coordinator.waitForPendingWork()
    }

    // 2.2 — Basic wake → ... → end. Asserts kind sequence, sticky caption,
    // and that the view-model holds its last state until Core paints idle.
    func testJourney_BasicWakeToSuccessToIdle() {
        let rig = CoordinatorJourneyRig.make()
        triggerWake(rig)
        let sid = rig.socket.emittedSessionStartMessages().first!.sessionId

        rig.socket.handlers.onOverlayUpdate(
            OverlayUpdateMessage(seq: 1, state: OverlayState(kind: .listening, hint: "Слушаю"))
        )
        XCTAssertEqual(rig.vm.kind, .listening)
        XCTAssertTrue(rig.vm.visible)

        rig.socket.handlers.onPartialTranscript(
            PartialTranscriptMessage(sessionId: sid, text: "купи")
        )
        rig.coordinator.waitForPendingWork()
        XCTAssertEqual(rig.vm.kind, .listening, "partial transcript does not change overlay")

        rig.socket.handlers.onFinalTranscript(
            FinalTranscriptMessage(sessionId: sid, text: "купи молоко")
        )
        rig.coordinator.waitForPendingWork()
        XCTAssertEqual(rig.vm.liveCaption, "купи молоко")

        rig.socket.handlers.onOverlayUpdate(
            OverlayUpdateMessage(seq: 2, state: OverlayState(kind: .thinking, hint: "Думаю", sound: .ackThinking))
        )
        XCTAssertEqual(rig.vm.kind, .thinking)
        XCTAssertTrue(rig.cues.played.contains(.ackThinking))

        rig.socket.handlers.onOverlayUpdate(
            OverlayUpdateMessage(seq: 3, state: OverlayState(kind: .success, sound: .ackSuccess))
        )
        XCTAssertEqual(rig.vm.kind, .success)
        XCTAssertTrue(rig.cues.played.contains(.ackSuccess))

        rig.socket.handlers.onSessionEnd(
            CoreSessionEndMessage(sessionId: sid, reason: .endpoint)
        )
        rig.coordinator.waitForPendingWork()
        XCTAssertFalse(rig.coordinator.hasActiveSession)
        XCTAssertEqual(rig.status.states.last, .idle)
        XCTAssertEqual(rig.vm.kind, .success, "view-model holds last state until Core paints next")
        XCTAssertEqual(rig.vm.liveCaption, "купи молоко", "live caption sticks past session end")

        rig.socket.handlers.onOverlayUpdate(
            OverlayUpdateMessage(seq: 4, state: OverlayState(kind: .idle))
        )
        XCTAssertEqual(rig.vm.kind, .idle)
        XCTAssertFalse(rig.vm.visible)

        let kinds = rig.overlay.overlayUpdates.map { $0.state.kind }
        XCTAssertEqual(kinds, [.listening, .thinking, .success, .idle])
    }

    // 2.3 — Continuous arm. Core ends the previous (regular) session,
    // then arms a continuous one; the new session opens without a fresh
    // wake_detected, and the ack-as-badge cue (ackContinue) plays.
    func testJourney_ContinuousArm_AckAsBadge() {
        let rig = CoordinatorJourneyRig.make()
        triggerWake(rig)
        let firstSid = rig.socket.emittedSessionStartMessages().first!.sessionId
        let wakesBefore = rig.socket.emittedWakeDetectedMessages().count

        rig.socket.handlers.onFinalTranscript(
            FinalTranscriptMessage(sessionId: firstSid, text: "хочу заметку")
        )
        rig.coordinator.waitForPendingWork()

        rig.socket.handlers.onSessionEnd(
            CoreSessionEndMessage(sessionId: firstSid, reason: .user)
        )
        rig.coordinator.waitForPendingWork()
        XCTAssertFalse(rig.coordinator.hasActiveSession)

        rig.socket.handlers.onArmCapture(ArmCaptureMessage(mode: .continuous))
        rig.coordinator.waitForPendingWork()

        XCTAssertTrue(rig.cues.played.contains(.ackContinue), "continuous arm plays ackContinue")
        let starts = rig.socket.emittedSessionStartMessages()
        XCTAssertEqual(starts.count, 2)
        XCTAssertEqual(starts[1].mode, .continuous)
        XCTAssertNotEqual(starts[0].sessionId, starts[1].sessionId)
        XCTAssertTrue(rig.coordinator.hasActiveSession)

        let secondSid = starts[1].sessionId
        rig.socket.handlers.onFinalTranscript(
            FinalTranscriptMessage(sessionId: secondSid, text: "молоко и хлеб")
        )
        rig.coordinator.waitForPendingWork()
        XCTAssertEqual(rig.vm.liveCaption, "молоко и хлеб")

        rig.socket.handlers.onSessionEnd(
            CoreSessionEndMessage(sessionId: secondSid, reason: .endpoint)
        )
        rig.coordinator.waitForPendingWork()
        XCTAssertFalse(rig.coordinator.hasActiveSession)

        XCTAssertEqual(
            rig.socket.emittedWakeDetectedMessages().count, wakesBefore,
            "continuous arm did not require a fresh wake_detected"
        )
    }

    // 2.4 — Ask-mode. Idle → arm_capture(ask) → cueListen + ask SessionStart.
    func testJourney_AskMode_ListenWindow() {
        let rig = CoordinatorJourneyRig.make()
        XCTAssertFalse(rig.coordinator.hasActiveSession)

        rig.socket.handlers.onArmCapture(ArmCaptureMessage(mode: .ask, captureMs: 5_000))
        rig.coordinator.waitForPendingWork()

        XCTAssertTrue(rig.coordinator.hasActiveSession)
        XCTAssertTrue(rig.cues.played.contains(.cueListen), "ask mode plays cueListen")
        let starts = rig.socket.emittedSessionStartMessages()
        XCTAssertEqual(starts.count, 1)
        XCTAssertEqual(starts[0].mode, .ask)

        let sid = starts[0].sessionId
        rig.socket.handlers.onOverlayUpdate(
            OverlayUpdateMessage(seq: 1, state: OverlayState(kind: .listening))
        )
        XCTAssertEqual(rig.vm.kind, .listening)

        rig.socket.handlers.onFinalTranscript(
            FinalTranscriptMessage(sessionId: sid, text: "да")
        )
        rig.coordinator.waitForPendingWork()
        XCTAssertEqual(rig.vm.liveCaption, "да")

        rig.socket.handlers.onSessionEnd(
            CoreSessionEndMessage(sessionId: sid, reason: .endpoint)
        )
        rig.coordinator.waitForPendingWork()
        XCTAssertFalse(rig.coordinator.hasActiveSession)
        XCTAssertEqual(rig.status.states.last, .idle)
    }

    // 2.5 — Immersive bridge. Regular session ends, then immersive is armed.
    // Two distinct session ids, ackContinue plays, mode=immersive on the
    // second SessionStart.
    func testJourney_Immersive_ModeBridge() {
        let rig = CoordinatorJourneyRig.make()
        triggerWake(rig)
        let firstSid = rig.socket.emittedSessionStartMessages().first!.sessionId

        rig.socket.handlers.onSessionEnd(
            CoreSessionEndMessage(sessionId: firstSid, reason: .user)
        )
        rig.coordinator.waitForPendingWork()
        XCTAssertFalse(rig.coordinator.hasActiveSession)

        rig.socket.handlers.onArmCapture(ArmCaptureMessage(mode: .immersive))
        rig.coordinator.waitForPendingWork()

        XCTAssertTrue(rig.cues.played.contains(.ackContinue))
        let starts = rig.socket.emittedSessionStartMessages()
        XCTAssertEqual(starts.count, 2)
        XCTAssertEqual(starts[1].mode, .immersive)
        XCTAssertNotEqual(starts[0].sessionId, starts[1].sessionId)

        let imSid = starts[1].sessionId
        rig.socket.handlers.onFinalTranscript(
            FinalTranscriptMessage(sessionId: imSid, text: "продолжаем")
        )
        rig.coordinator.waitForPendingWork()

        rig.socket.handlers.onSessionEnd(
            CoreSessionEndMessage(sessionId: imSid, reason: .user)
        )
        rig.coordinator.waitForPendingWork()
        XCTAssertFalse(rig.coordinator.hasActiveSession)
    }

    // 2.6 — Sticky live caption. STT final sets liveCaption; a subsequent
    // overlay_update(kind: .thinking) without caption MUST NOT clear it.
    // `vm.caption` (payload caption) IS cleared because the update carries
    // no caption field; `vm.liveCaption` is the sticky channel.
    func testJourney_StickyCaption() {
        let rig = CoordinatorJourneyRig.make()
        triggerWake(rig)
        let sid = rig.socket.emittedSessionStartMessages().first!.sessionId

        rig.socket.handlers.onOverlayUpdate(
            OverlayUpdateMessage(seq: 1, state: OverlayState(kind: .listening))
        )
        rig.socket.handlers.onFinalTranscript(
            FinalTranscriptMessage(sessionId: sid, text: "купи молоко")
        )
        rig.coordinator.waitForPendingWork()
        XCTAssertEqual(rig.vm.liveCaption, "купи молоко")

        rig.socket.handlers.onOverlayUpdate(
            OverlayUpdateMessage(seq: 2, state: OverlayState(kind: .thinking))
        )
        XCTAssertEqual(rig.vm.kind, .thinking)
        XCTAssertNil(rig.vm.caption, "payload caption is nil for this update")
        XCTAssertEqual(rig.vm.liveCaption, "купи молоко", "sticky live caption survives state-only update")
    }

    // 2.7 — List view stays visible past idle while it's open.
    func testJourney_ListViewOpenDuringSession() {
        let rig = CoordinatorJourneyRig.make()
        triggerWake(rig)
        let sid = rig.socket.emittedSessionStartMessages().first!.sessionId

        rig.socket.handlers.onOverlayUpdate(
            OverlayUpdateMessage(seq: 1, state: OverlayState(kind: .listening))
        )
        rig.socket.handlers.onListViewUpdate(
            ListViewUpdateMessage(
                seq: 1,
                view: ListView(
                    title: "Список",
                    items: [ListItem(id: "a", label: "молоко", done: false)],
                    open: true
                )
            )
        )
        XCTAssertTrue(rig.vm.viewOpen)
        XCTAssertEqual(rig.vm.viewItems.count, 1)

        rig.socket.handlers.onSessionEnd(
            CoreSessionEndMessage(sessionId: sid, reason: .endpoint)
        )
        rig.coordinator.waitForPendingWork()

        rig.socket.handlers.onOverlayUpdate(
            OverlayUpdateMessage(seq: 2, state: OverlayState(kind: .idle))
        )
        XCTAssertEqual(rig.vm.kind, .idle)
        XCTAssertTrue(rig.vm.viewOpen)
        XCTAssertTrue(rig.vm.visible, "overlay stays visible while list view is open")
    }

    // 2.8 — Closing the list view collapses to non-list state.
    func testJourney_ListViewCloseCollapses() {
        let rig = CoordinatorJourneyRig.make()
        triggerWake(rig)

        rig.socket.handlers.onListViewUpdate(
            ListViewUpdateMessage(
                seq: 1,
                view: ListView(
                    title: "Список",
                    items: [ListItem(id: "a", label: "молоко", done: false)],
                    open: true
                )
            )
        )
        XCTAssertTrue(rig.vm.viewOpen)

        rig.socket.handlers.onListViewUpdate(
            ListViewUpdateMessage(
                seq: 2,
                view: ListView(title: nil, items: [], open: false)
            )
        )
        XCTAssertFalse(rig.vm.viewOpen)
        XCTAssertEqual(rig.vm.viewItems, [])
    }

    // 2.9 — Mid-thinking disconnect. SessionCoordinator's onStatusChange
    // pushes `.error("Core unreachable")` AND calls overlay.hideOverlay(),
    // which through the journey controller calls vm.hide().
    func testJourney_DisconnectMidThinking() {
        let rig = CoordinatorJourneyRig.make()
        triggerWake(rig)

        rig.socket.handlers.onOverlayUpdate(
            OverlayUpdateMessage(seq: 1, state: OverlayState(kind: .thinking, sound: .ackThinking))
        )
        XCTAssertEqual(rig.vm.kind, .thinking)
        XCTAssertTrue(rig.vm.visible)

        rig.socket.onStatusChange?(false)
        rig.coordinator.waitForPendingWork()

        XCTAssertFalse(rig.vm.visible, "disconnect hides overlay")
        XCTAssertEqual(rig.vm.kind, .idle, "vm.hide() resets kind to idle")
        let isError: (ListeningState) -> Bool = { state in
            if case .error = state { return true } else { return false }
        }
        XCTAssertTrue(rig.status.states.contains(where: isError), "disconnect surfaces an error status")
    }

    // 2.10 — sttError session end surfaces an error status carrying the
    // server-supplied detail.
    func testJourney_SttErrorEndsWithErrorOverlay() {
        let rig = CoordinatorJourneyRig.make()
        triggerWake(rig)
        let sid = rig.socket.emittedSessionStartMessages().first!.sessionId

        rig.socket.handlers.onOverlayUpdate(
            OverlayUpdateMessage(seq: 1, state: OverlayState(kind: .error, hint: "STT упал", sound: .error))
        )
        XCTAssertEqual(rig.vm.kind, .error)
        XCTAssertTrue(rig.cues.played.contains(.error))

        rig.socket.handlers.onSessionEnd(
            CoreSessionEndMessage(sessionId: sid, reason: .sttError, detail: "deepgram dropped")
        )
        rig.coordinator.waitForPendingWork()

        XCTAssertFalse(rig.coordinator.hasActiveSession)
        let hasError = rig.status.states.contains(where: { state in
            if case .error(let msg) = state, msg.contains("deepgram dropped") { return true } else { return false }
        })
        XCTAssertTrue(hasError, "status surfaces error with server-supplied detail")
    }

    // 2.11 — Stale overlay seq is dropped without affecting the running view-model.
    func testJourney_StaleOverlaySeqDuringJourney() {
        let rig = CoordinatorJourneyRig.make()
        triggerWake(rig)

        rig.socket.handlers.onOverlayUpdate(
            OverlayUpdateMessage(seq: 5, state: OverlayState(kind: .thinking, hint: "Думаю"))
        )
        XCTAssertEqual(rig.vm.kind, .thinking)
        XCTAssertEqual(rig.vm.hint, "Думаю")

        rig.socket.handlers.onOverlayUpdate(
            OverlayUpdateMessage(seq: 3, state: OverlayState(kind: .error, hint: "wrong"))
        )
        XCTAssertEqual(rig.vm.kind, .thinking, "stale seq dropped, vm.kind unchanged")
        XCTAssertEqual(rig.vm.hint, "Думаю", "stale seq dropped, vm.hint unchanged")

        rig.socket.handlers.onOverlayUpdate(
            OverlayUpdateMessage(seq: 6, state: OverlayState(kind: .success))
        )
        XCTAssertEqual(rig.vm.kind, .success, "forward seq accepted")
    }
}
