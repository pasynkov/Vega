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
        coordinator?.stopActiveSession()
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
        }
        coordinator = c

        // VAD trigger: on voice-activity onset, simulate wake. The
        // SessionCoordinator emits session_start as usual; Core's gateway
        // accepts it because this device registered with `vad`.
        vadTrigger.onVoiceOnset = { [weak c] in c?.simulateWake() }
        audio.addSink { [weak self] pcm in
            self?.vadTrigger.feed(pcm)
        }

        do {
            try c.start()
        } catch {
            NSLog("[VegaEariOS] coordinator.start failed: \(error)")
        }
    }
}

// MARK: - VAD-trigger

final class VADTrigger {
    var onVoiceOnset: (() -> Void)?
    private let queue = DispatchQueue(label: "vega.ear.ios.vad")
    private let detector: SilenceDetector = {
        var cfg = SilenceDetector.Config()
        cfg.endSilenceMs = 1_500
        cfg.graceMs = 300
        cfg.calibrationMs = 600
        return SilenceDetector(config: cfg)
    }()
    private var didFireForCurrentBurst = false

    func feed(_ pcm: Data) {
        queue.async {
            let d = self.detector.feed(pcm: pcm)
            switch d {
            case .ongoing:
                if !self.didFireForCurrentBurst {
                    self.didFireForCurrentBurst = true
                    DispatchQueue.main.async { self.onVoiceOnset?() }
                }
            case .endpoint:
                self.didFireForCurrentBurst = false
            case .waiting:
                break
            }
        }
    }
}
