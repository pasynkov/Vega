import Foundation
import EarProtocol
import SocketIO

// Per-event handlers — replaces the prior single discriminated-union
// dispatch. Each Core → Ear event has its own callback; SessionCoordinator
// supplies the implementations.
public struct EarSocketHandlers {
    public var onAck: (AckMessage) -> Void = { _ in }
    public var onWakeAck: (WakeAckMessage) -> Void = { _ in }
    public var onPartialTranscript: (PartialTranscriptMessage) -> Void = { _ in }
    public var onFinalTranscript: (FinalTranscriptMessage) -> Void = { _ in }
    public var onOverlayUpdate: (OverlayUpdateMessage) -> Void = { _ in }
    public var onListViewUpdate: (ListViewUpdateMessage) -> Void = { _ in }
    public var onArmCapture: (ArmCaptureMessage) -> Void = { _ in }
    public var onSessionMode: (SessionModeChangeMessage) -> Void = { _ in }
    public var onSessionEnd: (CoreSessionEndMessage) -> Void = { _ in }
    public var onException: (String) -> Void = { _ in }
    public init() {}
}

public protocol EarSocketing: AnyObject {
    var handlers: EarSocketHandlers { get set }
    var onStatusChange: ((Bool) -> Void)? { get set }
    func connect()
    func disconnect()
    func emit<T: Encodable>(_ event: String, _ payload: T)
    func emitAudio(sessionId: String, pcm: Data)
}

public final class EarSocket: EarSocketing {
    public typealias StatusHandler = (Bool) -> Void

    private let url: URL
    private let deviceId: String
    private let deviceName: String
    private let capabilities: [Capability]
    private let manager: SocketManager
    private let socket: SocketIOClient
    private var registerAcked = false

    public var handlers = EarSocketHandlers()
    public var onStatusChange: StatusHandler?

    public init(url: URL, deviceId: String, deviceName: String, capabilities: [Capability] = [.mic, .wake, .speaker]) {
        self.url = url
        self.deviceId = deviceId
        self.deviceName = deviceName
        self.capabilities = capabilities
        self.manager = SocketManager(
            socketURL: url,
            config: [
                .forceWebsockets(true),
                .reconnects(true),
                .reconnectAttempts(-1),
                .reconnectWait(1),
                .reconnectWaitMax(30),
                .randomizationFactor(0.25),
                .log(false),
            ]
        )
        self.socket = manager.socket(forNamespace: "/ear")
        configureLifecycleHandlers()
        configureEventHandlers()
    }

    public func connect() {
        // Connecting on the namespace-socket (not manager.connect())
        // is what actually joins `/ear`. manager.connect() would only
        // join the default `/` namespace.
        socket.connect()
    }

    public func disconnect() {
        socket.disconnect()
        manager.disconnect()
        onStatusChange?(false)
    }

    public func emit<T: Encodable>(_ event: String, _ payload: T) {
        do {
            let data = try EarProtocol.encoder.encode(payload)
            guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
            socket.emit(event, json)
        } catch {
            NSLog("[EarCore] socket emit encode error: \(error)")
        }
    }

    public func emitAudio(sessionId: String, pcm: Data) {
        // socket.io-client-swift accepts `Data` as a binary attachment.
        socket.emit("audio_frame", sessionId, pcm)
    }

    private func configureLifecycleHandlers() {
        socket.on(clientEvent: .connect) { [weak self] _, _ in
            guard let self else { return }
            NSLog("[EarCore] socket.io connected to \(self.url)")
            self.onStatusChange?(true)
            self.registerAcked = false
            let register = RegisterMessage(
                deviceId: self.deviceId,
                deviceName: self.deviceName,
                capabilities: self.capabilities
            )
            self.emit(EventName.register, register)
        }
        socket.on(clientEvent: .disconnect) { [weak self] _, _ in
            NSLog("[EarCore] socket.io disconnected")
            self?.onStatusChange?(false)
        }
        socket.on(clientEvent: .reconnect) { _, _ in
            NSLog("[EarCore] socket.io reconnecting")
        }
        // socket.io-client-swift doesn't fire .disconnect on raw TCP
        // RST — we hear about it only via .reconnectAttempt / .error.
        // Surface either as a disconnected status so the UI clears
        // before the reconnect loop catches up.
        socket.on(clientEvent: .reconnectAttempt) { [weak self] _, _ in
            NSLog("[EarCore] socket.io reconnect attempt — reporting disconnect")
            self?.onStatusChange?(false)
        }
        socket.on(clientEvent: .error) { [weak self] data, _ in
            // socket.io-client-swift `.error` data carries a free-form
            // payload; print only the textual / dictionary parts so we
            // don't flood the log with SocketAckEmitter pointer descs.
            let textual = data.compactMap { item -> String? in
                if let s = item as? String { return s }
                if let d = item as? [String: Any] { return "\(d)" }
                if let e = item as? Error { return e.localizedDescription }
                return nil
            }
            if !textual.isEmpty {
                NSLog("[EarCore] socket.io error: \(textual.joined(separator: " | "))")
            }
            self?.onStatusChange?(false)
        }
    }

    private func configureEventHandlers() {
        bindCodable(EventName.ack, AckMessage.self) { [weak self] msg in
            guard let self else { return }
            if !self.registerAcked {
                self.registerAcked = true
                NSLog("[EarCore] socket.io healthy — ack received")
            }
            self.handlers.onAck(msg)
        }
        bindCodable(EventName.wakeAck, WakeAckMessage.self) { [weak self] msg in
            self?.handlers.onWakeAck(msg)
        }
        bindCodable(EventName.partialTranscript, PartialTranscriptMessage.self) { [weak self] msg in
            self?.handlers.onPartialTranscript(msg)
        }
        bindCodable(EventName.finalTranscript, FinalTranscriptMessage.self) { [weak self] msg in
            self?.handlers.onFinalTranscript(msg)
        }
        bindCodable(EventName.overlayUpdate, OverlayUpdateMessage.self) { [weak self] msg in
            self?.handlers.onOverlayUpdate(msg)
        }
        bindCodable(EventName.listViewUpdate, ListViewUpdateMessage.self) { [weak self] msg in
            self?.handlers.onListViewUpdate(msg)
        }
        bindCodable(EventName.armCapture, ArmCaptureMessage.self) { [weak self] msg in
            self?.handlers.onArmCapture(msg)
        }
        bindCodable(EventName.sessionMode, SessionModeChangeMessage.self) { [weak self] msg in
            self?.handlers.onSessionMode(msg)
        }
        bindCodable(EventName.coreSessionEnd, CoreSessionEndMessage.self) { [weak self] msg in
            self?.handlers.onSessionEnd(msg)
        }
        socket.on(EventName.exception) { [weak self] data, _ in
            let desc = (data.first as? [String: Any])?.description ?? "unknown"
            NSLog("[EarCore] gateway exception: \(desc)")
            self?.handlers.onException(desc)
        }
    }

    private func bindCodable<T: Decodable>(
        _ event: String,
        _ type: T.Type,
        handler: @escaping (T) -> Void
    ) {
        socket.on(event) { data, _ in
            guard let first = data.first else { return }
            do {
                let raw = try JSONSerialization.data(withJSONObject: first)
                let decoded = try EarProtocol.decoder.decode(T.self, from: raw)
                handler(decoded)
            } catch {
                NSLog("[EarCore] decode error for event \(event): \(error)")
            }
        }
    }
}
