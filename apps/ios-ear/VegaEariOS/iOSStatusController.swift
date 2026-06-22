import EarCore
import Foundation

/// iOS has no menu bar — there's nothing to drive. We keep a published
/// state for diagnostics (logged at debug level) so SessionCoordinator's
/// StatusControlling expectations are met without any UI side-effect.
final class iOSStatusController: StatusControlling {
    private(set) var state: ListeningState = .idle
    private(set) var sessionActive: Bool = false

    func setState(_ state: ListeningState) {
        self.state = state
        NSLog("[VegaEariOS] state → \(state.menuLabel)")
    }

    func setSessionActive(_ active: Bool) {
        sessionActive = active
        NSLog("[VegaEariOS] session active = \(active)")
    }
}
