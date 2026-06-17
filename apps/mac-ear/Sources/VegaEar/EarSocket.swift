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
    private var reconnectDelay: TimeInterval = 1
    private let maxReconnectDelay: TimeInterval = 30
    private var stopped = false

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
        let task = session.webSocketTask(with: url)
        self.task = task
        task.resume()
        reconnectDelay = 1
        onStatusChange?(true)

        // Send register immediately.
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
                NSLog("[VegaEar] WS receive failed: \(error)")
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
            onMessage?(decoded)
        } catch {
            NSLog("[VegaEar] WS decode error: \(error) — payload=\(String(data: data, encoding: .utf8) ?? "?")")
        }
    }

    private func scheduleReconnect() {
        guard !stopped else { return }
        let delay = reconnectDelay
        reconnectDelay = min(maxReconnectDelay, reconnectDelay * 2)
        DispatchQueue.global().asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, !self.stopped else { return }
            self.openTask()
        }
    }
}
