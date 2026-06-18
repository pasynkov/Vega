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

struct WakeThresholdPreset {
    let label: String
    let value: Double
}

let wakeThresholdPresets: [WakeThresholdPreset] = [
    WakeThresholdPreset(label: "Low (0.3)", value: 0.3),
    WakeThresholdPreset(label: "Default (0.5)", value: 0.5),
    WakeThresholdPreset(label: "High (0.7)", value: 0.7),
    WakeThresholdPreset(label: "Very High (0.85)", value: 0.85),
]

final class StatusItemController: NSObject {
    var onPauseToggle: ((Bool) -> Void)?
    var onQuit: (() -> Void)?
    var onTestWake: (() -> Void)?
    var onStopSession: (() -> Void)?
    var onMicSelected: ((String?) -> Void)?  // nil = system default
    var onWakeThresholdSelected: ((Double) -> Void)?

    // Snapshot supplied by AppDelegate; the submenu reads it via the delegate
    // every time it's about to open so the checkmark is always fresh.
    private var micDevices: [MicDevice] = []
    private var micSelectedUID: String?
    private var wakeThreshold: Double = Preferences.defaultWakeThreshold

    private let statusItem: NSStatusItem
    private let stateMenuItem: NSMenuItem
    private let toggleMenuItem: NSMenuItem
    private let testWakeMenuItem: NSMenuItem
    private let micMenuItem: NSMenuItem
    private let micSubmenu: NSMenu
    private let wakeSensitivityMenuItem: NSMenuItem
    private let wakeSensitivitySubmenu: NSMenu
    private var paused = false
    private var currentState: ListeningState = .idle
    private var sessionActive = false

    // Screen-coordinate frame of the menu-bar button. The overlay anchors
    // its top-right corner under the status icon so it reads as a tray
    // dropdown. Returns nil before the button is laid out.
    var statusButtonScreenFrame: NSRect? {
        guard let button = statusItem.button, let window = button.window else { return nil }
        let inWindow = button.convert(button.bounds, to: nil)
        return window.convertToScreen(inWindow)
    }

    override init() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        stateMenuItem = NSMenuItem(title: ListeningState.idle.menuLabel, action: nil, keyEquivalent: "")
        stateMenuItem.isEnabled = false
        toggleMenuItem = NSMenuItem(title: "Pause listening", action: nil, keyEquivalent: "")
        testWakeMenuItem = NSMenuItem(title: "Trigger test wake", action: nil, keyEquivalent: "t")
        micMenuItem = NSMenuItem(title: "Microphone", action: nil, keyEquivalent: "")
        micSubmenu = NSMenu(title: "Microphone")
        micMenuItem.submenu = micSubmenu
        wakeSensitivityMenuItem = NSMenuItem(title: "Wake sensitivity", action: nil, keyEquivalent: "")
        wakeSensitivitySubmenu = NSMenu(title: "Wake sensitivity")
        wakeSensitivityMenuItem.submenu = wakeSensitivitySubmenu
        super.init()

        toggleMenuItem.action = #selector(toggleClicked)
        toggleMenuItem.target = self
        testWakeMenuItem.action = #selector(testWakeClicked)
        testWakeMenuItem.target = self
        micSubmenu.delegate = self
        wakeSensitivitySubmenu.delegate = self

        let quitItem = NSMenuItem(title: "Quit", action: #selector(quitClicked), keyEquivalent: "q")
        quitItem.target = self

        let menu = NSMenu()
        menu.addItem(stateMenuItem)
        menu.addItem(NSMenuItem.separator())
        menu.addItem(micMenuItem)
        menu.addItem(wakeSensitivityMenuItem)
        menu.addItem(toggleMenuItem)
        menu.addItem(testWakeMenuItem)
        menu.addItem(NSMenuItem.separator())
        menu.addItem(quitItem)
        statusItem.menu = menu

        rebuildWakeSensitivitySubmenu()
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

    func setSessionActive(_ active: Bool) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.sessionActive = active
            self.testWakeMenuItem.title = active ? "Stop listening" : "Trigger test wake"
        }
    }

    func setWakeThreshold(_ value: Double) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.wakeThreshold = value
            self.rebuildWakeSensitivitySubmenu()
        }
    }

    private func rebuildWakeSensitivitySubmenu() {
        wakeSensitivitySubmenu.autoenablesItems = false
        wakeSensitivitySubmenu.removeAllItems()
        for preset in wakeThresholdPresets {
            let item = NSMenuItem(title: preset.label, action: #selector(wakeSensitivityClicked(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = preset.value
            item.state = abs(preset.value - wakeThreshold) < 0.0005 ? .on : .off
            wakeSensitivitySubmenu.addItem(item)
        }
        wakeSensitivitySubmenu.update()
    }

    @objc private func wakeSensitivityClicked(_ sender: NSMenuItem) {
        guard let value = sender.representedObject as? Double else { return }
        onWakeThresholdSelected?(value)
    }

    func setMicSnapshot(devices: [MicDevice], selectedUID: String?) {
        NSLog("[VegaEar] StatusItem.setMicSnapshot: count=\(devices.count) selectedUID=\(selectedUID ?? "nil")")
        micDevices = devices
        micSelectedUID = selectedUID
        rebuildMicSubmenu()
    }

    private func rebuildMicSubmenu() {
        NSLog("[VegaEar] StatusItem.rebuildMicSubmenu: micSelectedUID=\(micSelectedUID ?? "nil")")
        micSubmenu.autoenablesItems = false
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
            NSLog("[VegaEar]   item '\(device.name)' uid=\(device.uid) state=\(item.state == .on ? "ON" : "OFF")")
        }
        NSLog("[VegaEar]   item 'System default' state=\(systemItem.state == .on ? "ON" : "OFF")")
        micSubmenu.update()
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
        if sessionActive {
            onStopSession?()
        } else {
            onTestWake?()
        }
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
        if menu === micSubmenu {
            NSLog("[VegaEar] StatusItem.menuNeedsUpdate (micSubmenu)")
            rebuildMicSubmenu()
        } else if menu === wakeSensitivitySubmenu {
            rebuildWakeSensitivitySubmenu()
        }
    }

    func menuWillOpen(_ menu: NSMenu) {
        if menu === micSubmenu {
            NSLog("[VegaEar] StatusItem.menuWillOpen (micSubmenu)")
            rebuildMicSubmenu()
        } else if menu === wakeSensitivitySubmenu {
            rebuildWakeSensitivitySubmenu()
        }
    }
}

// NSMenuValidation: AppKit re-asks the target for each menu item before
// drawing it. We refresh checkmarks here as belt-and-suspenders so the
// state is correct even if menuWillOpen/menuNeedsUpdate misfires.
extension StatusItemController {
    @objc func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        if menuItem.action == #selector(micItemClicked(_:)) {
            let want: NSControl.StateValue
            if menuItem.representedObject is NSNull {
                want = (micSelectedUID == nil) ? .on : .off
            } else if let uid = menuItem.representedObject as? String {
                want = (uid == micSelectedUID) ? .on : .off
            } else {
                want = .off
            }
            menuItem.state = want
        } else if menuItem.action == #selector(wakeSensitivityClicked(_:)) {
            if let value = menuItem.representedObject as? Double {
                menuItem.state = abs(value - wakeThreshold) < 0.0005 ? .on : .off
            }
        }
        return true
    }
}
