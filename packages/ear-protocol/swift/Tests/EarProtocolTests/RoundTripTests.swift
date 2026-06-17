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

    // Compare two JSON values structurally (ignores key order).
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

    private func roundTripEarToCore(_ key: String) throws {
        let data = try fixtureData(key)
        let decoded = try EarProtocol.decodeEarToCore(data)
        let reencoded = try decoded.encode()
        let original = try JSONSerialization.jsonObject(with: data)
        let after = try JSONSerialization.jsonObject(with: reencoded)
        XCTAssertTrue(equalJSON(original, after), "round-trip mismatch for \(key)")
    }

    private func roundTripCoreToEar(_ key: String) throws {
        let data = try fixtureData(key)
        let decoded = try EarProtocol.decodeCoreToEar(data)
        let reencoded: Data
        let encoder = EarProtocol.encoder
        switch decoded {
        case .ack(let m): reencoded = try encoder.encode(m)
        case .wakeAck(let m): reencoded = try encoder.encode(m)
        case .partialTranscript(let m): reencoded = try encoder.encode(m)
        case .finalTranscript(let m): reencoded = try encoder.encode(m)
        case .playCue(let m): reencoded = try encoder.encode(m)
        case .sessionMode(let m): reencoded = try encoder.encode(m)
        case .sessionEnd(let m): reencoded = try encoder.encode(m)
        case .unknownCue, .unknownSessionMode:
            // Tolerance branches — the underlying fixture should never trip these
            // because every fixture-listed value is known to the binary.
            XCTFail("Round-trip fixture decoded as unknown tolerance branch for \(key)")
            return
        }
        let original = try JSONSerialization.jsonObject(with: data)
        let after = try JSONSerialization.jsonObject(with: reencoded)
        XCTAssertTrue(equalJSON(original, after), "round-trip mismatch for \(key)")
    }

    func testRegister() throws { try roundTripEarToCore("register") }
    func testWakeDetected() throws { try roundTripEarToCore("wake_detected") }
    func testSessionStart() throws { try roundTripEarToCore("session_start") }
    func testEarSessionEnd() throws { try roundTripEarToCore("ear_session_end") }

    func testAck() throws { try roundTripCoreToEar("ack") }
    func testWakeAckProceed() throws { try roundTripCoreToEar("wake_ack") }
    func testWakeAckYield() throws { try roundTripCoreToEar("wake_ack_yield") }
    func testPartial() throws { try roundTripCoreToEar("partial_transcript") }
    func testFinal() throws { try roundTripCoreToEar("final_transcript") }
    func testCueWake() throws { try roundTripCoreToEar("play_cue_wake") }
    func testCueEndpoint() throws { try roundTripCoreToEar("play_cue_endpoint") }
    func testCueError() throws { try roundTripCoreToEar("play_cue_error") }
    func testCoreSessionEnd() throws { try roundTripCoreToEar("core_session_end") }
    func testCoreSessionEndWithDetail() throws { try roundTripCoreToEar("core_session_end_with_detail") }

    func testAudioFrameHeaderRoundTrip() {
        let sessionId = "22222222-2222-4222-8222-222222222222"
        let payload = Data([1, 2, 3, 4, 5])
        let wire = AudioFrame.encode(sessionId: sessionId, payload: payload)
        let decoded = try? AudioFrame.decode(wire)
        XCTAssertNotNil(decoded)
        XCTAssertEqual(decoded?.payload, payload)
        XCTAssertEqual(decoded?.sessionShortId, AudioFrame.sessionShortId(fromUuid: sessionId))
    }
}
