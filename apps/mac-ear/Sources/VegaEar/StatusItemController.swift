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

final class StatusItemController: NSObject {
    var onPauseToggle: ((Bool) -> Void)?
    var onQuit: (() -> Void)?
    var onTestWake: (() -> Void)?
    var onMicSelected: ((String?) -> Void)?  // nil = system default

    // Snapshot supplied by AppDelegate; the submenu reads it via the delegate
    // every time it's about to open so the checkmark is always fresh.
    private var micDevices: [MicDevice] = []
    private var micSelectedUID: String?

    private let statusItem: NSStatusItem
    private let stateMenuItem: NSMenuItem
    private let toggleMenuItem: NSMenuItem
    private let testWakeMenuItem: NSMenuItem
    private let micMenuItem: NSMenuItem
    private let micSubmenu: NSMenu
    private var paused = false
    private var currentState: ListeningState = .idle

    override init() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        stateMenuItem = NSMenuItem(title: ListeningState.idle.menuLabel, action: nil, keyEquivalent: "")
        stateMenuItem.isEnabled = false
        toggleMenuItem = NSMenuItem(title: "Pause listening", action: nil, keyEquivalent: "")
        testWakeMenuItem = NSMenuItem(title: "Trigger test wake", action: nil, keyEquivalent: "t")
        micMenuItem = NSMenuItem(title: "Microphone", action: nil, keyEquivalent: "")
        micSubmenu = NSMenu(title: "Microphone")
        micMenuItem.submenu = micSubmenu
        super.init()

        toggleMenuItem.action = #selector(toggleClicked)
        toggleMenuItem.target = self
        testWakeMenuItem.action = #selector(testWakeClicked)
        testWakeMenuItem.target = self
        micSubmenu.delegate = self

        let quitItem = NSMenuItem(title: "Quit", action: #selector(quitClicked), keyEquivalent: "q")
        quitItem.target = self

        let menu = NSMenu()
        menu.addItem(stateMenuItem)
        menu.addItem(NSMenuItem.separator())
        menu.addItem(micMenuItem)
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

    func setMicSnapshot(devices: [MicDevice], selectedUID: String?) {
        NSLog("[VegaEar] StatusItem.setMicSnapshot: count=\(devices.count) selectedUID=\(selectedUID ?? "nil")")
        micDevices = devices
        micSelectedUID = selectedUID
        rebuildMicSubmenu()
    }

    private func rebuildMicSubmenu() {
        NSLog("[VegaEar] StatusItem.rebuildMicSubmenu: micSelectedUID=\(micSelectedUID ?? "nil")")
        micSubmenu.removeAllItems()

        let systemItem = NSMenuItem(title: "System default", action: #selector(micItemClicked(_:)), keyEquivalent: "")
        systemItem.target = self
        systemItem.state = (micSelectedUID == nil) ? .on : .off
        systemItem.representedObject = NSNull()
        micSubmenu.addItem(systemItem)
        micSubmenu.addItem(NSMenuItem.separator())

        for device in micDevices {
            let item = NSMenuItem(title: device.name, action: #selector(micItemClicked(_:)), keyEquivalent: "")
            item.target = self
            item.state = (device.uid == micSelectedUID) ? .on : .off
            item.representedObject = device.uid
            micSubmenu.addItem(item)
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

    @objc private func micItemClicked(_ sender: NSMenuItem) {
        if sender.representedObject is NSNull {
            onMicSelected?(nil)
        } else if let uid = sender.representedObject as? String {
            onMicSelected?(uid)
        }
    }

    private func applyIcon(for state: ListeningState) {
        if let button = statusItem.button {
            let image = NSImage(systemSymbolName: state.iconSymbol, accessibilityDescription: state.menuLabel)
            image?.isTemplate = true
            button.image = image
        }
    }
}

extension StatusItemController: NSMenuDelegate {
    func menuNeedsUpdate(_ menu: NSMenu) {
        guard menu === micSubmenu else { return }
        NSLog("[VegaEar] StatusItem.menuNeedsUpdate fired for micSubmenu, selectedUID=\(micSelectedUID ?? "nil")")
        rebuildMicSubmenu()
    }
}
