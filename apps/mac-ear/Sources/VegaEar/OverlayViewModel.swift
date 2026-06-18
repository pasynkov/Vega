import Foundation
import SwiftUI
import EarProtocol

// View-model the SwiftUI overlay observes. Receives `overlay_update`
// and `list_view_update` messages from Core on independent per-channel
// monotonic seq counters; stale messages are dropped.
@MainActor
final class OverlayViewModel: ObservableObject {
    @Published private(set) var kind: OverlayKind = .listening
    @Published private(set) var hint: String? = nil
    @Published private(set) var caption: String? = nil
    @Published private(set) var viewTitle: String? = nil
    @Published private(set) var viewItems: [ListItem] = []
    @Published private(set) var viewOpen: Bool = false
    @Published private(set) var visible: Bool = false

    private var lastOverlaySeq: Int = 0
    private var lastListSeq: Int = 0

    func apply(_ message: OverlayUpdateMessage) {
        if message.seq <= lastOverlaySeq {
            NSLog("[VegaEar] overlay drop stale seq=\(message.seq) last=\(lastOverlaySeq)")
            return
        }
        lastOverlaySeq = message.seq
        applyOrbState(kind: message.state.kind, hint: message.state.hint, caption: message.state.caption)
    }

    func applyUnknown(seq: Int, raw: RawOverlayState) {
        if seq <= lastOverlaySeq { return }
        lastOverlaySeq = seq
        NSLog("[VegaEar] overlay unknown kind=\(raw.rawKind) sound=\(raw.rawSound ?? "nil")")
        applyOrbState(kind: .listening, hint: raw.hint, caption: raw.caption)
    }

    func applyListView(_ message: ListViewUpdateMessage) {
        if message.seq <= lastListSeq {
            NSLog("[VegaEar] listView drop stale seq=\(message.seq) last=\(lastListSeq)")
            return
        }
        lastListSeq = message.seq
        viewTitle = message.view.title
        viewItems = message.view.items
        viewOpen = message.view.open
        refreshVisibility()
    }

    private func applyOrbState(kind: OverlayKind, hint: String?, caption: String?) {
        self.kind = kind
        self.hint = hint
        self.caption = caption
        refreshVisibility()
    }

    private func refreshVisibility() {
        let shouldShow = kind != .idle || viewOpen
        if visible != shouldShow {
            visible = shouldShow
        }
    }

    // Session-end / disconnect → wipe state and reset seq counters.
    func hide() {
        visible = false
        hint = nil
        caption = nil
        viewTitle = nil
        viewItems = []
        viewOpen = false
        lastOverlaySeq = 0
        lastListSeq = 0
    }
}
