import AppKit

enum ListeningState: Equatable {
    case idle
    case listening
    case streaming
    case error(String)
    case disabled

    var menuLabel: String {
        switch self {
        case .idle: return "State: idle (listening for wake)"
        case .listening: return "State: listening"
        case .streaming: return "State: streaming"
        case .error(let msg): return "Error: \(msg)"
        case .disabled: return "State: paused"
        }
    }

    var iconSymbol: String {
        switch self {
        case .idle: return "ear"
        case .listening: return "waveform"
        case .streaming: return "waveform.circle.fill"
        case .error: return "exclamationmark.triangle.fill"
        case .disabled: return "pause.circle"
        }
    }
}

final class StatusItemController {
    var onPauseToggle: ((Bool) -> Void)?
    var onQuit: (() -> Void)?
    var onTestWake: (() -> Void)?

    private let statusItem: NSStatusItem
    private let stateMenuItem: NSMenuItem
    private let toggleMenuItem: NSMenuItem
    private let testWakeMenuItem: NSMenuItem
    private var paused = false
    private var currentState: ListeningState = .idle

    init() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        stateMenuItem = NSMenuItem(title: ListeningState.idle.menuLabel, action: nil, keyEquivalent: "")
        stateMenuItem.isEnabled = false
        toggleMenuItem = NSMenuItem(title: "Pause listening", action: nil, keyEquivalent: "")
        toggleMenuItem.target = nil
        testWakeMenuItem = NSMenuItem(title: "Trigger test wake", action: nil, keyEquivalent: "t")
        testWakeMenuItem.target = nil
        let quitItem = NSMenuItem(title: "Quit", action: #selector(quitClicked), keyEquivalent: "q")
        quitItem.target = self
        toggleMenuItem.action = #selector(toggleClicked)
        toggleMenuItem.target = self
        testWakeMenuItem.action = #selector(testWakeClicked)
        testWakeMenuItem.target = self

        let menu = NSMenu()
        menu.addItem(stateMenuItem)
        menu.addItem(NSMenuItem.separator())
        menu.addItem(toggleMenuItem)
        menu.addItem(testWakeMenuItem)
        menu.addItem(NSMenuItem.separator())
        menu.addItem(quitItem)
        statusItem.menu = menu

        applyIcon(for: .idle)
    }

    func setState(_ state: ListeningState) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.currentState = state
            self.stateMenuItem.title = state.menuLabel
            self.applyIcon(for: state)
        }
    }

    @objc private func toggleClicked() {
        paused.toggle()
        toggleMenuItem.title = paused ? "Resume listening" : "Pause listening"
        onPauseToggle?(paused)
        setState(paused ? .disabled : .idle)
    }

    @objc private func quitClicked() {
        onQuit?()
    }

    @objc private func testWakeClicked() {
        onTestWake?()
    }

    private func applyIcon(for state: ListeningState) {
        if let button = statusItem.button {
            let image = NSImage(systemSymbolName: state.iconSymbol, accessibilityDescription: state.menuLabel)
            image?.isTemplate = true
            button.image = image
        }
    }
}
