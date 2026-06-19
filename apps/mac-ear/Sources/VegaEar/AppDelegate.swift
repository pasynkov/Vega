import AppKit
import AVFoundation
import Foundation

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusController: StatusItemController!
    private var coordinator: SessionCoordinator!
    private var identity: DeviceIdentityService!
    private var preferences: Preferences!
    private var audio: AudioEngine!
    private var openWakeWord: OpenWakeWordDetector?
    private var overlayController: OverlayWindowController!

    func applicationDidFinishLaunching(_ notification: Notification) {
        identity = DeviceIdentityService()
        preferences = Preferences()
        statusController = StatusItemController()
        overlayController = OverlayWindowController()
        overlayController.anchorFrameProvider = { [weak self] in self?.statusController.statusButtonScreenFrame }
        checkMicrophonePermission()
        statusController.onPauseToggle = { [weak self] paused in
            self?.coordinator.setPaused(paused)
        }
        statusController.onQuit = { [weak self] in
            self?.coordinator.shutdown()
            NSApp.terminate(nil)
        }
        statusController.onTestWake = { [weak self] in
            self?.coordinator.simulateWake()
        }
        statusController.onStopSession = { [weak self] in
            self?.coordinator.stopActiveSession()
        }
        statusController.onMicSelected = { [weak self] uid in
            self?.applyMicSelection(uid: uid)
        }
        statusController.onWakeThresholdSelected = { [weak self] value in
            self?.applyWakeThreshold(value)
        }
        statusController.setWakeThreshold(preferences.wakeThreshold)

        do {
            audio = try AudioEngine()
            let encoder = PcmPassthroughEncoder()
            let cues = CuePlayer()
            let socket = EarSocket(
                url: URL(string: "ws://127.0.0.1:7777")!,
                deviceId: identity.deviceId,
                deviceName: identity.deviceName
            )

            // Apply persisted mic choice (if any) before starting the engine.
            if let uid = preferences.micUID, let device = MicDeviceCatalog.find(uid: uid) {
                try audio.selectDevice(device)
            } else {
                try audio.selectDevice(nil)
            }
            refreshMicMenu()

            let wakeDetector: WakeWordDetector
            do {
                let oww = try OpenWakeWordDetector(threshold: preferences.wakeThreshold)
                openWakeWord = oww
                wakeDetector = oww
            } catch {
                NSLog("[VegaEar] Wake detector unavailable: \(error). Falling back to NoopWakeDetector.")
                wakeDetector = NoopWakeDetector()
                statusController.setState(.error("Wake detector unavailable: \(error.localizedDescription)"))
            }

            coordinator = SessionCoordinator(
                deviceId: identity.deviceId,
                wake: wakeDetector,
                audio: audio,
                encoder: encoder,
                socket: socket,
                cues: cues,
                statusController: statusController,
                overlay: overlayController
            )
            coordinator.onSessionStateChange = { [weak self] active in
                self?.statusController.setSessionActive(active)
            }
            try coordinator.start()
        } catch {
            NSLog("[VegaEar] Fatal during startup: \(error)")
            statusController.setState(.error("Startup failed: \(error.localizedDescription)"))
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        coordinator?.shutdown()
    }

    private func applyMicSelection(uid: String?) {
        NSLog("[VegaEar] AppDelegate.applyMicSelection(uid=\(uid ?? "nil"))")
        guard let audio else {
            NSLog("[VegaEar] applyMicSelection: audio is nil, bailing")
            return
        }
        do {
            let device = uid.flatMap { MicDeviceCatalog.find(uid: $0) }
            try audio.selectDevice(device)
            preferences.setMicUID(uid)
            NSLog("[VegaEar] preferences.micUID after set = \(preferences.micUID ?? "nil")")
            refreshMicMenu()
        } catch {
            NSLog("[VegaEar] Failed to apply mic selection: \(error)")
            statusController.setState(.error("Mic selection failed: \(error.localizedDescription)"))
        }
    }

    private func checkMicrophonePermission() {
        let status = AVCaptureDevice.authorizationStatus(for: .audio)
        switch status {
        case .authorized:
            NSLog("[VegaEar] mic permission: authorized")
        case .notDetermined:
            NSLog("[VegaEar] mic permission: not determined — requesting…")
            AVCaptureDevice.requestAccess(for: .audio) { granted in
                NSLog("[VegaEar] mic permission requestAccess result: granted=\(granted)")
                if !granted {
                    DispatchQueue.main.async {
                        self.statusController.setState(.error("Microphone access denied. Grant in System Settings → Privacy & Security → Microphone."))
                    }
                }
            }
        case .denied:
            NSLog("[VegaEar] mic permission: DENIED — open System Settings → Privacy & Security → Microphone")
            statusController.setState(.error("Microphone access denied. Grant in System Settings → Privacy & Security → Microphone."))
        case .restricted:
            NSLog("[VegaEar] mic permission: restricted by parental controls / MDM")
            statusController.setState(.error("Microphone access restricted by system policy."))
        @unknown default:
            NSLog("[VegaEar] mic permission: unknown status \(status.rawValue)")
        }
    }

    private func refreshMicMenu() {
        let devices = MicDeviceCatalog.list()
        statusController.setMicSnapshot(devices: devices, selectedUID: preferences.micUID)
    }

    private func applyWakeThreshold(_ value: Double) {
        preferences.setWakeThreshold(value)
        openWakeWord?.setThreshold(preferences.wakeThreshold)
        statusController.setWakeThreshold(preferences.wakeThreshold)
        NSLog("[VegaEar] wake threshold updated to \(preferences.wakeThreshold)")
    }
}
