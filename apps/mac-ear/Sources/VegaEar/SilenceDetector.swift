import Foundation

// Streaming VAD with auto-calibrated noise floor. The first
// `calibrationMs` of each session are used to estimate the ambient RMS
// (75th percentile so a single keypress click doesn't poison the floor).
// After that, speech is detected when RMS rises `speechMargin` above the
// floor, and silence is declared when it drops within `silenceMargin` of
// the floor. Endpoint fires after `endSilenceMs` of sustained silence
// following observed speech.

final class SilenceDetector {
    struct Config {
        var endSilenceMs: Int = 3_000
        var graceMs: Int = 500
        var calibrationMs: Int = 600
        var speechMargin: Double = 300
        var silenceMargin: Double = 100
        var fallbackNoiseFloor: Double = 100
    }

    private let config: Config
    private var sawSpeech = false
    private var silenceStartedAt: Date?
    private let startedAt = Date()
    private var noiseFloorRms: Double = 0
    private var calibrationSamples: [Double] = []
    private var lastLoggedState: String = ""
    // When suppressEndpoint is true, the detector keeps computing RMS for
    // logging but never returns .endpoint. Used by long-note mode.
    private var suppressEndpoint = false

    func setEndpointSuppressed(_ suppressed: Bool) {
        if suppressEndpoint != suppressed {
            NSLog("[VegaEar] VAD endpoint suppression \(suppressed ? "ON" : "OFF")")
        }
        suppressEndpoint = suppressed
    }

    init(config: Config = Config()) {
        self.config = config
    }

    enum Decision {
        case waiting
        case ongoing
        case endpoint
    }

    func feed(pcm: Data) -> Decision {
        let nowMs = Date().timeIntervalSince(startedAt) * 1000
        let rms = Self.computeRms(pcm)

        if nowMs < Double(config.calibrationMs) {
            calibrationSamples.append(rms)
            return .waiting
        }
        if noiseFloorRms == 0 {
            if calibrationSamples.isEmpty {
                noiseFloorRms = config.fallbackNoiseFloor
            } else {
                let sorted = calibrationSamples.sorted()
                let idx = max(0, min(sorted.count - 1, Int(Double(sorted.count) * 0.75)))
                noiseFloorRms = max(config.fallbackNoiseFloor, sorted[idx])
            }
            NSLog(String(
                format: "[VegaEar] VAD calibrated: noiseFloor=%.0f speechThr=%.0f silenceThr=%.0f",
                noiseFloorRms,
                noiseFloorRms + config.speechMargin,
                noiseFloorRms + config.silenceMargin
            ))
        }

        if nowMs < Double(config.graceMs) {
            return .waiting
        }

        let speechThresh = noiseFloorRms + config.speechMargin
        let silenceThresh = noiseFloorRms + config.silenceMargin

        if rms >= speechThresh {
            if !sawSpeech {
                NSLog(String(format: "[VegaEar] VAD speech detected, RMS=%.0f threshold=%.0f", rms, speechThresh))
            }
            sawSpeech = true
            silenceStartedAt = nil
            logState("speech")
            return .ongoing
        }
        if !sawSpeech {
            logState("pre-speech")
            return .waiting
        }
        if rms <= silenceThresh {
            if silenceStartedAt == nil {
                silenceStartedAt = Date()
                NSLog(String(format: "[VegaEar] VAD silence started, RMS=%.0f threshold=%.0f", rms, silenceThresh))
            }
            if let started = silenceStartedAt,
               Date().timeIntervalSince(started) * 1000 >= Double(config.endSilenceMs) {
                if suppressEndpoint {
                    // Don't fire endpoint in long-note mode; let safety cap own termination.
                    logState("silence-suppressed")
                } else {
                    NSLog("[VegaEar] VAD endpoint: sustained silence \(config.endSilenceMs) ms")
                    return .endpoint
                }
            }
            logState("silence")
        } else {
            if silenceStartedAt != nil {
                NSLog(String(format: "[VegaEar] VAD silence broken, RMS=%.0f", rms))
            }
            silenceStartedAt = nil
            logState("speech-tail")
        }
        return .ongoing
    }

    private func logState(_ state: String) {
        // Rate-limit by only logging state transitions (not every frame).
        guard state != lastLoggedState else { return }
        lastLoggedState = state
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
