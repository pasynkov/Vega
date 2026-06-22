import Foundation
import EarProtocol
@testable import EarCore

// MARK: - Wake

final class MockWakeDetector: WakeWordDetector {
    var onDetect: ((Float) -> Void)?
    let requiredSampleRate: Double = 16_000
    private(set) var fedBytes: Int = 0
    private(set) var startCount = 0
    private(set) var stopCount = 0

    func feed(_ pcm: Data) { fedBytes += pcm.count }
    func start() throws { startCount += 1 }
    func stop() { stopCount += 1 }

    func trigger(score: Float = 0.9) { onDetect?(score) }
}

// MARK: - Audio

final class MockAudioCapturing: AudioCapturing {
    var currentSampleRate: Double = 48_000
    private(set) var sinks: [(Data) -> Void] = []
    private(set) var startCount = 0
    private(set) var stopCount = 0

    func addSink(_ sink: @escaping (Data) -> Void) { sinks.append(sink) }
    func start() throws { startCount += 1 }
    func stop() { stopCount += 1 }

    // Test driver: emulate a PCM chunk arriving from the device.
    func emitFrames(_ data: Data) {
        for sink in sinks { sink(data) }
    }
}

// MARK: - Socket

final class MockEarSocket: EarSocketing {
    struct EmittedEvent: Equatable {
        let event: String
        let payloadJSON: String
    }

    var handlers = EarSocketHandlers()
    var onStatusChange: ((Bool) -> Void)?

    private(set) var connectCount = 0
    private(set) var disconnectCount = 0
    private(set) var emittedEvents: [EmittedEvent] = []
    private(set) var emittedAudio: [(sessionId: String, bytes: Int)] = []

    func connect() {
        connectCount += 1
        onStatusChange?(true)
    }

    func disconnect() {
        disconnectCount += 1
        onStatusChange?(false)
    }

    func emit<T: Encodable>(_ event: String, _ payload: T) {
        let data = (try? EarProtocol.encoder.encode(payload)) ?? Data()
        let json = String(data: data, encoding: .utf8) ?? "<encode failed>"
        emittedEvents.append(EmittedEvent(event: event, payloadJSON: json))
    }

    func emitAudio(sessionId: String, pcm: Data) {
        emittedAudio.append((sessionId, pcm.count))
    }

    func emittedSessionStartMessages() -> [SessionStartMessage] {
        return emittedEvents.compactMap { ev in
            guard ev.event == EventName.sessionStart,
                  let bytes = ev.payloadJSON.data(using: .utf8) else { return nil }
            return try? EarProtocol.decoder.decode(SessionStartMessage.self, from: bytes)
        }
    }

    func emittedSessionEndMessages() -> [EarSessionEndMessage] {
        return emittedEvents.compactMap { ev in
            guard ev.event == EventName.earSessionEnd,
                  let bytes = ev.payloadJSON.data(using: .utf8) else { return nil }
            return try? EarProtocol.decoder.decode(EarSessionEndMessage.self, from: bytes)
        }
    }

    func emittedWakeDetectedMessages() -> [WakeDetectedMessage] {
        return emittedEvents.compactMap { ev in
            guard ev.event == EventName.wakeDetected,
                  let bytes = ev.payloadJSON.data(using: .utf8) else { return nil }
            return try? EarProtocol.decoder.decode(WakeDetectedMessage.self, from: bytes)
        }
    }
}

// MARK: - Cues

final class MockCuePlayer: CuePlaying {
    private(set) var played: [CueSound] = []
    func play(_ cue: CueSound) { played.append(cue) }
}

// MARK: - Status

final class MockStatusController: StatusControlling {
    private(set) var states: [ListeningState] = []
    private(set) var sessionActiveValues: [Bool] = []
    func setState(_ state: ListeningState) { states.append(state) }
    func setSessionActive(_ active: Bool) { sessionActiveValues.append(active) }
}

// MARK: - Overlay

final class MockOverlayController: OverlayControlling {
    private(set) var showCount = 0
    private(set) var hideCount = 0
    private(set) var overlayUpdates: [OverlayUpdateMessage] = []
    private(set) var listViewUpdates: [ListViewUpdateMessage] = []

    func showOverlay() { showCount += 1 }
    func hideOverlay() { hideCount += 1 }
    func applyOverlayUpdate(_ message: OverlayUpdateMessage) { overlayUpdates.append(message) }
    func applyListViewUpdate(_ message: ListViewUpdateMessage) { listViewUpdates.append(message) }
}

// MARK: - Wiring helper

struct CoordinatorTestRig {
    let coordinator: SessionCoordinator
    let wake: MockWakeDetector
    let audio: MockAudioCapturing
    let encoder: AudioFrameProducer
    let socket: MockEarSocket
    let cues: MockCuePlayer
    let status: MockStatusController
    let overlay: MockOverlayController

    static func make(deviceId: String = "device-test", startNow: Bool = true) -> CoordinatorTestRig {
        let wake = MockWakeDetector()
        let audio = MockAudioCapturing()
        let encoder = PcmPassthroughEncoder()
        let socket = MockEarSocket()
        let cues = MockCuePlayer()
        let status = MockStatusController()
        let overlay = MockOverlayController()

        let coordinator = SessionCoordinator(
            deviceId: deviceId,
            wake: wake,
            audio: audio,
            encoder: encoder,
            socket: socket,
            cues: cues,
            statusController: status,
            overlay: overlay
        )

        if startNow {
            try! coordinator.start()
        }
        return CoordinatorTestRig(
            coordinator: coordinator,
            wake: wake,
            audio: audio,
            encoder: encoder,
            socket: socket,
            cues: cues,
            status: status,
            overlay: overlay
        )
    }
}
