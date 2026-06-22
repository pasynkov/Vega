import Foundation
import EarProtocol

// MARK: - Cues

/// Named audio cues the Ear plays at session boundaries and overlay
/// transitions. The actual sound resolution is platform-specific and
/// lives in the host shell (macOS uses system /System/Library/Sounds,
/// iOS uses bundled assets), so this enum only names the event.
public enum CueSound: String, Sendable {
    case wake
    case endpoint
    case error
    case ackDone
    case ackContinue
    case ackThinking
    case ackSuccess
    case ackError
    case ackUnknown
    case cueListen
}

/// Plays a named cue. Implementations are platform-specific.
public protocol CuePlaying: AnyObject {
    func play(_ cue: CueSound)
}

// MARK: - Status

/// High-level state surfaced to the menu-bar (macOS) or app shell (iOS).
public enum ListeningState: Equatable, Sendable {
    case idle
    case listening
    case streaming
    case error(String)
    case disabled

    public var menuLabel: String {
        switch self {
        case .idle: return "State: idle (listening for wake)"
        case .listening: return "State: listening"
        case .streaming: return "State: streaming"
        case .error(let msg): return "Error: \(msg)"
        case .disabled: return "State: paused"
        }
    }

    public var iconSymbol: String {
        switch self {
        case .idle: return "ear"
        case .listening: return "waveform"
        case .streaming: return "waveform.circle.fill"
        case .error: return "exclamationmark.triangle.fill"
        case .disabled: return "pause.circle"
        }
    }
}

public struct WakeThresholdPreset: Sendable {
    public let label: String
    public let value: Double

    public init(label: String, value: Double) {
        self.label = label
        self.value = value
    }
}

public let wakeThresholdPresets: [WakeThresholdPreset] = [
    WakeThresholdPreset(label: "Low (0.3)", value: 0.3),
    WakeThresholdPreset(label: "Default (0.5)", value: 0.5),
    WakeThresholdPreset(label: "High (0.7)", value: 0.7),
    WakeThresholdPreset(label: "Very High (0.85)", value: 0.85),
]

public protocol StatusControlling: AnyObject {
    func setState(_ state: ListeningState)
    func setSessionActive(_ active: Bool)
}

// MARK: - Overlay

/// Surface SessionCoordinator depends on. Implementations marshal to
/// the appropriate UI thread internally so callers don't need to know.
public protocol OverlayControlling: AnyObject {
    func showOverlay()
    func hideOverlay()
    func applyOverlayUpdate(_ message: OverlayUpdateMessage)
    func applyListViewUpdate(_ message: ListViewUpdateMessage)
    /// Sticky transcript text from STT (`final_transcript`).
    /// Implementations forward this into `OverlayViewModel.setLiveCaption`.
    func setLiveCaption(_ text: String?)
    /// Notify the overlay layer that the socket connection state to Core
    /// changed. Mac shell ignores this (status item is the indicator);
    /// iOS shell uses it to paint a baseline "always listening" overlay
    /// while connected, and a blank screen when disconnected.
    func setConnected(_ connected: Bool)
}

public extension OverlayControlling {
    func setLiveCaption(_ text: String?) {}
    func setConnected(_ connected: Bool) {}
}

// MARK: - Audio capture

public protocol AudioCapturing: AnyObject {
    typealias PCMSink = (Data) -> Void
    var currentSampleRate: Double { get }
    func addSink(_ sink: @escaping PCMSink)
    func start() throws
    func stop()
}
