import AVFoundation
import Foundation
import EarProtocol

final class SessionCoordinator {
    private let deviceId: String
    private let wake: WakeWordDetector
    private let audio: AudioEngine
    private let encoder: AudioFrameProducer
    private let socket: EarSocket
    private let cues: CuePlayer
    private let status: StatusItemController
    private let safetyCapMs: Int = 30_000

    private let serial = DispatchQueue(label: "vega.ear.coordinator")
    private var activeSessionId: String?
    private var safetyTimer: DispatchSourceTimer?
    private var paused = false
    private var rmsAccumulator: [Int16] = []
    private var rmsLastReportAt = Date()
    private var bytesSentInSession = 0
    private var silenceDetector: SilenceDetector?
    var onSessionStateChange: ((Bool) -> Void)?
    private var sinkCallbackCount = 0

    init(
        deviceId: String,
        wake: WakeWordDetector,
        audio: AudioEngine,
        encoder: AudioFrameProducer,
        socket: EarSocket,
        cues: CuePlayer,
        statusController: StatusItemController
    ) {
        self.deviceId = deviceId
        self.wake = wake
        self.audio = audio
        self.encoder = encoder
        self.socket = socket
        self.cues = cues
        self.status = statusController
    }

    func start() throws {
        wake.onDetect = { [weak self] score in self?.handleWake(score: score) }
        socket.onMessage = { [weak self] msg in self?.handleCoreMessage(msg) }
        socket.onStatusChange = { [weak self] connected in
            self?.status.setState(connected ? .idle : .error("Core unreachable"))
        }

        audio.addSink { [weak self] pcm in
            guard let self else { return }
            self.serial.async {
                self.sinkCallbackCount += 1
                if self.sinkCallbackCount <= 3 {
                    NSLog("[VegaEar] SessionCoordinator sink #\(self.sinkCallbackCount): bytes=\(pcm.count) paused=\(self.paused) activeSession=\(self.activeSessionId ?? "nil")")
                }
                if !self.paused {
                    let downsampled = Self.downsample48kTo16k(pcm)
                    self.wake.feed(downsampled)
                }
                if self.activeSessionId != nil {
                    self.streamAudio(pcm)
                }
            }
        }

        try audio.start()
        try wake.start()
        socket.connect()
        status.setState(.idle)
    }

    func shutdown() {
        serial.sync {
            if let sid = activeSessionId {
                socket.sendJSON(EarSessionEndMessage(sessionId: sid, reason: .user))
            }
            activeSessionId = nil
            safetyTimer?.cancel()
            safetyTimer = nil
        }
        wake.stop()
        audio.stop()
        socket.disconnect()
    }

    func setPaused(_ paused: Bool) {
        serial.async {
            self.paused = paused
            if paused, let sid = self.activeSessionId {
                self.socket.sendJSON(EarSessionEndMessage(sessionId: sid, reason: .user))
                self.activeSessionId = nil
                self.safetyTimer?.cancel()
                self.safetyTimer = nil
            }
        }
    }

    // Public hook so a debug UI (menu-bar "Trigger test wake") or a future
    // remote trigger can start a session without going through Porcupine.
    func simulateWake() {
        NSLog("[VegaEar] simulateWake called")
        handleWake(score: 1.0)
    }

    // Manual session terminator for the menu-bar "Stop listening" item.
    func stopActiveSession() {
        serial.async {
            guard let sid = self.activeSessionId else {
                NSLog("[VegaEar] stopActiveSession called but no active session")
                return
            }
            NSLog("[VegaEar] stopActiveSession: ending session=\(sid) bytesSent=\(self.bytesSentInSession)")
            self.endSessionLocally(sessionId: sid, reason: .user)
        }
    }

    var hasActiveSession: Bool {
        var result = false
        serial.sync { result = activeSessionId != nil }
        return result
    }

    private func handleWake(score: Float) {
        serial.async {
            guard !self.paused else { return }
            guard self.activeSessionId == nil else { return }

            let sessionId = UUID().uuidString.lowercased()
            self.activeSessionId = sessionId
            self.bytesSentInSession = 0
            self.rmsAccumulator.removeAll(keepingCapacity: true)
            self.rmsLastReportAt = Date()
            self.silenceDetector = SilenceDetector()
            self.cues.play(.wake)
            self.status.setState(.listening)
            NSLog("[VegaEar] Wake detected (score=\(score)), session=\(sessionId)")

            let wakeMsg = WakeDetectedMessage(
                deviceId: self.deviceId,
                score: Double(score),
                timestamp: ISO8601DateFormatter().string(from: Date())
            )
            self.socket.sendJSON(wakeMsg)

            let startMsg = SessionStartMessage(
                deviceId: self.deviceId,
                sessionId: sessionId,
                userId: nil,
                sampleRate: 48_000,
                codec: .linear16
            )
            self.socket.sendJSON(startMsg)

            for buffered in self.audio.drainPreRoll() {
                self.streamAudio(buffered)
            }

            self.armSafetyTimer(for: sessionId)
            self.status.setState(.streaming)
            self.onSessionStateChange?(true)
        }
    }

    private func streamAudio(_ pcm: Data) {
        guard let sid = activeSessionId else { return }
        do {
            for frame in try encoder.encode(pcm) {
                socket.sendAudio(sessionId: sid, opusFrame: frame)
                bytesSentInSession += frame.count
            }
        } catch {
            NSLog("[VegaEar] encoder error: \(error)")
        }
        accumulateAndMaybeReportRms(pcm: pcm)

        if let detector = silenceDetector {
            switch detector.feed(pcm: pcm) {
            case .endpoint:
                NSLog("[VegaEar] local VAD endpoint, ending session=\(sid)")
                endSessionLocally(sessionId: sid, reason: .vad)
            case .waiting, .ongoing:
                break
            }
        }
    }

    private func endSessionLocally(sessionId: String, reason: EarEndReason) {
        guard activeSessionId == sessionId else { return }
        NSLog("[VegaEar] endSessionLocally session=\(sessionId) reason=\(reason.rawValue) bytesSent=\(bytesSentInSession)")
        socket.sendJSON(EarSessionEndMessage(sessionId: sessionId, reason: reason))
        cues.play(.endpoint)
        activeSessionId = nil
        silenceDetector = nil
        safetyTimer?.cancel()
        safetyTimer = nil
        status.setState(.idle)
        onSessionStateChange?(false)
    }

    private func accumulateAndMaybeReportRms(pcm: Data) {
        let count = pcm.count / MemoryLayout<Int16>.size
        var samples = [Int16](repeating: 0, count: count)
        _ = samples.withUnsafeMutableBytes { pcm.copyBytes(to: $0) }
        rmsAccumulator.append(contentsOf: samples)
        let now = Date()
        if now.timeIntervalSince(rmsLastReportAt) >= 1.0, !rmsAccumulator.isEmpty {
            var sumSquares: Double = 0
            for s in rmsAccumulator {
                let f = Double(s)
                sumSquares += f * f
            }
            let rms = sqrt(sumSquares / Double(rmsAccumulator.count))
            let dbfs = 20 * log10(max(rms, 1) / 32768.0)
            NSLog(String(
                format: "[VegaEar] mic RMS=%.0f (%.1f dBFS) samples=%d bytesSent=%d",
                rms, dbfs, rmsAccumulator.count, bytesSentInSession
            ))
            rmsAccumulator.removeAll(keepingCapacity: true)
            rmsLastReportAt = now
        }
    }

    private func armSafetyTimer(for sessionId: String) {
        safetyTimer?.cancel()
        let timer = DispatchSource.makeTimerSource(queue: serial)
        timer.schedule(deadline: .now() + .milliseconds(safetyCapMs))
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            guard self.activeSessionId == sessionId else { return }
            NSLog("[VegaEar] safety timer fired for session=\(sessionId) bytesSent=\(self.bytesSentInSession)")
            self.socket.sendJSON(EarSessionEndMessage(sessionId: sessionId, reason: .timeout))
            self.cues.play(.endpoint)
            self.activeSessionId = nil
            self.status.setState(.idle)
            self.onSessionStateChange?(false)
        }
        timer.resume()
        safetyTimer = timer
    }

    private func handleCoreMessage(_ message: CoreToEarMessage) {
        switch message {
        case .ack:
            break
        case .wakeAck(let m):
            if m.action == .yield {
                serial.async {
                    if let sid = self.activeSessionId {
                        self.socket.sendJSON(EarSessionEndMessage(sessionId: sid, reason: .user))
                        self.activeSessionId = nil
                        self.safetyTimer?.cancel()
                        self.status.setState(.idle)
                    }
                }
            }
        case .playCue(let m):
            switch m.cue {
            case .wake: cues.play(.wake)
            case .endpoint: cues.play(.endpoint)
            case .error: cues.play(.error)
            }
        case .sessionEnd(let m):
            serial.async {
                NSLog("[VegaEar] session_end from Core: reason=\(m.reason.rawValue) detail=\(m.detail ?? "-") bytesSent=\(self.bytesSentInSession)")
                guard self.activeSessionId == m.sessionId else { return }
                self.activeSessionId = nil
                self.safetyTimer?.cancel()
                self.safetyTimer = nil
                switch m.reason {
                case .endpoint:
                    self.status.setState(.idle)
                case .timeout:
                    self.cues.play(.endpoint)
                    self.status.setState(.idle)
                case .sttError, .user:
                    self.cues.play(.error)
                    self.status.setState(.error(m.detail ?? "Session ended: \(m.reason.rawValue)"))
                }
                self.onSessionStateChange?(false)
            }
        case .partialTranscript(let m):
            NSLog("[VegaEar] partial: \(m.text)")
        case .finalTranscript(let m):
            NSLog("[VegaEar] final: \(m.text)")
        }
    }

    // Naive 3:1 decimation 48 kHz -> 16 kHz for Porcupine. Picks every third
    // int16 sample; good enough for keyword spotting at low CPU cost. A future
    // change can swap in a proper low-pass filter if false-positive rate rises.
    private static func downsample48kTo16k(_ pcm: Data) -> Data {
        let count = pcm.count / MemoryLayout<Int16>.size
        var samples = [Int16](repeating: 0, count: count)
        _ = samples.withUnsafeMutableBytes { pcm.copyBytes(to: $0) }
        var out: [Int16] = []
        out.reserveCapacity(count / 3 + 1)
        var i = 0
        while i < samples.count {
            out.append(samples[i])
            i += 3
        }
        return out.withUnsafeBufferPointer { Data(buffer: $0) }
    }
}
