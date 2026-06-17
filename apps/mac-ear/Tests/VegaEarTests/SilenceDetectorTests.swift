import XCTest
@testable import VegaEar

final class SilenceDetectorTests: XCTestCase {
    // Generate a synthetic PCM buffer of given RMS by emitting a square wave
    // with amplitude approximately equal to the requested RMS.
    private func makePcm(samples: Int, amplitude: Int16) -> Data {
        var buf = [Int16]()
        buf.reserveCapacity(samples)
        for i in 0..<samples {
            buf.append(i % 2 == 0 ? amplitude : -amplitude)
        }
        return buf.withUnsafeBufferPointer { Data(buffer: $0) }
    }

    func testEndpointSuppressedInLongNoteMode() {
        var cfg = SilenceDetector.Config()
        cfg.calibrationMs = 1
        cfg.graceMs = 1
        cfg.endSilenceMs = 1
        cfg.fallbackNoiseFloor = 100
        cfg.speechMargin = 200
        cfg.silenceMargin = 50

        let det = SilenceDetector(config: cfg)

        // First feed: triggers calibration; samples are essentially silent.
        let calib = makePcm(samples: 200, amplitude: 0)
        let loud = makePcm(samples: 200, amplitude: 4_000)
        let quiet = makePcm(samples: 200, amplitude: 30)

        _ = det.feed(pcm: calib)
        Thread.sleep(forTimeInterval: 0.005)
        // After calibration window: feed loud → triggers speech.
        _ = det.feed(pcm: loud)
        _ = det.feed(pcm: loud)

        // Suppress endpoint, then feed prolonged silence.
        det.setEndpointSuppressed(true)
        Thread.sleep(forTimeInterval: 0.005)
        var suppressedDecision: SilenceDetector.Decision = .ongoing
        for _ in 0..<30 {
            suppressedDecision = det.feed(pcm: quiet)
            Thread.sleep(forTimeInterval: 0.001)
        }
        XCTAssertNotEqual(suppressedDecision, .endpoint, "Long-note mode must not fire endpoint")

        // Un-suppress and confirm endpoint can fire.
        det.setEndpointSuppressed(false)
        var endpointSeen = false
        for _ in 0..<30 {
            let d = det.feed(pcm: quiet)
            if d == .endpoint {
                endpointSeen = true
                break
            }
            Thread.sleep(forTimeInterval: 0.001)
        }
        XCTAssertTrue(endpointSeen, "Endpoint should fire once suppression is lifted")
    }
}
