#if DEBUG
import EarCore
import EarProtocol
import Foundation

/// Demo cycler that mirrors the iOS app's `DebugStateCycler`. Every
/// `interval` seconds it pushes a synthetic `overlay_update` (+ list
/// view when needed) into the overlay controller so the panel cycles
/// through all 9 visual states. Overrides any real Core traffic —
/// disable before running against a live Core.
@MainActor
final class DebugStateCycler {
    private let overlay: OverlayControlling
    private let interval: TimeInterval
    private var seq = 0
    private var index = 0
    private var timer: Timer?

    private typealias Step = (kind: OverlayKind, hint: String?, caption: String?, list: Bool)
    private let cycle: [Step] = [
        (.listening,  nil,                  "Скажите, что нужно сделать",            false),
        (.capturing,  nil,                  "добавь молоко и хлеб в список покупок", false),
        (.thinking,   nil,                  "добавь молоко и хлеб в список покупок", false),
        (.processing, nil,                  "добавь молоко и хлеб в список покупок", false),
        (.success,    nil,                  nil,                                     false),
        (.error,      "Не понял запрос",    nil,                                     false),
        (.view,       nil,                  nil,                                     true),
        (.immersive,  nil,                  "добавь сыр",                            true),
    ]

    private let demoItems: [ListItem] = [
        ListItem(id: "1", label: "молоко",  done: false),
        ListItem(id: "2", label: "хлеб",    done: true),
        ListItem(id: "3", label: "яйца",    done: false),
        ListItem(id: "4", label: "кофе",    done: true),
    ]

    init(overlay: OverlayControlling, interval: TimeInterval = 4.0) {
        self.overlay = overlay
        self.interval = interval
    }

    func start() {
        timer?.invalidate()
        fire()
        timer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.fire() }
        }
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    private func fire() {
        seq += 1
        let step = cycle[index % cycle.count]
        index += 1

        let overlayMsg = OverlayUpdateMessage(
            seq: seq,
            state: OverlayState(kind: step.kind,
                                hint: step.hint,
                                caption: step.caption,
                                sound: nil)
        )
        overlay.applyOverlayUpdate(overlayMsg)

        let listMsg = ListViewUpdateMessage(
            seq: seq,
            view: ListView(
                title: step.list ? "Список покупок" : nil,
                items: step.list ? demoItems : [],
                open: step.list
            )
        )
        overlay.applyListViewUpdate(listMsg)
    }
}
#endif
