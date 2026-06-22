import Foundation
import EarProtocol
@testable import EarCore

// OverlayControlling adapter for journey-tests. Records the raw messages
// (like MockOverlayController) AND forwards them into a real
// `OverlayViewModel` so tests can assert the union of "what the
// coordinator emitted" + "what the view-model now displays".
//
// OverlayViewModel is `@MainActor`. Journey tests are themselves
// `@MainActor`, so when SessionCoordinator (running on the test
// thread = main thread) invokes the protocol method, we are already
// on the main actor and can forward synchronously without a dispatch
// hop via `MainActor.assumeIsolated`. The real shells (mac/iOS) use
// `DispatchQueue.main.async` because they are called from arbitrary
// threads; tests don't have that constraint.
@available(macOS 14, iOS 17, *)
final class JourneyOverlayController: OverlayControlling {
    let viewModel: OverlayViewModel

    private(set) var overlayUpdates: [OverlayUpdateMessage] = []
    private(set) var listViewUpdates: [ListViewUpdateMessage] = []
    private(set) var liveCaptions: [String?] = []
    private(set) var connectedStates: [Bool] = []
    private(set) var showCount = 0
    private(set) var hideCount = 0

    init(viewModel: OverlayViewModel) {
        self.viewModel = viewModel
    }

    func showOverlay() { showCount += 1 }

    func hideOverlay() {
        hideCount += 1
        forwardToViewModel { vm in vm.hide() }
    }

    func applyOverlayUpdate(_ message: OverlayUpdateMessage) {
        overlayUpdates.append(message)
        forwardToViewModel { vm in vm.apply(message) }
    }

    func applyListViewUpdate(_ message: ListViewUpdateMessage) {
        listViewUpdates.append(message)
        forwardToViewModel { vm in vm.applyListView(message) }
    }

    func setLiveCaption(_ text: String?) {
        liveCaptions.append(text)
        forwardToViewModel { vm in vm.setLiveCaption(text) }
    }

    func setConnected(_ connected: Bool) {
        connectedStates.append(connected)
    }

    // OverlayViewModel is @MainActor. We rely on tests running on the
    // main thread (XCTest default) so we can call its methods directly.
    // A runtime precondition keeps the contract honest if a future
    // test path triggers this controller off-main.
    private func forwardToViewModel(_ block: @MainActor (OverlayViewModel) -> Void) {
        precondition(Thread.isMainThread, "JourneyOverlayController must be invoked on the main thread")
        MainActor.assumeIsolated { block(viewModel) }
    }
}

// Wiring helper analogous to `CoordinatorTestRig` but plugged into a
// real OverlayViewModel via JourneyOverlayController. Exposed as
// `vm` for direct assertions.
@available(macOS 14, iOS 17, *)
struct CoordinatorJourneyRig {
    let coordinator: SessionCoordinator
    let wake: MockWakeDetector
    let audio: MockAudioCapturing
    let encoder: AudioFrameProducer
    let socket: MockEarSocket
    let cues: MockCuePlayer
    let status: MockStatusController
    let overlay: JourneyOverlayController
    let vm: OverlayViewModel

    @MainActor
    static func make(deviceId: String = "device-test", startNow: Bool = true) -> CoordinatorJourneyRig {
        let wake = MockWakeDetector()
        let audio = MockAudioCapturing()
        let encoder = PcmPassthroughEncoder()
        let socket = MockEarSocket()
        let cues = MockCuePlayer()
        let status = MockStatusController()
        let viewModel = OverlayViewModel()
        let overlay = JourneyOverlayController(viewModel: viewModel)

        let coordinator = SessionCoordinator(
            deviceId: deviceId,
            wake: wake,
            audio: audio,
            encoder: encoder,
            socket: socket,
            cues: cues,
            statusController: status,
            overlay: overlay
        )

        if startNow {
            try! coordinator.start()
        }
        return CoordinatorJourneyRig(
            coordinator: coordinator,
            wake: wake,
            audio: audio,
            encoder: encoder,
            socket: socket,
            cues: cues,
            status: status,
            overlay: overlay,
            vm: viewModel
        )
    }
}
