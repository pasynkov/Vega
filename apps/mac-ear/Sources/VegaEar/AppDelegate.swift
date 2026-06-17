import AppKit
import Foundation

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusController: StatusItemController!
    private var coordinator: SessionCoordinator!
    private var identity: DeviceIdentityService!
    private var secrets: SecretStore!

    func applicationDidFinishLaunching(_ notification: Notification) {
        identity = DeviceIdentityService()
        secrets = SecretStore()
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

        do {
            let audio = try AudioEngine()
            let encoder = PcmPassthroughEncoder()
            let cues = CuePlayer()
            let socket = EarSocket(
                url: URL(string: "ws://127.0.0.1:7777/ear")!,
                deviceId: identity.deviceId,
                deviceName: identity.deviceName
            )

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
}
