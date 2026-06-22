import XCTest
@testable import EarCore

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

    private func fastConfig() -> SilenceDetector.Config {
        var cfg = SilenceDetector.Config()
        cfg.calibrationMs = 1
        cfg.graceMs = 1
        cfg.endSilenceMs = 1
        cfg.fallbackNoiseFloor = 100
        cfg.speechMargin = 200
        cfg.silenceMargin = 50
        return cfg
    }

    func testEndpointSuppressedInLongNoteMode() {
        let det = SilenceDetector(config: fastConfig())

        let calib = makePcm(samples: 200, amplitude: 0)
        let loud = makePcm(samples: 200, amplitude: 4_000)
        let quiet = makePcm(samples: 200, amplitude: 30)

        _ = det.feed(pcm: calib)
        Thread.sleep(forTimeInterval: 0.005)
        _ = det.feed(pcm: loud)
        _ = det.feed(pcm: loud)

        det.setEndpointSuppressed(true)
        Thread.sleep(forTimeInterval: 0.005)
        var suppressedDecision: SilenceDetector.Decision = .ongoing
        for _ in 0..<30 {
            suppressedDecision = det.feed(pcm: quiet)
            Thread.sleep(forTimeInterval: 0.001)
        }
        XCTAssertNotEqual(suppressedDecision, .endpoint, "Long-note mode must not fire endpoint")

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

    func testCalibrationWindowReturnsWaiting() {
        var cfg = SilenceDetector.Config()
        cfg.calibrationMs = 200
        cfg.graceMs = 1
        cfg.endSilenceMs = 1
        let det = SilenceDetector(config: cfg)
        let chunk = makePcm(samples: 200, amplitude: 0)
        XCTAssertEqual(det.feed(pcm: chunk), .waiting)
    }

    func testEndpointFiresAfterSpeechThenSilence() {
        let det = SilenceDetector(config: fastConfig())
        let calib = makePcm(samples: 200, amplitude: 0)
        let loud = makePcm(samples: 200, amplitude: 4_000)
        let quiet = makePcm(samples: 200, amplitude: 30)

        _ = det.feed(pcm: calib)
        Thread.sleep(forTimeInterval: 0.005)
        var sawSpeech = false
        for _ in 0..<5 {
            if det.feed(pcm: loud) == .ongoing {
                sawSpeech = true
                break
            }
        }
        XCTAssertTrue(sawSpeech, "loud frames after calibration should report .ongoing")

        var endpointSeen = false
        for _ in 0..<60 {
            if det.feed(pcm: quiet) == .endpoint {
                endpointSeen = true
                break
            }
            Thread.sleep(forTimeInterval: 0.001)
        }
        XCTAssertTrue(endpointSeen, "endpoint should fire after sustained silence")
    }

    func testEndpointNeverFiresWithoutPriorSpeech() {
        var cfg = fastConfig()
        cfg.endSilenceMs = 5
        let det = SilenceDetector(config: cfg)
        let calib = makePcm(samples: 200, amplitude: 0)
        let quiet = makePcm(samples: 200, amplitude: 30)

        _ = det.feed(pcm: calib)
        Thread.sleep(forTimeInterval: 0.005)
        for _ in 0..<30 {
            let d = det.feed(pcm: quiet)
            XCTAssertNotEqual(d, .endpoint, "endpoint must not fire before any speech is observed")
            Thread.sleep(forTimeInterval: 0.001)
        }
    }

    func testEmptyPcmYieldsZeroRms() {
        let det = SilenceDetector(config: fastConfig())
        let empty = Data()
        // Should not crash, classifies as either waiting or pre-speech.
        let d = det.feed(pcm: empty)
        XCTAssertNotEqual(d, .endpoint)
    }
}
