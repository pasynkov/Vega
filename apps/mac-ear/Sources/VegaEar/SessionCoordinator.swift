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
    private let overlay: OverlayWindowController
    private let regularSafetyCapMs: Int = 30_000
    private let continuousModeSafetyCapMs: Int = 60_000

    private let serial = DispatchQueue(label: "vega.ear.coordinator")
    private var activeSessionId: String?
    private var safetyTimer: DispatchSourceTimer?
    private var paused = false
    private var rmsAccumulator: [Int16] = []
    private var rmsLastReportAt = Date()
    private var bytesSentInSession = 0
    private var silenceDetector: SilenceDetector?
    private var sessionMode: SessionMode = .regular
    var onSessionStateChange: ((Bool) -> Void)?
    private var sinkCallbackCount = 0

    init(
        deviceId: String,
        wake: WakeWordDetector,
        audio: AudioEngine,
        encoder: AudioFrameProducer,
        socket: EarSocket,
        cues: CuePlayer,
        statusController: StatusItemController,
        overlay: OverlayWindowController
    ) {
        self.deviceId = deviceId
        self.wake = wake
        self.audio = audio
        self.encoder = encoder
        self.socket = socket
        self.cues = cues
        self.status = statusController
        self.overlay = overlay
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
                    let downsampled = self.downsample48kTo16k(pcm)
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
                NSLog("[VegaEar] Ear ending session=\(sid) initiator=ear:quit reason=user bytesSent=\(bytesSentInSession)")
                socket.sendJSON(EarSessionEndMessage(sessionId: sid, reason: .user))
            }
            activeSessionId = nil
            safetyTimer?.cancel()
            safetyTimer = nil
        }
        wake.stop()
        audio.stop()
        socket.disconnect()
        DispatchQueue.main.async { self.overlay.viewModel.hide() }
    }

    func setPaused(_ paused: Bool) {
        serial.async {
            self.paused = paused
            if paused, let sid = self.activeSessionId {
                NSLog("[VegaEar] Ear ending session=\(sid) initiator=ear:pause reason=user bytesSent=\(self.bytesSentInSession)")
                self.socket.sendJSON(EarSessionEndMessage(sessionId: sid, reason: .user))
                self.activeSessionId = nil
                self.safetyTimer?.cancel()
                self.safetyTimer = nil
                DispatchQueue.main.async { self.overlay.viewModel.hide() }
            }
        }
    }

    // Public hook so a debug UI (menu-bar "Trigger test wake") or a future
    // remote trigger can start a session without going through the wake detector.
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
            NSLog("[VegaEar] Ear ending session=\(sid) initiator=ear:menu reason=user bytesSent=\(self.bytesSentInSession)")
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
            self.sessionMode = .regular
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
                sampleRate: Int(self.audio.currentSampleRate),
                codec: .linear16,
                mode: .regular
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

    private func handleArmCapture(mode: SessionMode) {
        serial.async {
            guard !self.paused else { return }
            guard self.activeSessionId == nil else {
                NSLog("[VegaEar] arm_capture ignored: session already active")
                return
            }
            let sessionId = UUID().uuidString.lowercased()
            self.activeSessionId = sessionId
            self.bytesSentInSession = 0
            self.rmsAccumulator.removeAll(keepingCapacity: true)
            self.rmsLastReportAt = Date()
            self.silenceDetector = SilenceDetector()
            self.sessionMode = mode
            self.silenceDetector?.setEndpointSuppressed(mode == .continuous)
            NSLog("[VegaEar] arm_capture: starting session=\(sessionId) mode=\(mode.rawValue)")

            // Cue: continuous plays Submarine (ack_continue), regular plays wake.
            switch mode {
            case .continuous: self.cues.play(.ackContinue)
            case .regular: self.cues.play(.wake)
            }

            let startMsg = SessionStartMessage(
                deviceId: self.deviceId,
                sessionId: sessionId,
                userId: nil,
                sampleRate: Int(self.audio.currentSampleRate),
                codec: .linear16,
                mode: mode
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
                NSLog("[VegaEar] Ear ending session=\(sid) initiator=ear:local_vad reason=vad bytesSent=\(bytesSentInSession)")
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
        activeSessionId = nil
        silenceDetector = nil
        safetyTimer?.cancel()
        safetyTimer = nil
        status.setState(.idle)
        onSessionStateChange?(false)
        // Overlay is driven by Core. Do not hide locally; Core will paint
        // the next state (thinking / error / idle) after handleTurn.
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
        let capMs = sessionMode == .continuous ? continuousModeSafetyCapMs : regularSafetyCapMs
        safetyTimer?.cancel()
        let timer = DispatchSource.makeTimerSource(queue: serial)
        timer.schedule(deadline: .now() + .milliseconds(capMs))
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            guard self.activeSessionId == sessionId else { return }
            NSLog("[VegaEar] Ear ending session=\(sessionId) initiator=ear:safety_timer reason=timeout bytesSent=\(self.bytesSentInSession) mode=\(self.sessionMode.rawValue) cap=\(capMs)")
            self.socket.sendJSON(EarSessionEndMessage(sessionId: sessionId, reason: .timeout))
            self.activeSessionId = nil
            self.status.setState(.idle)
            self.onSessionStateChange?(false)
            // Overlay handed off to Core (it will paint error+ttl on the
            // resulting terminate(timeout) path).
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
        case .overlayUpdate(let m):
            applyOverlayUpdate(m)
        case .sessionEnd(let m):
            serial.async {
                NSLog("[VegaEar] Core ended session=\(m.sessionId) reason=\(m.reason.rawValue) detail=\(m.detail ?? "-") bytesSent=\(self.bytesSentInSession)")
                guard self.activeSessionId == m.sessionId else { return }
                self.activeSessionId = nil
                self.safetyTimer?.cancel()
                self.safetyTimer = nil
                switch m.reason {
                case .endpoint:
                    self.status.setState(.idle)
                case .timeout:
                    self.status.setState(.idle)
                case .sttError, .user:
                    self.status.setState(.error(m.detail ?? "Session ended: \(m.reason.rawValue)"))
                }
                self.onSessionStateChange?(false)
                // Intentionally NOT calling overlay.viewModel.hide() here.
                // The overlay is decoupled from session lifecycle so the
                // user keeps seeing "thinking" between session_end and
                // the next overlay_update (arm_capture, success, error).
                // The overlay disappears when Core emits {kind: idle} or
                // on WS disconnect.
            }
        case .partialTranscript(let m):
            NSLog("[VegaEar] partial: \(m.text)")
            serial.async { self.bumpSafetyOnTranscript(sessionId: m.sessionId) }
        case .finalTranscript(let m):
            NSLog("[VegaEar] final: \(m.text)")
            serial.async { self.bumpSafetyOnTranscript(sessionId: m.sessionId) }
        case .sessionMode(let m):
            serial.async { self.applySessionMode(m) }
        case .armCapture(let m):
            handleArmCapture(mode: m.mode)
        case .unknownOverlay(let seq, let raw):
            NSLog("[VegaEar] Tolerating unknown overlay state seq=\(seq) kind=\(raw.rawKind)")
            DispatchQueue.main.async { self.overlay.viewModel.applyUnknown(seq: seq, raw: raw) }
        case .unknownSessionMode(let raw):
            NSLog("[VegaEar] Ignoring unknown session_mode value from Core: \(raw)")
        }
    }

    private func applyOverlayUpdate(_ message: OverlayUpdateMessage) {
        // Sound and visual arrive atomically. Play the cue first so the
        // perceived audio aligns with the visual transition.
        if let sound = message.state.sound {
            playOverlaySound(sound)
        }
        DispatchQueue.main.async {
            self.overlay.viewModel.apply(message)
            self.overlay.show()
        }
    }

    private func playOverlaySound(_ sound: OverlaySound) {
        switch sound {
        case .endpoint:     cues.play(.endpoint)
        case .error:        cues.play(.error)
        case .ackDone:      cues.play(.ackDone)
        case .ackContinue:  cues.play(.ackContinue)
        case .ackThinking:  cues.play(.ackThinking)
        case .ackSuccess:   cues.play(.ackSuccess)
        case .ackError:     cues.play(.ackError)
        case .ackUnknown:   cues.play(.ackUnknown)
        }
    }

    private func applySessionMode(_ msg: SessionModeChangeMessage) {
        guard activeSessionId == msg.sessionId else {
            NSLog("[VegaEar] session_mode for inactive session=\(msg.sessionId), ignoring")
            return
        }
        sessionMode = msg.mode
        NSLog("[VegaEar] session_mode applied: \(msg.mode.rawValue)")
        silenceDetector?.setEndpointSuppressed(msg.mode == .continuous)
        armSafetyTimer(for: msg.sessionId)
        if msg.mode == .continuous {
            status.setState(.streaming)
        }
    }

    private func bumpSafetyOnTranscript(sessionId: String) {
        guard activeSessionId == sessionId, sessionMode == .continuous else { return }
        armSafetyTimer(for: sessionId)
    }

    // Naive decimation to 16 kHz for the wake detector. Computes stride from the
    // actual capture rate so it works whether the device delivered 48 kHz
    // (built-in mic) or 16 kHz (AirPods HFP).
    private func downsample48kTo16k(_ pcm: Data) -> Data {
        let stride = max(1, Int((audio.currentSampleRate / 16_000.0).rounded()))
        if stride == 1 { return pcm }
        let count = pcm.count / MemoryLayout<Int16>.size
        var samples = [Int16](repeating: 0, count: count)
        _ = samples.withUnsafeMutableBytes { pcm.copyBytes(to: $0) }
        var out: [Int16] = []
        out.reserveCapacity(count / stride + 1)
        var i = 0
        while i < samples.count {
            out.append(samples[i])
            i += stride
        }
        return out.withUnsafeBufferPointer { Data(buffer: $0) }
    }
}
