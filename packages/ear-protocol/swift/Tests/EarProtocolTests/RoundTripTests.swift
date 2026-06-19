import XCTest
@testable import EarProtocol

final class RoundTripTests: XCTestCase {
    private var fixtures: [String: Any] = [:]

    override func setUpWithError() throws {
        guard let url = Bundle.module.url(forResource: "examples", withExtension: "json") else {
            XCTFail("missing fixtures bundle")
            return
        }
        let data = try Data(contentsOf: url)
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            XCTFail("fixtures not a JSON object")
            return
        }
        fixtures = json
    }

    private func equalJSON(_ a: Any, _ b: Any) -> Bool {
        let dataA = try? JSONSerialization.data(withJSONObject: a, options: [.sortedKeys])
        let dataB = try? JSONSerialization.data(withJSONObject: b, options: [.sortedKeys])
        guard let a = dataA, let b = dataB else { return false }
        return a == b
    }

    private func fixtureData(_ key: String) throws -> Data {
        guard let value = fixtures[key] else {
            XCTFail("missing fixture: \(key)")
            return Data()
        }
        return try JSONSerialization.data(withJSONObject: value)
    }

    private func roundTrip<T: Codable & Equatable>(_ type: T.Type, key: String) throws {
        let data = try fixtureData(key)
        let decoded = try EarProtocol.decoder.decode(T.self, from: data)
        let reencoded = try EarProtocol.encoder.encode(decoded)
        let original = try JSONSerialization.jsonObject(with: data)
        let after = try JSONSerialization.jsonObject(with: reencoded)
        XCTAssertTrue(equalJSON(original, after), "round-trip mismatch for \(key)")
    }

    func testRegister() throws { try roundTrip(RegisterMessage.self, key: "register") }
    func testWakeDetected() throws { try roundTrip(WakeDetectedMessage.self, key: "wake_detected") }
    func testSessionStart() throws { try roundTrip(SessionStartMessage.self, key: "session_start") }
    func testEarSessionEnd() throws { try roundTrip(EarSessionEndMessage.self, key: "ear_session_end") }
    func testAck() throws { try roundTrip(AckMessage.self, key: "ack") }
    func testWakeAckProceed() throws { try roundTrip(WakeAckMessage.self, key: "wake_ack") }
    func testWakeAckYield() throws { try roundTrip(WakeAckMessage.self, key: "wake_ack_yield") }
    func testPartial() throws { try roundTrip(PartialTranscriptMessage.self, key: "partial_transcript") }
    func testFinal() throws { try roundTrip(FinalTranscriptMessage.self, key: "final_transcript") }
    func testOverlayListening() throws { try roundTrip(OverlayUpdateMessage.self, key: "overlay_update_listening") }
    func testOverlayCapturing() throws { try roundTrip(OverlayUpdateMessage.self, key: "overlay_update_capturing") }
    func testOverlayThinking() throws { try roundTrip(OverlayUpdateMessage.self, key: "overlay_update_thinking") }
    func testOverlayProcessing() throws { try roundTrip(OverlayUpdateMessage.self, key: "overlay_update_processing") }
    func testOverlaySuccess() throws { try roundTrip(OverlayUpdateMessage.self, key: "overlay_update_success") }
    func testOverlayError() throws { try roundTrip(OverlayUpdateMessage.self, key: "overlay_update_error") }
    func testOverlayIdle() throws { try roundTrip(OverlayUpdateMessage.self, key: "overlay_update_idle") }
    func testOverlayView() throws { try roundTrip(OverlayUpdateMessage.self, key: "overlay_update_view") }
    func testListViewOpen() throws { try roundTrip(ListViewUpdateMessage.self, key: "list_view_update_open") }
    func testListViewEmpty() throws { try roundTrip(ListViewUpdateMessage.self, key: "list_view_update_empty") }
    func testListViewClose() throws { try roundTrip(ListViewUpdateMessage.self, key: "list_view_update_close") }
    func testCoreSessionEnd() throws { try roundTrip(CoreSessionEndMessage.self, key: "core_session_end") }
    func testCoreSessionEndWithDetail() throws { try roundTrip(CoreSessionEndMessage.self, key: "core_session_end_with_detail") }
    func testSessionModeContinuous() throws { try roundTrip(SessionModeChangeMessage.self, key: "session_mode_continuous") }
    func testArmCaptureContinuous() throws { try roundTrip(ArmCaptureMessage.self, key: "arm_capture_continuous") }
    func testArmCaptureAsk() throws { try roundTrip(ArmCaptureMessage.self, key: "arm_capture_ask") }
    func testOverlayListeningAsk() throws { try roundTrip(OverlayUpdateMessage.self, key: "overlay_update_listening_ask") }
    func testSessionStartAsk() throws { try roundTrip(SessionStartMessage.self, key: "session_start_ask") }
    func testSessionStartImmersive() throws { try roundTrip(SessionStartMessage.self, key: "session_start_immersive") }
    func testArmCaptureImmersive() throws { try roundTrip(ArmCaptureMessage.self, key: "arm_capture_immersive") }
    func testSessionModeImmersive() throws { try roundTrip(SessionModeChangeMessage.self, key: "session_mode_immersive") }
    func testOverlayImmersive() throws { try roundTrip(OverlayUpdateMessage.self, key: "overlay_update_immersive") }

    func testEventNames() {
        XCTAssertEqual(EventName.register, "register")
        XCTAssertEqual(EventName.overlayUpdate, "overlay_update")
        XCTAssertEqual(EventName.listViewUpdate, "list_view_update")
        XCTAssertEqual(EventName.audioFrame, "audio_frame")
    }
}
