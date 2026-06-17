import Foundation

// Streaming VAD: feed PCM (int16, 48 kHz mono) and the detector reports back
// whether the trailing audio looks like silence for long enough to end the
// utterance. The detector requires the user to actually speak first (so we
// don't terminate a session before they've started). Once speech has been
// observed, sustained silence over `endSilenceMs` triggers the endpoint.

final class SilenceDetector {
    struct Config {
        var sampleRate: Double = 48_000
        var speechRmsThreshold: Double = 600         // ~ -35 dBFS
        var silenceRmsThreshold: Double = 350        // ~ -39 dBFS
        var endSilenceMs: Int = 1_200
        var minPreSpeechMs: Int = 300
        var graceMs: Int = 500
    }

    private let config: Config
    private var sawSpeech = false
    private var silenceStartedAt: Date?
    private let startedAt = Date()

    init(config: Config = Config()) {
        self.config = config
    }

    enum Decision {
        case waiting
        case ongoing
        case endpoint
    }

    func feed(pcm: Data) -> Decision {
        guard Date().timeIntervalSince(startedAt) * 1000 >= Double(config.graceMs) else {
            return .waiting
        }
        let rms = Self.computeRms(pcm)
        if rms >= config.speechRmsThreshold {
            sawSpeech = true
            silenceStartedAt = nil
            return .ongoing
        }
        if !sawSpeech {
            return .waiting
        }
        if rms <= config.silenceRmsThreshold {
            if silenceStartedAt == nil {
                silenceStartedAt = Date()
            }
            if let started = silenceStartedAt,
               Date().timeIntervalSince(started) * 1000 >= Double(config.endSilenceMs) {
                return .endpoint
            }
        } else {
            silenceStartedAt = nil
        }
        return .ongoing
    }

    private static func computeRms(_ pcm: Data) -> Double {
        let count = pcm.count / MemoryLayout<Int16>.size
        guard count > 0 else { return 0 }
        var sumSquares: Double = 0
        pcm.withUnsafeBytes { raw in
            let buf = raw.bindMemory(to: Int16.self)
            for s in buf {
                let f = Double(s)
                sumSquares += f * f
            }
        }
        return sqrt(sumSquares / Double(count))
    }
}
