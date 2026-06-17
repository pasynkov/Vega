import Foundation

// Vega-specific preferences persisted alongside DeviceIdentityService data.
// `micUID` stores the user's chosen input device (CoreAudio UID). When nil,
// the Ear uses the macOS system default input.

final class Preferences {
    private let fileURL: URL

    private(set) var micUID: String?

    init() {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support")
        let dir = base.appendingPathComponent("Vega")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        fileURL = dir.appendingPathComponent("preferences.json")
        load()
    }

    func setMicUID(_ uid: String?) {
        micUID = uid
        save()
    }

    private func load() {
        guard let data = try? Data(contentsOf: fileURL) else { return }
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        if let uid = json["micUID"] as? String { micUID = uid }
    }

    private func save() {
        let payload: [String: Any?] = ["micUID": micUID]
        let nonNil = payload.compactMapValues { $0 }
        guard let data = try? JSONSerialization.data(withJSONObject: nonNil, options: [.prettyPrinted]) else { return }
        try? data.write(to: fileURL, options: [.atomic])
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: fileURL.path)
    }
}
