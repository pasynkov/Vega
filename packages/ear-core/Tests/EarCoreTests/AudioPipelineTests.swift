import XCTest
@testable import EarCore

// Phase 0 characterization for the headless pieces of the audio
// pipeline. The platform AudioCapturing implementation (AUHAL on macOS,
// AVAudioEngine on iOS) is hardware-bound and verified only via end-to-end
// runs against Core; here we lock down the encoder that sits between
// platform capture and the wire.
final class AudioPipelineTests: XCTestCase {

    func testPcmPassthroughEncoderReturnsSinglePacket() throws {
        let encoder = PcmPassthroughEncoder()
        let payload = Data(repeating: 0x42, count: 2048)
        let frames = try encoder.encode(payload)
        XCTAssertEqual(frames.count, 1)
        XCTAssertEqual(frames[0], payload, "Passthrough must hand back the original bytes")
    }

    func testPcmPassthroughEncoderFlushIsEmpty() throws {
        let encoder = PcmPassthroughEncoder()
        XCTAssertEqual(try encoder.flush().count, 0)
    }

    func testPcmPassthroughEncoderEmptyInputReturnsEmptyPacket() throws {
        let encoder = PcmPassthroughEncoder()
        let frames = try encoder.encode(Data())
        XCTAssertEqual(frames.count, 1)
        XCTAssertEqual(frames[0].count, 0)
    }
}
