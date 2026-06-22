import Foundation

// Vega-specific preferences persisted alongside DeviceIdentityService data.
// `micUID` stores the user's chosen input device (CoreAudio UID). When nil,
// the Ear uses the macOS system default input. `wakeThreshold` stores the
// confidence threshold applied to every OpenWakeWord candidate classifier.

public final class Preferences {
    public static let defaultWakeThreshold: Double = 0.5

    private let fileURL: URL

    public private(set) var micUID: String?
    public private(set) var wakeThreshold: Double = Preferences.defaultWakeThreshold

    public init(directory: URL? = nil) {
        let base: URL
        if let directory {
            base = directory
        } else {
            let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
                ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
            base = support.appendingPathComponent("Vega")
        }
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        fileURL = base.appendingPathComponent("preferences.json")
        load()
    }

    public func setMicUID(_ uid: String?) {
        micUID = uid
        save()
    }

    // Clamps to the open interval (0.0, 1.0) per spec. Values exactly at the
    // boundaries are nudged inward by a small epsilon.
    public func setWakeThreshold(_ value: Double) {
        let epsilon = 0.001
        let clamped = max(epsilon, min(1.0 - epsilon, value))
        wakeThreshold = clamped
        save()
    }

    private func load() {
        guard let data = try? Data(contentsOf: fileURL) else { return }
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        if let uid = json["micUID"] as? String { micUID = uid }
        if let t = json["wakeThreshold"] as? Double, t > 0.0, t < 1.0 {
            wakeThreshold = t
        }
    }

    private func save() {
        let payload: [String: Any?] = [
            "micUID": micUID,
            "wakeThreshold": wakeThreshold,
        ]
        let nonNil = payload.compactMapValues { $0 }
        guard let data = try? JSONSerialization.data(withJSONObject: nonNil, options: [.prettyPrinted]) else { return }
        try? data.write(to: fileURL, options: [.atomic])
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: fileURL.path)
    }
}
