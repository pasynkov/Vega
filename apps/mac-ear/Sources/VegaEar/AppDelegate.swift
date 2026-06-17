import AppKit
import Foundation

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusController: StatusItemController!
    private var coordinator: SessionCoordinator!
    private var identity: DeviceIdentityService!
    private var secrets: SecretStore!
    private var preferences: Preferences!
    private var audio: AudioEngine!

    func applicationDidFinishLaunching(_ notification: Notification) {
        identity = DeviceIdentityService()
        secrets = SecretStore()
        preferences = Preferences()
        statusController = StatusItemController()
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
        statusController.onMicSelected = { [weak self] uid in
            self?.applyMicSelection(uid: uid)
        }

        do {
            audio = try AudioEngine()
            let encoder = PcmPassthroughEncoder()
            let cues = CuePlayer()
            let socket = EarSocket(
                url: URL(string: "ws://127.0.0.1:7777/ear")!,
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
                let porcupine = try PorcupineDetector(
                    accessKey: try secrets.porcupineAccessKey(),
                    audioFrameSink: { /* wired by AudioEngine */ }
                )
                wakeDetector = porcupine
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
                statusController: statusController
            )
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
        guard let audio else { return }
        do {
            let device = uid.flatMap { MicDeviceCatalog.find(uid: $0) }
            try audio.selectDevice(device)
            preferences.setMicUID(uid)
            NSLog("[VegaEar] mic selected: uid=\(uid ?? "system default")")
            refreshMicMenu()
        } catch {
            NSLog("[VegaEar] Failed to apply mic selection: \(error)")
            statusController.setState(.error("Mic selection failed: \(error.localizedDescription)"))
        }
    }

    private func refreshMicMenu() {
        let devices = MicDeviceCatalog.list()
        statusController.setMicSnapshot(devices: devices, selectedUID: preferences.micUID)
    }
}
