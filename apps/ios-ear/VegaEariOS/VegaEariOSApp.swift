import SwiftUI
import EarCore
import EarUI

@main
struct VegaEariOSApp: App {
    @StateObject private var coordinator = AppCoordinator()

    var body: some Scene {
        WindowGroup {
            ContentView(viewModel: coordinator.overlayViewModel)
                .background(Theme.background.ignoresSafeArea())
                .preferredColorScheme(.dark)
                .statusBarHidden(coordinator.overlayViewModel.kind != .idle)
                .onAppear {
                    Theme.registerFonts()
                    coordinator.start()
                }
                .onReceive(
                    NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)
                ) { _ in
                    coordinator.handleDidBecomeActive()
                }
                .onReceive(
                    NotificationCenter.default.publisher(for: UIApplication.willResignActiveNotification)
                ) { _ in
                    coordinator.handleWillResignActive()
                }
        }
    }
}

struct ContentView: View {
    @ObservedObject var viewModel: OverlayViewModel
    #if DEBUG
    @State private var timer: Timer? = nil
    #endif

    var body: some View {
        OverlayView(vm: viewModel, layout: .fullScreen)
            #if DEBUG
            .onTapGesture { DebugStateCycler.next(into: viewModel) }
            .onAppear {
                timer = Timer.scheduledTimer(withTimeInterval: 4.0, repeats: true) { _ in
                    Task { @MainActor in DebugStateCycler.next(into: viewModel) }
                }
            }
            #endif
    }
}

#if DEBUG
import EarProtocol

enum DebugStateCycler {
    private static var seq = 0
    private static var index = 0
    private static let cycle: [(OverlayKind, String?, String?)] = [
        (.listening, nil, "Скажите, что нужно сделать"),
        (.capturing, nil, "добавь молоко и хлеб в список покупок"),
        (.thinking, nil, "добавь молоко и хлеб в список покупок"),
        (.processing, nil, "добавь молоко и хлеб в список покупок"),
        (.success, nil, nil),
        (.error, "Не понял запрос", nil),
        (.view, nil, nil),
        (.immersive, nil, "добавь сыр"),
    ]

    @MainActor
    static func next(into vm: OverlayViewModel) {
        seq += 1
        let (kind, hint, caption) = cycle[index % cycle.count]
        index += 1
        let msg = OverlayUpdateMessage(
            seq: seq,
            state: OverlayState(kind: kind, hint: hint, caption: caption, sound: nil)
        )
        vm.apply(msg)
        if kind == .view || kind == .immersive {
            let listMsg = ListViewUpdateMessage(
                seq: seq,
                view: ListView(
                    title: "Список покупок",
                    items: [
                        ListItem(id: "1", label: "молоко", done: false),
                        ListItem(id: "2", label: "хлеб", done: true),
                        ListItem(id: "3", label: "яйца", done: false),
                        ListItem(id: "4", label: "кофе", done: true),
                    ],
                    open: true
                )
            )
            vm.applyListView(listMsg)
        } else {
            let closeMsg = ListViewUpdateMessage(
                seq: seq,
                view: ListView(title: nil, items: [], open: false)
            )
            vm.applyListView(closeMsg)
        }
    }
}
#endif
