import EarCore
import EarProtocol
import Foundation

/// iOS overlay is just the root SwiftUI view bound to OverlayViewModel.
/// SessionCoordinator pushes overlay_update / list_view_update through
/// this thin adapter onto the main thread; SwiftUI does the rest.
final class iOSOverlayController: OverlayControlling {
    let viewModel: OverlayViewModel

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
        DispatchQueue.main.async { self.viewModel.apply(message) }
    }

    func applyListViewUpdate(_ message: ListViewUpdateMessage) {
        DispatchQueue.main.async { self.viewModel.applyListView(message) }
    }
}
