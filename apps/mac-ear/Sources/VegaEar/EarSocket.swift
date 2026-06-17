import Foundation
import EarProtocol

final class EarSocket {
    typealias MessageHandler = (CoreToEarMessage) -> Void
    typealias StatusHandler = (Bool) -> Void

    private let url: URL
    private let deviceId: String
    private let deviceName: String
    private let session: URLSession
    private var task: URLSessionWebSocketTask?

    // Exponential backoff with jitter. Reset only after the connection is
    // confirmed by Core's `ack` to the `register` message — otherwise an
    // immediately-rejected handshake would loop tight at 1 s.
    private var reconnectDelay: TimeInterval = 1
    private let initialReconnectDelay: TimeInterval = 1
    private let maxReconnectDelay: TimeInterval = 30
    private var stopped = false
    private var registerAcked = false
    private var attempt = 0

    var onMessage: MessageHandler?
    var onStatusChange: StatusHandler?

    init(url: URL, deviceId: String, deviceName: String) {
        self.url = url
        self.deviceId = deviceId
        self.deviceName = deviceName
        self.session = URLSession(configuration: .default)
    }

    func connect() {
        stopped = false
        openTask()
    }

    func disconnect() {
        stopped = true
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        onStatusChange?(false)
    }

    func sendJSON<T: Encodable>(_ message: T) {
        guard let task else { return }
        do {
            let data = try EarProtocol.encoder.encode(message)
            guard let text = String(data: data, encoding: .utf8) else { return }
            task.send(.string(text)) { error in
                if let error {
                    NSLog("[VegaEar] WS send error: \(error)")
                }
            }
        } catch {
            NSLog("[VegaEar] WS encode error: \(error)")
        }
    }

    func sendAudio(sessionId: String, opusFrame: Data) {
        guard let task else { return }
        let framed = AudioFrame.encode(sessionId: sessionId, payload: opusFrame)
        task.send(.data(framed)) { error in
            if let error {
                NSLog("[VegaEar] WS binary send error: \(error)")
            }
        }
    }

    private func openTask() {
        attempt += 1
        registerAcked = false
        NSLog("[VegaEar] WS connect attempt #\(attempt) to \(url)")

        let task = session.webSocketTask(with: url)
        self.task = task
        task.resume()
        onStatusChange?(true)

        let register = RegisterMessage(
            deviceId: deviceId,
            deviceName: deviceName,
            capabilities: [.mic, .wake, .speaker]
        )
        sendJSON(register)

        listen(task)
    }

    private func listen(_ task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure(let error):
                NSLog("[VegaEar] WS receive failed: \(error.localizedDescription)")
                self.onStatusChange?(false)
                self.scheduleReconnect()
            case .success(let message):
                switch message {
                case .data(let data):
                    self.dispatch(data: data)
                case .string(let str):
                    if let data = str.data(using: .utf8) {
                        self.dispatch(data: data)
                    }
                @unknown default:
                    break
                }
                self.listen(task)
            }
        }
    }

    private func dispatch(data: Data) {
        do {
            let decoded = try EarProtocol.decodeCoreToEar(data)
            // Mark connection healthy on the first `ack` to register so the
            // backoff resets only after Core confirmed the handshake.
            if case .ack = decoded, !registerAcked {
                registerAcked = true
                let attemptCount = attempt
                reconnectDelay = initialReconnectDelay
                NSLog("[VegaEar] WS healthy after attempt #\(attemptCount), backoff reset")
            }
            onMessage?(decoded)
        } catch {
            NSLog("[VegaEar] WS decode error: \(error) — payload=\(String(data: data, encoding: .utf8) ?? "?")")
        }
    }

    private func scheduleReconnect() {
        guard !stopped else { return }
        // Jitter ±25 % so multiple Ears (or a flapping Core) don't synchronise
        // their retry storms.
        let jitter = Double.random(in: 0.75...1.25)
        let delay = reconnectDelay * jitter
        let nextDelay = min(maxReconnectDelay, reconnectDelay * 2)
        NSLog(String(format: "[VegaEar] WS reconnect in %.1fs (next backoff %.1fs)", delay, nextDelay))
        reconnectDelay = nextDelay
        DispatchQueue.global().asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, !self.stopped else { return }
            self.openTask()
        }
    }
}
