import XCTest
import EarProtocol
@testable import EarCore

// Phase 0 characterization: locks the visible side-effects of every
// SessionCoordinator entry path so the upcoming extraction into
// `packages/ear-core/swift/` is provably loss-less.
final class SessionCoordinatorTests: XCTestCase {

    // Helper that drives one wake → expects session_start emitted, listening
    // status pushed, wake cue played, and an active session in the coordinator.
    private func triggerWake(_ rig: CoordinatorTestRig, score: Float = 0.9) {
        rig.wake.trigger(score: score)
        rig.coordinator.waitForPendingWork()
    }

    func testStartWiresUpDependencies() {
        let rig = CoordinatorTestRig.make()
        XCTAssertEqual(rig.audio.startCount, 1, "audio.start() must be called once")
        XCTAssertEqual(rig.wake.startCount, 1, "wake.start() must be called once")
        XCTAssertEqual(rig.socket.connectCount, 1, "socket.connect() must be called once")
        XCTAssertEqual(rig.audio.sinks.count, 1, "audio sink must be attached")
        XCTAssertEqual(rig.status.states.last, .idle, "initial status must be .idle")
    }

    func testWakeStartsSession() {
        let rig = CoordinatorTestRig.make()
        triggerWake(rig)

        XCTAssertTrue(rig.coordinator.hasActiveSession)

        let starts = rig.socket.emittedSessionStartMessages()
        XCTAssertEqual(starts.count, 1)
        XCTAssertEqual(starts[0].deviceId, "device-test")
        XCTAssertEqual(starts[0].codec, .linear16)
        XCTAssertEqual(starts[0].mode, .regular)
        XCTAssertNil(starts[0].userId)

        let wakes = rig.socket.emittedWakeDetectedMessages()
        XCTAssertEqual(wakes.count, 1)
        XCTAssertEqual(wakes[0].deviceId, "device-test")

        XCTAssertTrue(rig.cues.played.contains(.wake), "wake cue must play")
        XCTAssertTrue(rig.status.states.contains(.listening), "must transition through .listening")
        XCTAssertTrue(rig.status.states.contains(.streaming), "must end on .streaming")
    }

    func testWakeWhileSessionActiveIsIgnored() {
        let rig = CoordinatorTestRig.make()
        triggerWake(rig)
        let firstSessionCount = rig.socket.emittedSessionStartMessages().count

        triggerWake(rig)
        XCTAssertEqual(rig.socket.emittedSessionStartMessages().count, firstSessionCount,
                       "Second wake during active session must not open a new session")
    }

    func testPausedWakeIsIgnored() {
        let rig = CoordinatorTestRig.make()
        rig.coordinator.setPaused(true)
        rig.coordinator.waitForPendingWork()
        triggerWake(rig)
        XCTAssertFalse(rig.coordinator.hasActiveSession)
        XCTAssertEqual(rig.socket.emittedSessionStartMessages().count, 0)
    }

    func testSetPausedDuringActiveSessionEmitsSessionEnd() {
        let rig = CoordinatorTestRig.make()
        triggerWake(rig)

        let hideBefore = rig.overlay.hideCount
        rig.coordinator.setPaused(true)
        rig.coordinator.waitForPendingWork()

        XCTAssertFalse(rig.coordinator.hasActiveSession)
        let ends = rig.socket.emittedSessionEndMessages()
        XCTAssertEqual(ends.count, 1)
        XCTAssertEqual(ends[0].reason, .user)
        XCTAssertEqual(rig.overlay.hideCount, hideBefore + 1, "setPaused must trigger exactly one hide on top of any prior")
    }

    func testStopActiveSessionEmitsUserEnd() {
        let rig = CoordinatorTestRig.make()
        triggerWake(rig)

        rig.coordinator.stopActiveSession()
        rig.coordinator.waitForPendingWork()

        XCTAssertFalse(rig.coordinator.hasActiveSession)
        let ends = rig.socket.emittedSessionEndMessages()
        XCTAssertEqual(ends.count, 1)
        XCTAssertEqual(ends[0].reason, .user)
    }

    func testSimulateWakeOpensSession() {
        let rig = CoordinatorTestRig.make()
        rig.coordinator.simulateWake()
        rig.coordinator.waitForPendingWork()
        XCTAssertTrue(rig.coordinator.hasActiveSession)
        XCTAssertEqual(rig.socket.emittedSessionStartMessages().count, 1)
    }

    func testArmCaptureContinuousPlaysAckContinue() {
        let rig = CoordinatorTestRig.make()
        rig.socket.handlers.onArmCapture(ArmCaptureMessage(mode: .continuous))
        rig.coordinator.waitForPendingWork()

        let starts = rig.socket.emittedSessionStartMessages()
        XCTAssertEqual(starts.count, 1)
        XCTAssertEqual(starts[0].mode, .continuous)
        XCTAssertTrue(rig.cues.played.contains(.ackContinue), "continuous mode plays ack_continue")
    }

    func testArmCaptureAskPlaysCueListenWithDefaultCap() {
        let rig = CoordinatorTestRig.make()
        rig.socket.handlers.onArmCapture(ArmCaptureMessage(mode: .ask))
        rig.coordinator.waitForPendingWork()

        let starts = rig.socket.emittedSessionStartMessages()
        XCTAssertEqual(starts.count, 1)
        XCTAssertEqual(starts[0].mode, .ask)
        XCTAssertTrue(rig.cues.played.contains(.cueListen))
    }

    func testArmCaptureImmersivePlaysAckContinue() {
        let rig = CoordinatorTestRig.make()
        rig.socket.handlers.onArmCapture(ArmCaptureMessage(mode: .immersive))
        rig.coordinator.waitForPendingWork()

        let starts = rig.socket.emittedSessionStartMessages()
        XCTAssertEqual(starts.count, 1)
        XCTAssertEqual(starts[0].mode, .immersive)
        XCTAssertTrue(rig.cues.played.contains(.ackContinue))
    }

    func testArmCaptureWhileActiveIsIgnored() {
        let rig = CoordinatorTestRig.make()
        triggerWake(rig)
        let before = rig.socket.emittedSessionStartMessages().count

        rig.socket.handlers.onArmCapture(ArmCaptureMessage(mode: .continuous))
        rig.coordinator.waitForPendingWork()
        XCTAssertEqual(rig.socket.emittedSessionStartMessages().count, before,
                       "arm_capture must be ignored while a session is already active")
    }

    func testCoreSessionEndWithEndpointClearsActive() {
        let rig = CoordinatorTestRig.make()
        triggerWake(rig)
        guard let sid = rig.socket.emittedSessionStartMessages().first?.sessionId else {
            return XCTFail("no session_start emitted")
        }
        rig.socket.handlers.onSessionEnd(CoreSessionEndMessage(sessionId: sid, reason: .endpoint, detail: nil))
        rig.coordinator.waitForPendingWork()
        XCTAssertFalse(rig.coordinator.hasActiveSession)
        XCTAssertTrue(rig.status.states.contains(.idle))
    }

    func testCoreSessionEndWithSttErrorTransitionsToErrorStatus() {
        let rig = CoordinatorTestRig.make()
        triggerWake(rig)
        guard let sid = rig.socket.emittedSessionStartMessages().first?.sessionId else {
            return XCTFail("no session_start emitted")
        }
        rig.socket.handlers.onSessionEnd(CoreSessionEndMessage(sessionId: sid, reason: .sttError, detail: "deepgram"))
        rig.coordinator.waitForPendingWork()
        let lastError = rig.status.states.reversed().first { state in
            if case .error = state { return true } else { return false }
        }
        XCTAssertNotNil(lastError, "stt_error must surface as a .error status")
    }

    func testCoreSessionEndForUnknownSessionIgnored() {
        let rig = CoordinatorTestRig.make()
        triggerWake(rig)
        let before = rig.coordinator.hasActiveSession
        rig.socket.handlers.onSessionEnd(CoreSessionEndMessage(sessionId: "unknown", reason: .endpoint, detail: nil))
        rig.coordinator.waitForPendingWork()
        XCTAssertEqual(rig.coordinator.hasActiveSession, before)
    }

    func testWakeAckYieldEndsActiveSession() {
        let rig = CoordinatorTestRig.make()
        triggerWake(rig)
        rig.socket.handlers.onWakeAck(WakeAckMessage(action: .yield))
        rig.coordinator.waitForPendingWork()
        XCTAssertFalse(rig.coordinator.hasActiveSession)
        let ends = rig.socket.emittedSessionEndMessages()
        XCTAssertEqual(ends.count, 1)
        XCTAssertEqual(ends[0].reason, .user)
    }

    func testApplyOverlayUpdateForwardsToOverlayAndPlaysSound() {
        let rig = CoordinatorTestRig.make()
        let msg = OverlayUpdateMessage(
            seq: 1,
            state: OverlayState(kind: .thinking, hint: "h", caption: "c", sound: .ackThinking)
        )
        rig.socket.handlers.onOverlayUpdate(msg)
        rig.coordinator.waitForPendingWork()

        XCTAssertEqual(rig.overlay.overlayUpdates.count, 1)
        XCTAssertEqual(rig.overlay.overlayUpdates[0].state.kind, .thinking)
        XCTAssertTrue(rig.cues.played.contains(.ackThinking))
    }

    func testApplyListViewUpdateForwardsToOverlay() {
        let rig = CoordinatorTestRig.make()
        let msg = ListViewUpdateMessage(
            seq: 1,
            view: ListView(title: "Список", items: [
                ListItem(id: "a", label: "молоко", done: false),
            ], open: true)
        )
        rig.socket.handlers.onListViewUpdate(msg)
        rig.coordinator.waitForPendingWork()
        XCTAssertEqual(rig.overlay.listViewUpdates.count, 1)
        XCTAssertEqual(rig.overlay.listViewUpdates[0].view.items.first?.label, "молоко")
    }

    func testSocketDisconnectResetsOverlay() {
        let rig = CoordinatorTestRig.make()
        // Reset hide counter (start() does not call hideOverlay)
        let before = rig.overlay.hideCount
        rig.socket.onStatusChange?(false)
        XCTAssertEqual(rig.overlay.hideCount, before + 1)
        XCTAssertTrue(rig.status.states.contains(where: { state in
            if case .error = state { return true } else { return false }
        }))
    }

    func testShutdownClosesSocketAndHidesOverlay() {
        let rig = CoordinatorTestRig.make()
        triggerWake(rig)

        rig.coordinator.shutdown()

        // shutdown emits session_end synchronously for the active session
        let ends = rig.socket.emittedSessionEndMessages()
        XCTAssertEqual(ends.count, 1)
        XCTAssertEqual(ends[0].reason, .user)
        XCTAssertEqual(rig.wake.stopCount, 1)
        XCTAssertEqual(rig.audio.stopCount, 1)
        XCTAssertEqual(rig.socket.disconnectCount, 1)
        XCTAssertGreaterThanOrEqual(rig.overlay.hideCount, 1)
    }

    func testOnSessionStateChangeFiresTrueOnWakeFalseOnCoreEnd() {
        let rig = CoordinatorTestRig.make()
        var calls: [Bool] = []
        rig.coordinator.onSessionStateChange = { calls.append($0) }
        triggerWake(rig)
        guard let sid = rig.socket.emittedSessionStartMessages().first?.sessionId else {
            return XCTFail("no session_start emitted")
        }
        rig.socket.handlers.onSessionEnd(CoreSessionEndMessage(sessionId: sid, reason: .endpoint, detail: nil))
        rig.coordinator.waitForPendingWork()
        XCTAssertEqual(calls, [true, false])
    }

    func testAudioFramesAreForwardedWhileSessionActive() {
        let rig = CoordinatorTestRig.make()
        triggerWake(rig)
        guard let sid = rig.socket.emittedSessionStartMessages().first?.sessionId else {
            return XCTFail("no session_start emitted")
        }
        let pcm = Data(repeating: 0x01, count: 1024)
        rig.audio.emitFrames(pcm)
        rig.coordinator.waitForPendingWork()
        let audioForThisSession = rig.socket.emittedAudio.filter { $0.sessionId == sid }
        XCTAssertGreaterThan(audioForThisSession.count, 0)
    }

    func testAudioFramesDroppedWhenNoActiveSession() {
        let rig = CoordinatorTestRig.make()
        let pcm = Data(repeating: 0x01, count: 1024)
        rig.audio.emitFrames(pcm)
        rig.coordinator.waitForPendingWork()
        XCTAssertEqual(rig.socket.emittedAudio.count, 0, "no session_id → no audio_frame upload")
    }
}
