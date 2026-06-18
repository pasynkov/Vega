import Foundation
import SwiftUI
import EarProtocol

// View-model the SwiftUI overlay observes. Receives a series of
// `overlay_update` messages from Core; ignores stale messages (seq
// less than or equal to the last applied seq).
@MainActor
final class OverlayViewModel: ObservableObject {
    @Published private(set) var kind: OverlayKind = .listening
    @Published private(set) var hint: String? = nil
    @Published private(set) var caption: String? = nil
    @Published private(set) var visible: Bool = false

    private var lastSeq: Int = 0

    func apply(_ message: OverlayUpdateMessage) {
        if message.seq <= lastSeq {
            NSLog("[VegaEar] overlay drop stale seq=\(message.seq) last=\(lastSeq)")
            return
        }
        lastSeq = message.seq
        applyState(kind: message.state.kind, hint: message.state.hint, caption: message.state.caption)
    }

    // Tolerance branch — schema decoded an unknown kind/sound; render with
    // a fallback visual but keep whatever text decoded.
    func applyUnknown(seq: Int, raw: RawOverlayState) {
        if seq <= lastSeq { return }
        lastSeq = seq
        NSLog("[VegaEar] overlay unknown kind=\(raw.rawKind) sound=\(raw.rawSound ?? "nil")")
        applyState(kind: .listening, hint: raw.hint, caption: raw.caption)
    }

    private func applyState(kind: OverlayKind, hint: String?, caption: String?) {
        self.kind = kind
        self.hint = hint
        self.caption = caption
        let shouldShow = kind != .idle
        if visible != shouldShow {
            visible = shouldShow
        }
    }

    // Session-end → hide the overlay and reset the seq counter for the
    // next session.
    func hide() {
        visible = false
        hint = nil
        caption = nil
        lastSeq = 0
    }
}
