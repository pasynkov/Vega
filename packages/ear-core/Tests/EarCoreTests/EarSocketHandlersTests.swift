import XCTest
import EarProtocol
@testable import EarCore

// `EarSocket` itself owns a concrete SocketManager that talks to a real
// socket.io server, so it cannot be exercised here without standing up
// the server or refactoring out a transport protocol. SessionCoordinator
// tests cover the real integration surface via a mocked `EarSocketing`.
// What we lock down here is the small handlers struct that connects the
// two — defaults are no-ops, every slot is overrideable, and overriding
// one slot does not perturb the others.
final class EarSocketHandlersTests: XCTestCase {

    func testHandlersDefaultsAreNoops() {
        let h = EarSocketHandlers()
        // Must not crash on default callbacks.
        h.onAck(AckMessage(deviceId: "d"))
        h.onWakeAck(WakeAckMessage(action: .proceed))
        h.onPartialTranscript(PartialTranscriptMessage(sessionId: "s", text: "t"))
        h.onFinalTranscript(FinalTranscriptMessage(sessionId: "s", text: "t"))
        h.onOverlayUpdate(OverlayUpdateMessage(seq: 1, state: OverlayState(kind: .listening)))
        h.onListViewUpdate(ListViewUpdateMessage(seq: 1, view: ListView(items: [], open: true)))
        h.onArmCapture(ArmCaptureMessage(mode: .regular))
        h.onSessionMode(SessionModeChangeMessage(sessionId: "s", mode: .continuous))
        h.onSessionEnd(CoreSessionEndMessage(sessionId: "s", reason: .endpoint, detail: nil))
        h.onException("boom")
    }

    func testEachSlotCanBeOverriddenIndependently() {
        var h = EarSocketHandlers()
        var acks: [AckMessage] = []
        var ends: [CoreSessionEndMessage] = []
        h.onAck = { acks.append($0) }
        h.onSessionEnd = { ends.append($0) }

        h.onAck(AckMessage(deviceId: "d1"))
        h.onWakeAck(WakeAckMessage(action: .yield))  // default still no-op
        h.onSessionEnd(CoreSessionEndMessage(sessionId: "s1", reason: .timeout, detail: "t"))

        XCTAssertEqual(acks.count, 1)
        XCTAssertEqual(acks[0].deviceId, "d1")
        XCTAssertEqual(ends.count, 1)
        XCTAssertEqual(ends[0].reason, .timeout)
    }
}
