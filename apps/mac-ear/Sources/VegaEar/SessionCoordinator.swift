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
    private let immersiveModeSafetyCapMs: Int = 60_000
    private let askDefaultCaptureMs: Int = 8_000

    private let serial = DispatchQueue(label: "vega.ear.coordinator")
    private var activeSessionId: String?
    private var safetyTimer: DispatchSourceTimer?
    private var paused = false
    private var rmsAccumulator: [Int16] = []
    private var rmsLastReportAt = Date()
    private var bytesSentInSession = 0
    private var silenceDetector: SilenceDetector?
    private var sessionMode: SessionMode = .regular
    private var askCaptureMs: Int = 0
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
        socket.handlers.onAck = { [weak self] m in self?.handleAck(m) }
        socket.handlers.onWakeAck = { [weak self] m in self?.handleWakeAck(m) }
        socket.handlers.onPartialTranscript = { [weak self] m in self?.handlePartial(m) }
        socket.handlers.onFinalTranscript = { [weak self] m in self?.handleFinal(m) }
        socket.handlers.onOverlayUpdate = { [weak self] m in self?.applyOverlayUpdate(m) }
        socket.handlers.onListViewUpdate = { [weak self] m in self?.applyListViewUpdate(m) }
        socket.handlers.onArmCapture = { [weak self] m in
            self?.handleArmCapture(mode: m.mode, captureMs: m.captureMs)
        }
        socket.handlers.onSessionMode = { [weak self] m in
            self?.serial.async { self?.applySessionMode(m) }
        }
        socket.handlers.onSessionEnd = { [weak self] m in self?.handleSessionEnd(m) }
        socket.onStatusChange = { [weak self] connected in
            self?.status.setState(connected ? .idle : .error("Core unreachable"))
            // Reset overlay state on BOTH transitions:
            //   - disconnect: in-flight state is moot
            //   - connect: backend just rebound the overlay channel and its
            //     seq counter restarted at 0. Without resetting here, our
            //     `lastOverlaySeq` may still hold a high value from before
            //     the backend crashed, and every fresh overlay_update gets
            //     dropped as stale (sound plays, visual never updates).
            DispatchQueue.main.async { self?.overlay.viewModel.hide() }
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
                socket.emit(EventName.earSessionEnd, EarSessionEndMessage(sessionId: sid, reason: .user))
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
                self.socket.emit(EventName.earSessionEnd, EarSessionEndMessage(sessionId: sid, reason: .user))
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
            self.socket.emit(EventName.wakeDetected, wakeMsg)

            let startMsg = SessionStartMessage(
                deviceId: self.deviceId,
                sessionId: sessionId,
                userId: nil,
                sampleRate: Int(self.audio.currentSampleRate),
                codec: .linear16,
                mode: .regular
            )
            self.socket.emit(EventName.sessionStart, startMsg)

            for buffered in self.audio.drainPreRoll() {
                self.streamAudio(buffered)
            }

            self.armSafetyTimer(for: sessionId)
            self.status.setState(.streaming)
            self.onSessionStateChange?(true)
        }
    }

    private func handleArmCapture(mode: SessionMode, captureMs: Int?) {
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
            // VAD endpoint is suppressed for both continuous and ask modes:
            // continuous wants long dictation without auto-cut; ask wants
            // the first single final to come from Deepgram without local
            // VAD pre-empting a short answer.
            self.silenceDetector?.setEndpointSuppressed(mode == .continuous || mode == .ask || mode == .immersive)
            self.askCaptureMs = mode == .ask ? (captureMs ?? self.askDefaultCaptureMs) : 0
            NSLog("[VegaEar] arm_capture: starting session=\(sessionId) mode=\(mode.rawValue) captureMs=\(self.askCaptureMs)")

            // Cue: continuous and immersive both play Submarine (ack_continue)
            // — the "long session opened" auditory signal. ask plays Tink
            // (cue_listen), regular plays wake.
            switch mode {
            case .continuous, .immersive: self.cues.play(.ackContinue)
            case .ask: self.cues.play(.cueListen)
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
            self.socket.emit(EventName.sessionStart, startMsg)

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
                socket.emitAudio(sessionId: sid, pcm: frame)
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
        socket.emit(EventName.earSessionEnd, EarSessionEndMessage(sessionId: sessionId, reason: reason))
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
        // Immersive sessions have no Ear-side wall-clock cap: the user
        // "lives" in the domain until they explicitly close it by voice
        // or Core's silence cap (15s of no STT activity, paused while
        // the domain agent is mid-invoke) terminates from the server.
        // A 60s Ear cap here would kick the user out mid-conversation.
        if sessionMode == .immersive {
            safetyTimer?.cancel()
            safetyTimer = nil
            return
        }
        let capMs: Int
        switch sessionMode {
        case .continuous: capMs = continuousModeSafetyCapMs
        case .immersive: capMs = immersiveModeSafetyCapMs
        case .ask: capMs = askCaptureMs > 0 ? askCaptureMs : askDefaultCaptureMs
        case .regular: capMs = regularSafetyCapMs
        }
        safetyTimer?.cancel()
        let timer = DispatchSource.makeTimerSource(queue: serial)
        timer.schedule(deadline: .now() + .milliseconds(capMs))
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            guard self.activeSessionId == sessionId else { return }
            NSLog("[VegaEar] Ear ending session=\(sessionId) initiator=ear:safety_timer reason=timeout bytesSent=\(self.bytesSentInSession) mode=\(self.sessionMode.rawValue) cap=\(capMs)")
            self.socket.emit(EventName.earSessionEnd, EarSessionEndMessage(sessionId: sessionId, reason: .timeout))
            self.activeSessionId = nil
            self.status.setState(.idle)
            self.onSessionStateChange?(false)
            // Overlay handed off to Core (it will paint error+ttl on the
            // resulting terminate(timeout) path).
        }
        timer.resume()
        safetyTimer = timer
    }

    private func handleAck(_ message: AckMessage) {
        NSLog("[VegaEar] register acked for deviceId=\(message.deviceId)")
    }

    private func handleWakeAck(_ message: WakeAckMessage) {
        guard message.action == .yield else { return }
        serial.async {
            if let sid = self.activeSessionId {
                self.socket.emit(EventName.earSessionEnd, EarSessionEndMessage(sessionId: sid, reason: .user))
                self.activeSessionId = nil
                self.safetyTimer?.cancel()
                self.status.setState(.idle)
            }
        }
    }

    private func handlePartial(_ message: PartialTranscriptMessage) {
        NSLog("[VegaEar] partial: \(message.text)")
        serial.async { self.bumpSafetyOnTranscript(sessionId: message.sessionId) }
    }

    private func handleFinal(_ message: FinalTranscriptMessage) {
        NSLog("[VegaEar] final: \(message.text)")
        serial.async { self.bumpSafetyOnTranscript(sessionId: message.sessionId) }
    }

    private func handleSessionEnd(_ message: CoreSessionEndMessage) {
        serial.async {
            NSLog("[VegaEar] Core ended session=\(message.sessionId) reason=\(message.reason.rawValue) detail=\(message.detail ?? "-") bytesSent=\(self.bytesSentInSession)")
            guard self.activeSessionId == message.sessionId else { return }
            self.activeSessionId = nil
            self.safetyTimer?.cancel()
            self.safetyTimer = nil
            switch message.reason {
            case .endpoint:
                self.status.setState(.idle)
            case .timeout:
                self.status.setState(.idle)
            case .sttError, .user:
                self.status.setState(.error(message.detail ?? "Session ended: \(message.reason.rawValue)"))
            }
            self.onSessionStateChange?(false)
            // Intentionally NOT calling overlay.viewModel.hide() here.
            // The overlay is decoupled from session lifecycle so the
            // user keeps seeing "thinking" between session_end and
            // the next overlay_update.
        }
    }

    private func applyListViewUpdate(_ message: ListViewUpdateMessage) {
        DispatchQueue.main.async {
            self.overlay.viewModel.applyListView(message)
            if message.view.open {
                self.overlay.show()
            }
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
        case .cueListen:    cues.play(.cueListen)
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
        // Ask mode does NOT reset its cap on partials — captureMs is a
        // hard wall-clock budget for the user to start answering.
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
