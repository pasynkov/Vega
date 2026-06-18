import Foundation

// MARK: - Event names (socket.io discriminator)

public enum EventName {
    // Ear → Core
    public static let register = "register"
    public static let wakeDetected = "wake_detected"
    public static let sessionStart = "session_start"
    public static let audioFrame = "audio_frame"
    public static let earSessionEnd = "session_end"
    // Core → Ear
    public static let ack = "ack"
    public static let wakeAck = "wake_ack"
    public static let partialTranscript = "partial_transcript"
    public static let finalTranscript = "final_transcript"
    public static let overlayUpdate = "overlay_update"
    public static let listViewUpdate = "list_view_update"
    public static let sessionMode = "session_mode"
    public static let armCapture = "arm_capture"
    public static let coreSessionEnd = "session_end"
    public static let exception = "exception"
}

// MARK: - Enums

public enum Capability: String, Codable, CaseIterable, Sendable {
    case mic
    case wake
    case speaker
    case display
}

public enum EarEndReason: String, Codable, Sendable {
    case user
    case timeout
    case vad
}

public enum CoreEndReason: String, Codable, Sendable {
    case endpoint
    case timeout
    case sttError = "stt_error"
    case user
}

public enum Cue: String, Codable, Sendable {
    case wake
    case endpoint
    case error
    case ackDone = "ack_done"
    case ackContinue = "ack_continue"
    case ackThinking = "ack_thinking"
    case ackSuccess = "ack_success"
    case ackError = "ack_error"
    case ackUnknown = "ack_unknown"
}

// Cues allowed inside `overlay_update.state.sound`. The `wake` cue is
// played locally and never appears on the wire in this field.
public enum OverlaySound: String, Codable, Sendable {
    case endpoint
    case error
    case ackDone = "ack_done"
    case ackContinue = "ack_continue"
    case ackThinking = "ack_thinking"
    case ackSuccess = "ack_success"
    case ackError = "ack_error"
    case ackUnknown = "ack_unknown"
}

public enum OverlayKind: String, Codable, Sendable {
    case idle
    case listening
    case capturing
    case thinking
    case processing
    case success
    case error
    case view
}

public enum SessionMode: String, Codable, Sendable {
    case regular
    case continuous
}

public enum WakeAction: String, Codable, Sendable {
    case proceed
    case yield
}

public enum Codec: String, Codable, Sendable {
    case linear16
    case opus
}

// MARK: - Ear -> Core event payloads

public struct RegisterMessage: Codable, Sendable, Equatable {
    public let deviceId: String
    public let deviceName: String
    public let capabilities: [Capability]

    public init(deviceId: String, deviceName: String, capabilities: [Capability]) {
        self.deviceId = deviceId
        self.deviceName = deviceName
        self.capabilities = capabilities
    }
}

public struct WakeDetectedMessage: Codable, Sendable, Equatable {
    public let deviceId: String
    public let score: Double
    public let timestamp: String

    public init(deviceId: String, score: Double, timestamp: String) {
        self.deviceId = deviceId
        self.score = score
        self.timestamp = timestamp
    }
}

public struct SessionStartMessage: Codable, Sendable, Equatable {
    public let deviceId: String
    public let sessionId: String
    public let userId: String?
    public let sampleRate: Int
    public let codec: Codec
    public let mode: SessionMode?

    public init(deviceId: String, sessionId: String, userId: String?, sampleRate: Int, codec: Codec, mode: SessionMode? = nil) {
        self.deviceId = deviceId
        self.sessionId = sessionId
        self.userId = userId
        self.sampleRate = sampleRate
        self.codec = codec
        self.mode = mode
    }

    enum CodingKeys: String, CodingKey {
        case deviceId, sessionId, userId, sampleRate, codec, mode
    }

    // Encode `userId` even when nil so the JSON shape matches the TypeScript schema.
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(deviceId, forKey: .deviceId)
        try c.encode(sessionId, forKey: .sessionId)
        if let userId {
            try c.encode(userId, forKey: .userId)
        } else {
            try c.encodeNil(forKey: .userId)
        }
        try c.encode(sampleRate, forKey: .sampleRate)
        try c.encode(codec, forKey: .codec)
        if let mode { try c.encode(mode, forKey: .mode) }
    }
}

public struct EarSessionEndMessage: Codable, Sendable, Equatable {
    public let sessionId: String
    public let reason: EarEndReason

    public init(sessionId: String, reason: EarEndReason) {
        self.sessionId = sessionId
        self.reason = reason
    }
}

// MARK: - Core -> Ear event payloads

public struct AckMessage: Codable, Sendable, Equatable {
    public let deviceId: String

    public init(deviceId: String) {
        self.deviceId = deviceId
    }
}

public struct WakeAckMessage: Codable, Sendable, Equatable {
    public let action: WakeAction

    public init(action: WakeAction) {
        self.action = action
    }
}

public struct PartialTranscriptMessage: Codable, Sendable, Equatable {
    public let sessionId: String
    public let text: String
    public let isFinal: Bool

    public init(sessionId: String, text: String) {
        self.sessionId = sessionId
        self.text = text
        self.isFinal = false
    }
}

public struct FinalTranscriptMessage: Codable, Sendable, Equatable {
    public let sessionId: String
    public let text: String

    public init(sessionId: String, text: String) {
        self.sessionId = sessionId
        self.text = text
    }
}

public struct OverlayState: Codable, Sendable, Equatable {
    public let kind: OverlayKind
    public let hint: String?
    public let caption: String?
    public let sound: OverlaySound?

    public init(kind: OverlayKind, hint: String? = nil, caption: String? = nil, sound: OverlaySound? = nil) {
        self.kind = kind
        self.hint = hint
        self.caption = caption
        self.sound = sound
    }

    enum CodingKeys: String, CodingKey {
        case kind, hint, caption, sound
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(kind, forKey: .kind)
        if let hint { try c.encode(hint, forKey: .hint) }
        if let caption { try c.encode(caption, forKey: .caption) }
        if let sound { try c.encode(sound, forKey: .sound) }
    }
}

public struct OverlayUpdateMessage: Codable, Sendable, Equatable {
    public let seq: Int
    public let state: OverlayState

    public init(seq: Int, state: OverlayState) {
        self.seq = seq
        self.state = state
    }
}

// Raw overlay state used by the tolerance branch when `kind` or `sound`
// is unknown. Preserves whatever text decoded so the Ear can still
// render text alongside a fallback visual.
public struct RawOverlayState: Sendable, Equatable {
    public let rawKind: String
    public let hint: String?
    public let caption: String?
    public let rawSound: String?
}

public struct ListItem: Codable, Sendable, Equatable {
    public let id: String
    public let label: String
    public let done: Bool

    public init(id: String, label: String, done: Bool) {
        self.id = id
        self.label = label
        self.done = done
    }
}

public struct ListView: Codable, Sendable, Equatable {
    public let title: String?
    public let items: [ListItem]
    public let open: Bool

    public init(title: String? = nil, items: [ListItem], open: Bool) {
        self.title = title
        self.items = items
        self.open = open
    }

    enum CodingKeys: String, CodingKey {
        case title, items, open
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        if let title { try c.encode(title, forKey: .title) }
        try c.encode(items, forKey: .items)
        try c.encode(open, forKey: .open)
    }
}

public struct ListViewUpdateMessage: Codable, Sendable, Equatable {
    public let seq: Int
    public let view: ListView

    public init(seq: Int, view: ListView) {
        self.seq = seq
        self.view = view
    }
}

public struct ArmCaptureMessage: Codable, Sendable, Equatable {
    public let mode: SessionMode

    public init(mode: SessionMode) {
        self.mode = mode
    }
}

public struct SessionModeChangeMessage: Codable, Sendable, Equatable {
    public let sessionId: String
    public let mode: SessionMode

    public init(sessionId: String, mode: SessionMode) {
        self.sessionId = sessionId
        self.mode = mode
    }
}

public struct CoreSessionEndMessage: Codable, Sendable, Equatable {
    public let sessionId: String
    public let reason: CoreEndReason
    public let detail: String?

    public init(sessionId: String, reason: CoreEndReason, detail: String? = nil) {
        self.sessionId = sessionId
        self.reason = reason
        self.detail = detail
    }
}

// MARK: - Codec helpers

public enum EarProtocol {
    public static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        return d
    }()

    public static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = []
        return e
    }()
}
