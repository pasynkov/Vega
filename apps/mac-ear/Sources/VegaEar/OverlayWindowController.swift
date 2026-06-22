import AppKit
import EarCore
import EarProtocol
import EarUI
import SwiftUI

// Manages the floating NSPanel that hosts the SwiftUI overlay. The panel:
//   - has no titlebar / shadow / Dock presence (borderless + nonactivating)
//   - sits above app windows and on every space (.floating + multi-space)
//   - ignores mouse events at all times — cancelling is done by going
//     silent (the session closes and the overlay disappears)
//
// Entry metaphor: "drop from tray" — when shown, the panel starts at the
// status-item's bottom edge (hidden behind the menu bar) and translates
// downward over ~220 ms concurrent with opacity 0 → 1. On hide it reverses.
//
// Sizing: the SwiftUI content is hosted in an NSHostingController with
// `sizingOptions = .preferredContentSize`. AppKit auto-resizes the window
// to the SwiftUI content's preferred size as it changes — no manual
// frame fiddling on every overlay update. We just re-anchor the panel's
// top edge after each resize so it doesn't drift down as items appear.
/// NSPanel subclass that anchors its TOP edge whenever AppKit changes
/// content size. Belt-and-suspenders alongside the fixed-size panel +
/// top-anchored SwiftUI root, so any future size change still grows
/// downward instead of jumping up from the bottom.
private final class TopAnchoredPanel: NSPanel {
    override func setContentSize(_ size: NSSize) {
        let oldTop = frame.maxY
        super.setContentSize(size)
        var origin = frame.origin
        origin.y = oldTop - frame.size.height
        setFrameOrigin(origin)
    }
}

/// Top-anchored SwiftUI root. The card hugs the top of the (huge,
/// transparent) panel; a Spacer eats the rest of the height so card
/// growth happens downward inside the same NSWindow frame, never
/// resizing the window itself.
private struct TopAnchoredOverlayRoot: View {
    @ObservedObject var vm: OverlayViewModel
    var body: some View {
        VStack(spacing: 0) {
            OverlayView(vm: vm, layout: .compact)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }
}

@MainActor
final class OverlayWindowController: OverlayControlling {
    let viewModel = OverlayViewModel()
    private let panel: NSPanel
    var anchorFrameProvider: (() -> NSRect?)?

    private var isVisible = false
    private let showDuration: TimeInterval = 0.22
    private let hideDuration: TimeInterval = 0.18

    private let hosting: NSHostingController<TopAnchoredOverlayRoot>
    /// Tall panel that NEVER resizes — content grows inside, anchored
    /// to the top, while the rest of the panel stays transparent.
    /// Width = 376 (card width + padding); height = enough for the
    /// full shopping list + caption pill on the largest expected screen.
    private static let panelSize = NSSize(width: 376, height: 900)

    init() {
        let initialRect = NSRect(origin: .zero, size: Self.panelSize)
        let panel = TopAnchoredPanel(
            contentRect: initialRect,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.level = .floating
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.isMovable = false
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = true
        panel.isReleasedWhenClosed = false
        panel.alphaValue = 0
        self.panel = panel

        let root = TopAnchoredOverlayRoot(vm: viewModel)
        let hosting = NSHostingController(rootView: root)
        // Important: NO sizingOptions. The hosting view fills the entire
        // (fixed) panel; SwiftUI inside it places content at the top with
        // a Spacer below, so growth happens downward inside transparent
        // space rather than by resizing the window.
        self.hosting = hosting
        panel.contentViewController = hosting

        EarUI.Theme.registerFonts()
    }

    // MARK: - OverlayControlling

    nonisolated func showOverlay() {
        DispatchQueue.main.async { self.show() }
    }

    nonisolated func hideOverlay() {
        DispatchQueue.main.async { self.hide() }
    }

    nonisolated func applyOverlayUpdate(_ message: OverlayUpdateMessage) {
        DispatchQueue.main.async {
            self.viewModel.apply(message)
            self.reconcileVisibility()
        }
    }

    nonisolated func applyListViewUpdate(_ message: ListViewUpdateMessage) {
        DispatchQueue.main.async {
            self.viewModel.applyListView(message)
            self.reconcileVisibility()
        }
    }

    nonisolated func setLiveCaption(_ text: String?) {
        DispatchQueue.main.async {
            self.viewModel.setLiveCaption(text)
        }
    }

    /// Show or hide based on the current view-model state. The overlay
    /// should be visible whenever there is something to display:
    /// non-idle kind OR an open list.
    @MainActor
    private func reconcileVisibility() {
        let shouldShow = viewModel.kind != .idle || viewModel.viewOpen
        if shouldShow {
            show()
        } else {
            hide()
        }
    }

    // MARK: - show / hide animations

    private func show() {
        let size = panel.frame.size
        let resting = restingOrigin(size: size)

        if isVisible {
            panel.setFrameOrigin(resting)
            panel.orderFrontRegardless()
            return
        }
        isVisible = true

        if let anchor = anchorFrameProvider?() {
            let start = NSPoint(x: resting.x, y: anchor.minY - size.height + 4)
            panel.setFrameOrigin(start)
            panel.alphaValue = 0
            panel.orderFrontRegardless()
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = showDuration
                ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
                panel.animator().setFrameOrigin(resting)
                panel.animator().alphaValue = 1
            }
        } else {
            panel.setFrameOrigin(resting)
            panel.alphaValue = 0
            panel.orderFrontRegardless()
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = showDuration
                panel.animator().alphaValue = 1
            }
        }
    }

    private func hide() {
        viewModel.hide()
        guard isVisible else { return }
        isVisible = false

        let size = panel.frame.size
        let resting = panel.frame.origin
        let liftedY: CGFloat = {
            if let anchor = anchorFrameProvider?() {
                return anchor.minY - size.height + 4
            }
            return resting.y + 24
        }()

        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = hideDuration
            ctx.timingFunction = CAMediaTimingFunction(name: .easeIn)
            panel.animator().setFrameOrigin(NSPoint(x: resting.x, y: liftedY))
            panel.animator().alphaValue = 0
        }, completionHandler: { [weak self] in
            guard let self else { return }
            self.panel.orderOut(nil)
            self.panel.setFrameOrigin(resting)
        })
    }

    private func restingOrigin(size: NSSize) -> NSPoint {
        let gap: CGFloat = 6
        if let anchor = anchorFrameProvider?() {
            let x = anchor.maxX - size.width
            let y = anchor.minY - size.height - gap
            return clampToScreen(NSPoint(x: x, y: y), size: size)
        }
        guard let screen = NSScreen.main else { return .zero }
        let visible = screen.visibleFrame
        let x = visible.maxX - size.width - 12
        let y = visible.maxY - size.height - gap
        return NSPoint(x: x, y: y)
    }

    private func clampToScreen(_ origin: NSPoint, size: NSSize) -> NSPoint {
        guard let screen = NSScreen.main else { return origin }
        let visible = screen.visibleFrame
        let x = min(max(origin.x, visible.minX + 4), visible.maxX - size.width - 4)
        let y = min(max(origin.y, visible.minY + 4), visible.maxY - size.height - 4)
        return NSPoint(x: x, y: y)
    }
}
