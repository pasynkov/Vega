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
                    if !VegaDemoMode.enabled {
                        coordinator.start()
                    }
                }
                .onReceive(
                    NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)
                ) { _ in
                    guard !VegaDemoMode.enabled else { return }
                    coordinator.handleDidBecomeActive()
                }
                .onReceive(
                    NotificationCenter.default.publisher(for: UIApplication.willResignActiveNotification)
                ) { _ in
                    guard !VegaDemoMode.enabled else { return }
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
            .onTapGesture {
                guard VegaDemoMode.enabled else { return }
                DebugStateCycler.next(into: viewModel)
            }
            .onAppear {
                guard VegaDemoMode.enabled else { return }
                timer = Timer.scheduledTimer(withTimeInterval: 4.0, repeats: true) { _ in
                    Task { @MainActor in DebugStateCycler.next(into: viewModel) }
                }
            }
            #endif
    }
}

#if DEBUG
import EarProtocol

/// Demo mode toggles a synthetic cycle through every overlay state and
/// suppresses the real WebSocket / mic stack. Enabled via:
///   - launch arg  `--demo`        (Xcode → Scheme → Arguments)
///   - env var     `VEGA_DEMO=1`   (Xcode → Scheme → Environment Variables)
///   - UserDefaults `vega.demo` = true
enum VegaDemoMode {
    static let enabled: Bool = {
        if CommandLine.arguments.contains("--demo") { return true }
        let env = ProcessInfo.processInfo.environment["VEGA_DEMO"]?.lowercased() ?? ""
        if ["1", "true", "yes", "on"].contains(env) { return true }
        if UserDefaults.standard.bool(forKey: "vega.demo") { return true }
        return false
    }()
}

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
#else
enum VegaDemoMode { static let enabled: Bool = false }
#endif
