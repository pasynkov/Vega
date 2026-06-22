import EarCore
import EarProtocol
import Foundation

/// iOS overlay is just the root SwiftUI view bound to OverlayViewModel.
/// SessionCoordinator pushes overlay_update / list_view_update through
/// this thin adapter onto the main thread; SwiftUI does the rest.
final class iOSOverlayController: OverlayControlling {
    let viewModel: OverlayViewModel
    private var isConnected: Bool = false

    init(viewModel: OverlayViewModel) {
        self.viewModel = viewModel
    }

    func showOverlay() {
        // iOS full-screen overlay is always present; no explicit show.
    }

    func hideOverlay() {
        DispatchQueue.main.async { self.viewModel.hide() }
    }

    func applyOverlayUpdate(_ message: OverlayUpdateMessage) {
        DispatchQueue.main.async {
            self.viewModel.apply(message)
            // When Core says "idle" but we're still connected, drop back
            // to the local always-listening baseline. This works for
            // both:
            //  • no list open → big listening orb (mic-on indicator)
            //  • list open    → list stays with live lens in the title,
            //                   STT pill stays visible
            // Without this the screen would go blank after every ack.
            if message.state.kind == .idle, self.isConnected {
                self.viewModel.setLocalBaseline(kind: .listening)
            }
        }
    }

    func applyListViewUpdate(_ message: ListViewUpdateMessage) {
        DispatchQueue.main.async { self.viewModel.applyListView(message) }
    }

    func setConnected(_ connected: Bool) {
        DispatchQueue.main.async {
            self.isConnected = connected
            if connected {
                // Local-only baseline; does NOT advance lastOverlaySeq,
                // so Core's first overlay_update (seq=1 after rebind)
                // is still accepted.
                self.viewModel.setLocalBaseline(kind: .listening)
            } else {
                self.viewModel.hide()
            }
        }
    }
}
