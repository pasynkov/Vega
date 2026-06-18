import Foundation

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

// MARK: - Ear -> Core messages

public struct RegisterMessage: Codable, Sendable, Equatable {
    public let type: String
    public let deviceId: String
    public let deviceName: String
    public let capabilities: [Capability]

    public init(deviceId: String, deviceName: String, capabilities: [Capability]) {
        self.type = "register"
        self.deviceId = deviceId
        self.deviceName = deviceName
        self.capabilities = capabilities
    }
}

public struct WakeDetectedMessage: Codable, Sendable, Equatable {
    public let type: String
    public let deviceId: String
    public let score: Double
    public let timestamp: String

    public init(deviceId: String, score: Double, timestamp: String) {
        self.type = "wake_detected"
        self.deviceId = deviceId
        self.score = score
        self.timestamp = timestamp
    }
}

public struct SessionStartMessage: Codable, Sendable, Equatable {
    public let type: String
    public let deviceId: String
    public let sessionId: String
    public let userId: String?
    public let sampleRate: Int
    public let codec: Codec
    public let mode: SessionMode?

    public init(deviceId: String, sessionId: String, userId: String?, sampleRate: Int, codec: Codec, mode: SessionMode? = nil) {
        self.type = "session_start"
        self.deviceId = deviceId
        self.sessionId = sessionId
        self.userId = userId
        self.sampleRate = sampleRate
        self.codec = codec
        self.mode = mode
    }

    // Encode `userId` even when nil so the JSON shape matches the TypeScript schema.
    enum CodingKeys: String, CodingKey {
        case type, deviceId, sessionId, userId, sampleRate, codec, mode
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(type, forKey: .type)
        try c.encode(deviceId, forKey: .deviceId)
        try c.encode(sessionId, forKey: .sessionId)
        // Explicit null when nil
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
    public let type: String
    public let sessionId: String
    public let reason: EarEndReason

    public init(sessionId: String, reason: EarEndReason) {
        self.type = "session_end"
        self.sessionId = sessionId
        self.reason = reason
    }
}

// MARK: - Core -> Ear messages

public struct AckMessage: Codable, Sendable, Equatable {
    public let type: String
    public let deviceId: String

    public init(deviceId: String) {
        self.type = "ack"
        self.deviceId = deviceId
    }
}

public struct WakeAckMessage: Codable, Sendable, Equatable {
    public let type: String
    public let action: WakeAction

    public init(action: WakeAction) {
        self.type = "wake_ack"
        self.action = action
    }
}

public struct PartialTranscriptMessage: Codable, Sendable, Equatable {
    public let type: String
    public let sessionId: String
    public let text: String
    public let isFinal: Bool

    public init(sessionId: String, text: String) {
        self.type = "partial_transcript"
        self.sessionId = sessionId
        self.text = text
        self.isFinal = false
    }
}

public struct FinalTranscriptMessage: Codable, Sendable, Equatable {
    public let type: String
    public let sessionId: String
    public let text: String

    public init(sessionId: String, text: String) {
        self.type = "final_transcript"
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
    public let type: String
    public let seq: Int
    public let state: OverlayState

    public init(seq: Int, state: OverlayState) {
        self.type = "overlay_update"
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

public struct ArmCaptureMessage: Codable, Sendable, Equatable {
    public let type: String
    public let mode: SessionMode

    public init(mode: SessionMode) {
        self.type = "arm_capture"
        self.mode = mode
    }
}

public struct SessionModeChangeMessage: Codable, Sendable, Equatable {
    public let type: String
    public let sessionId: String
    public let mode: SessionMode

    public init(sessionId: String, mode: SessionMode) {
        self.type = "session_mode"
        self.sessionId = sessionId
        self.mode = mode
    }
}

public struct CoreSessionEndMessage: Codable, Sendable, Equatable {
    public let type: String
    public let sessionId: String
    public let reason: CoreEndReason
    public let detail: String?

    public init(sessionId: String, reason: CoreEndReason, detail: String? = nil) {
        self.type = "session_end"
        self.sessionId = sessionId
        self.reason = reason
        self.detail = detail
    }
}

// MARK: - Discriminated unions

public enum EarToCoreMessage: Sendable, Equatable {
    case register(RegisterMessage)
    case wakeDetected(WakeDetectedMessage)
    case sessionStart(SessionStartMessage)
    case sessionEnd(EarSessionEndMessage)

    public func encode() throws -> Data {
        let encoder = JSONEncoder()
        switch self {
        case .register(let m): return try encoder.encode(m)
        case .wakeDetected(let m): return try encoder.encode(m)
        case .sessionStart(let m): return try encoder.encode(m)
        case .sessionEnd(let m): return try encoder.encode(m)
        }
    }
}

public enum CoreToEarMessage: Sendable, Equatable {
    case ack(AckMessage)
    case wakeAck(WakeAckMessage)
    case partialTranscript(PartialTranscriptMessage)
    case finalTranscript(FinalTranscriptMessage)
    case overlayUpdate(OverlayUpdateMessage)
    case sessionMode(SessionModeChangeMessage)
    case armCapture(ArmCaptureMessage)
    case sessionEnd(CoreSessionEndMessage)
    case unknownOverlay(seq: Int, raw: RawOverlayState)
    case unknownSessionMode(rawMode: String)
}

// MARK: - Decoding helpers

public enum EarProtocolError: Error {
    case unknownMessageType(String)
}

public struct EarProtocol {
    public static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        return d
    }()

    public static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        // Preserve key order so round-trip tests are deterministic.
        e.outputFormatting = []
        return e
    }()

    public static func decodeEarToCore(_ data: Data) throws -> EarToCoreMessage {
        let envelope = try decoder.decode(MessageEnvelope.self, from: data)
        switch envelope.type {
        case "register":
            return .register(try decoder.decode(RegisterMessage.self, from: data))
        case "wake_detected":
            return .wakeDetected(try decoder.decode(WakeDetectedMessage.self, from: data))
        case "session_start":
            return .sessionStart(try decoder.decode(SessionStartMessage.self, from: data))
        case "session_end":
            return .sessionEnd(try decoder.decode(EarSessionEndMessage.self, from: data))
        default:
            throw EarProtocolError.unknownMessageType(envelope.type)
        }
    }

    public static func decodeCoreToEar(_ data: Data) throws -> CoreToEarMessage {
        let envelope = try decoder.decode(MessageEnvelope.self, from: data)
        switch envelope.type {
        case "ack":
            return .ack(try decoder.decode(AckMessage.self, from: data))
        case "wake_ack":
            return .wakeAck(try decoder.decode(WakeAckMessage.self, from: data))
        case "partial_transcript":
            return .partialTranscript(try decoder.decode(PartialTranscriptMessage.self, from: data))
        case "final_transcript":
            return .finalTranscript(try decoder.decode(FinalTranscriptMessage.self, from: data))
        case "overlay_update":
            // Tolerate unknown overlay kind/sound values so a newer Core
            // does not break the WS. Keep whatever text decoded.
            do {
                return .overlayUpdate(try decoder.decode(OverlayUpdateMessage.self, from: data))
            } catch {
                struct RawOverlayEnvelope: Decodable {
                    let seq: Int
                    let state: RawState
                    struct RawState: Decodable {
                        let kind: String
                        let hint: String?
                        let caption: String?
                        let sound: String?
                    }
                }
                if let raw = try? decoder.decode(RawOverlayEnvelope.self, from: data) {
                    return .unknownOverlay(
                        seq: raw.seq,
                        raw: RawOverlayState(
                            rawKind: raw.state.kind,
                            hint: raw.state.hint,
                            caption: raw.state.caption,
                            rawSound: raw.state.sound
                        )
                    )
                }
                throw error
            }
        case "session_mode":
            do {
                return .sessionMode(try decoder.decode(SessionModeChangeMessage.self, from: data))
            } catch {
                struct RawMode: Decodable { let mode: String }
                if let raw = try? decoder.decode(RawMode.self, from: data) {
                    return .unknownSessionMode(rawMode: raw.mode)
                }
                throw error
            }
        case "arm_capture":
            return .armCapture(try decoder.decode(ArmCaptureMessage.self, from: data))
        case "session_end":
            return .sessionEnd(try decoder.decode(CoreSessionEndMessage.self, from: data))
        default:
            throw EarProtocolError.unknownMessageType(envelope.type)
        }
    }

    private struct MessageEnvelope: Decodable {
        let type: String
    }
}

// MARK: - Binary `audio_frame` encoding

public enum AudioFrame {
    public static let headerSize: Int = 8

    public static func sessionShortId(fromUuid uuid: String) -> UInt64 {
        let hex = uuid.replacingOccurrences(of: "-", with: "")
        precondition(hex.count == 32, "invalid UUID: \(uuid)")
        var result: UInt64 = 0
        for i in stride(from: 7, through: 0, by: -1) {
            let start = hex.index(hex.startIndex, offsetBy: i * 2)
            let end = hex.index(start, offsetBy: 2)
            let byte = UInt64(hex[start..<end], radix: 16) ?? 0
            result = (result << 8) | byte
        }
        return result
    }

    public static func encode(sessionId: String, payload: Data) -> Data {
        var out = Data(count: headerSize + payload.count)
        var shortId = sessionShortId(fromUuid: sessionId).littleEndian
        withUnsafeBytes(of: &shortId) { src in
            out.replaceSubrange(0..<headerSize, with: src)
        }
        out.replaceSubrange(headerSize..<out.count, with: payload)
        return out
    }

    public static func decode(_ data: Data) throws -> (sessionShortId: UInt64, payload: Data) {
        guard data.count >= headerSize else {
            throw EarProtocolError.unknownMessageType("audio_frame too short")
        }
        let headerBytes = data.prefix(headerSize)
        let shortId = headerBytes.withUnsafeBytes { raw -> UInt64 in
            raw.load(as: UInt64.self).littleEndian
        }
        let payload = data.suffix(from: headerSize)
        return (shortId, Data(payload))
    }
}
