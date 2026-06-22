import AVFAudio
import AVFoundation
import Combine
import EarCore
import EarProtocol
import Foundation
import SwiftUI
import UIKit

/// Top-level wiring for the iOS Ear. Owns the EarCore.SessionCoordinator,
/// the iOS-specific platform implementations of AudioCapturing / CuePlaying
/// / StatusControlling / OverlayControlling, and the VAD trigger that
/// replaces the wake-word.
@MainActor
final class AppCoordinator: ObservableObject {
    let overlayViewModel = OverlayViewModel()

    private let identity: DeviceIdentityService
    private var preferences: Preferences
    private let cues: iOSCuePlayer
    private let status: iOSStatusController
    private let overlayController: iOSOverlayController
    private let audio = iOSAudioCapturing()
    private let wake = NoopWakeDetector()  // wake-word is not used on iOS
    private let vadTrigger = VADTrigger()
    private var coordinator: SessionCoordinator?
    private var socket: EarSocket?
    private var currentEndpoint: URL?
    private var audioSinkSubscription: AnyCancellable?

    init() {
        identity = DeviceIdentityService(deviceName: UIDevice.current.name.isEmpty ? "iPhone" : UIDevice.current.name)
        preferences = Preferences()
        cues = iOSCuePlayer()
        status = iOSStatusController()
        overlayController = iOSOverlayController(viewModel: overlayViewModel)
    }

    func start() {
        requestMicPermissionThen { [weak self] granted in
            guard let self else { return }
            if granted {
                self.configureAudioSession()
                self.rebuildCoordinatorIfNeeded()
            } else {
                NSLog("[VegaEariOS] mic permission denied — Ear cannot capture")
            }
        }
    }

    func handleDidBecomeActive() {
        requestMicPermissionThen { [weak self] granted in
            guard let self, granted else { return }
            self.configureAudioSession()
            self.rebuildCoordinatorIfNeeded()
        }
    }

    private func requestMicPermissionThen(_ then: @escaping (Bool) -> Void) {
        if #available(iOS 17.0, *) {
            let perm = AVAudioApplication.shared.recordPermission
            switch perm {
            case .granted:
                then(true)
            case .denied:
                then(false)
            case .undetermined:
                AVAudioApplication.requestRecordPermission { granted in
                    DispatchQueue.main.async { then(granted) }
                }
            @unknown default:
                then(false)
            }
        } else {
            AVAudioSession.sharedInstance().requestRecordPermission { granted in
                DispatchQueue.main.async { then(granted) }
            }
        }
    }

    func handleWillResignActive() {
        // Going into background: tear the whole coordinator down so the
        // socket disconnects from Core, the mic releases, and Core
        // logs an explicit disconnect rather than a silent stale conn.
        // didBecomeActive will rebuild from scratch.
        coordinator?.shutdown()
        coordinator = nil
        currentEndpoint = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func configureAudioSession() {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(
                .playAndRecord,
                mode: .voiceChat,
                options: [.duckOthers, .defaultToSpeaker]
            )
            try session.setActive(true)
        } catch {
            NSLog("[VegaEariOS] AVAudioSession error: \(error)")
        }
    }

    private func rebuildCoordinatorIfNeeded() {
        let endpointString = UserDefaults.standard.string(forKey: "server_endpoint")
            ?? "ws://localhost:3000"
        guard let url = URL(string: endpointString) else {
            NSLog("[VegaEariOS] invalid endpoint URL: \(endpointString)")
            return
        }
        if currentEndpoint == url, coordinator != nil { return }

        coordinator?.shutdown()
        currentEndpoint = url

        let socket = EarSocket(
            url: url,
            deviceId: identity.deviceId,
            deviceName: identity.deviceName,
            capabilities: [.mic, .vad, .speaker]
        )
        self.socket = socket

        let c = SessionCoordinator(
            deviceId: identity.deviceId,
            wake: wake,
            audio: audio,
            encoder: PcmPassthroughEncoder(),
            socket: socket,
            cues: cues,
            statusController: status,
            overlay: overlayController
        )
        c.onSessionStateChange = { [weak self] active in
            self?.status.setSessionActive(active)
            // When a session ends, reset the VAD trigger so it
            // re-calibrates against the fresh ambient floor and is
            // ready to fire on the next onset. Without this the
            // detector latches at the noise floor it saw mid-session
            // and refuses to recognise the next quiet onset.
            if !active {
                self?.vadTrigger.reset()
            }
        }
        coordinator = c

        // VAD trigger: on voice-activity onset, simulate wake. The
        // SessionCoordinator emits session_start as usual; Core's gateway
        // accepts it because this device registered with `vad`. The
        // pre-roll buffer is the ~400 ms of mic audio captured BEFORE
        // VAD fired — flushed into the session so the leading syllables
        // of the user's phrase aren't clipped.
        vadTrigger.onVoiceOnset = { [weak c, weak audio] preroll in
            guard let c, let audio else { return }
            c.simulateWake()
            c.waitForPendingWork()
            audio.injectPreroll(preroll)
        }
        audio.addSink { [weak self] pcm in
            self?.vadTrigger.feed(pcm)
        }

        do {
            try c.start()
        } catch {
            NSLog("[VegaEariOS] coordinator.start failed: \(error)")
        }
        // After audio.start() inside coordinator the engine has settled
        // on a sample rate — propagate it into the VAD so the pre-roll
        // ring buffer caps at ~400 ms of bytes regardless of hardware.
        vadTrigger.sampleRate = audio.currentSampleRate
    }
}

// MARK: - VAD-trigger

/// Detects voice-activity onset and keeps a rolling pre-roll buffer of
/// the last ~`prerollMs` of raw PCM so the SessionCoordinator can
/// inject it as the first audio_frames after `session_start`, avoiding
/// clipped leading syllables.
final class VADTrigger {
    var onVoiceOnset: ((Data) -> Void)?
    /// Mic sample rate; used to bound the pre-roll ring buffer in bytes.
    var sampleRate: Double = 48_000 {
        didSet { queue.async { self.recomputePrerollCapacity() } }
    }
    private let prerollMs: Int = 400
    private let queue = DispatchQueue(label: "vega.ear.ios.vad")
    private var detector: SilenceDetector = VADTrigger.makeDetector()
    private var didFireForCurrentBurst = false
    private var prerollChunks: [Data] = []
    private var prerollByteCount: Int = 0
    private var prerollCapacityBytes: Int = 0

    init() {
        recomputePrerollCapacity()
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
        return (sumSquares / Double(count)).squareRoot()
    }

    private static func makeDetector() -> SilenceDetector {
        var cfg = SilenceDetector.Config()
        cfg.endSilenceMs = 1_500
        cfg.graceMs = 300
        cfg.calibrationMs = 600
        // Lower speech margin so quieter speech still wakes the trigger.
        // Simulator mic in particular feeds through low RMS levels.
        cfg.speechMargin = 120
        cfg.silenceMargin = 60
        return SilenceDetector(config: cfg)
    }

    /// Drop the current detector and start a fresh calibration window.
    /// Called by AppCoordinator after every session end so the next
    /// onset detection works against the current ambient floor.
    func reset() {
        queue.async {
            NSLog("[VegaEariOS] VAD reset — re-arming for next onset")
            self.detector = Self.makeDetector()
            self.didFireForCurrentBurst = false
            self.prerollChunks.removeAll()
            self.prerollByteCount = 0
        }
    }

    private var feedCount = 0
    func feed(_ pcm: Data) {
        queue.async {
            self.feedCount += 1
            if self.feedCount % 20 == 0 {
                let rms = Self.computeRms(pcm)
                NSLog(String(format: "[VegaEariOS] VAD feed #%d rms=%.0f didFire=%d",
                             self.feedCount, rms, self.didFireForCurrentBurst ? 1 : 0))
            }
            self.pushPreroll(pcm)
            let d = self.detector.feed(pcm: pcm)
            switch d {
            case .ongoing:
                if !self.didFireForCurrentBurst {
                    self.didFireForCurrentBurst = true
                    let preroll = self.flushPreroll()
                    NSLog("[VegaEariOS] VAD onset → fire (preroll=\(preroll.count)B)")
                    DispatchQueue.main.async {
                        self.onVoiceOnset?(preroll)
                    }
                }
            case .endpoint:
                if self.didFireForCurrentBurst {
                    NSLog("[VegaEariOS] VAD endpoint → re-armed")
                }
                self.didFireForCurrentBurst = false
            case .waiting:
                break
            }
        }
    }

    private func pushPreroll(_ pcm: Data) {
        prerollChunks.append(pcm)
        prerollByteCount += pcm.count
        while prerollByteCount > prerollCapacityBytes, prerollChunks.count > 1 {
            let dropped = prerollChunks.removeFirst()
            prerollByteCount -= dropped.count
        }
    }

    private func flushPreroll() -> Data {
        var out = Data(capacity: prerollByteCount)
        for chunk in prerollChunks { out.append(chunk) }
        return out
    }

    private func recomputePrerollCapacity() {
        // bytes = sampleRate * (ms/1000) * 2 (Int16)
        prerollCapacityBytes = Int(sampleRate * Double(prerollMs) / 1000.0) * 2
    }
}
