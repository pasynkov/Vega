import Foundation
import SwiftUI
import EarProtocol

// View-model the SwiftUI overlay observes. Receives `overlay_update`
// and `list_view_update` messages from Core on independent per-channel
// monotonic seq counters; stale messages are dropped.
@MainActor
public final class OverlayViewModel: ObservableObject {
    @Published public private(set) var kind: OverlayKind = .listening
    @Published public private(set) var hint: String? = nil
    @Published public private(set) var caption: String? = nil
    @Published public private(set) var viewTitle: String? = nil
    @Published public private(set) var viewItems: [ListItem] = []
    @Published public private(set) var viewOpen: Bool = false
    @Published public private(set) var visible: Bool = false
    /// Last STT final transcript, sticky across overlay_updates so the
    /// live caption pill keeps showing what the user just said even
    /// after Core sends a state-only overlay update (no caption field).
    @Published public private(set) var liveCaption: String? = nil

    private var lastOverlaySeq: Int = 0
    private var lastListSeq: Int = 0

    public init() {}

    public func apply(_ message: OverlayUpdateMessage) {
        if message.seq <= lastOverlaySeq {
            NSLog("[EarCore] overlay drop stale seq=\(message.seq) last=\(lastOverlaySeq)")
            return
        }
        lastOverlaySeq = message.seq
        applyOrbState(kind: message.state.kind, hint: message.state.hint, caption: message.state.caption)
    }

    public func applyUnknown(seq: Int, raw: RawOverlayState) {
        if seq <= lastOverlaySeq { return }
        lastOverlaySeq = seq
        NSLog("[EarCore] overlay unknown kind=\(raw.rawKind) sound=\(raw.rawSound ?? "nil")")
        applyOrbState(kind: .listening, hint: raw.hint, caption: raw.caption)
    }

    /// Sticky live caption — set from STT final_transcript. Survives
    /// subsequent overlay_updates that don't carry their own caption.
    /// Cleared on `hide()` and when the list view closes.
    public func setLiveCaption(_ text: String?) {
        let trimmed = text?.trimmingCharacters(in: .whitespacesAndNewlines)
        liveCaption = (trimmed?.isEmpty ?? true) ? nil : trimmed
    }

    public func applyListView(_ message: ListViewUpdateMessage) {
        if message.seq <= lastListSeq {
            NSLog("[EarCore] listView drop stale seq=\(message.seq) last=\(lastListSeq)")
            return
        }
        lastListSeq = message.seq
        viewTitle = message.view.title
        viewItems = message.view.items
        viewOpen = message.view.open
        if !message.view.open { liveCaption = nil }
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
    public func hide() {
        visible = false
        hint = nil
        caption = nil
        viewTitle = nil
        viewItems = []
        viewOpen = false
        liveCaption = nil
        lastOverlaySeq = 0
        lastListSeq = 0
    }
}
