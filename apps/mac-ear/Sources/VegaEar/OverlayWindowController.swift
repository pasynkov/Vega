import AppKit
import SwiftUI

// Manages the floating NSPanel that hosts the SwiftUI overlay. The panel:
//   - has no titlebar / shadow / Dock presence (borderless + nonactivating)
//   - sits above app windows and on every space (.floating + multi-space)
//   - ignores mouse events at all times — cancelling is done by going
//     silent (the session closes and the overlay disappears)
@MainActor
final class OverlayWindowController {
    let viewModel = OverlayViewModel()
    private let panel: NSPanel
    // Provides the screen-coordinate frame of the menu-bar status item
    // button so the overlay can anchor under it. Returns nil before the
    // status item is laid out; we fall back to top-right corner.
    var anchorFrameProvider: (() -> NSRect?)?

    init() {
        let initialRect = NSRect(x: 0, y: 0, width: 320, height: 220)
        let panel = NSPanel(
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
        self.panel = panel

        let host = NSHostingView(rootView: OverlayView(vm: viewModel))
        host.translatesAutoresizingMaskIntoConstraints = true
        host.frame = panel.contentLayoutRect
        host.autoresizingMask = [.width, .height]
        panel.contentView = host
        positionUnderStatusItem()
    }

    func show() {
        positionUnderStatusItem()
        panel.orderFrontRegardless()
    }

    // Anchor the overlay so its top-right corner sits just below the
    // status item — reads as a dropdown from the tray icon. If the
    // status-item frame is not available yet, fall back to the top-right
    // corner of the main screen.
    private func positionUnderStatusItem() {
        let size = panel.frame.size
        let gap: CGFloat = 6
        if let anchor = anchorFrameProvider?() {
            // anchor is in screen coords; origin = anchor's bottom-left.
            // Place the overlay's top-right under the anchor's bottom-right.
            let x = anchor.maxX - size.width
            let y = anchor.minY - size.height - gap
            panel.setFrameOrigin(clampToScreen(NSPoint(x: x, y: y), size: size))
            return
        }
        guard let screen = NSScreen.main else { return }
        let visible = screen.visibleFrame
        let x = visible.maxX - size.width - 12
        let y = visible.maxY - size.height - gap
        panel.setFrameOrigin(NSPoint(x: x, y: y))
    }

    private func clampToScreen(_ origin: NSPoint, size: NSSize) -> NSPoint {
        guard let screen = NSScreen.main else { return origin }
        let visible = screen.visibleFrame
        let x = min(max(origin.x, visible.minX + 4), visible.maxX - size.width - 4)
        let y = min(max(origin.y, visible.minY + 4), visible.maxY - size.height - 4)
        return NSPoint(x: x, y: y)
    }
}
