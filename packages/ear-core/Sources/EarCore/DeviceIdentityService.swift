import Foundation

public final class DeviceIdentityService {
    public let deviceId: String
    public let deviceName: String

    /// `deviceName` is provided by the host shell (e.g. `Host.current().localizedName`
    /// on macOS, `UIDevice.current.name` on iOS) so this type stays cross-platform.
    /// `supportDirectory` overrides the default Application Support / Vega path
    /// (used by tests).
    public init(deviceName: String, supportDirectory: URL? = nil) {
        self.deviceName = deviceName

        let supportDir = supportDirectory ?? Self.defaultSupportDirectory()
        let file = supportDir.appendingPathComponent("device.json")
        if let existing = Self.read(file) {
            self.deviceId = existing
            return
        }
        let newId = UUID().uuidString.lowercased()
        Self.write(file, deviceId: newId)
        self.deviceId = newId
    }

    private static func defaultSupportDirectory() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
        let dir = base.appendingPathComponent("Vega")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        return dir
    }

    private static func read(_ file: URL) -> String? {
        guard let data = try? Data(contentsOf: file) else { return nil }
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return json["deviceId"] as? String
    }

    private static func write(_ file: URL, deviceId: String) {
        let payload: [String: Any] = ["deviceId": deviceId]
        guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted]) else { return }
        try? data.write(to: file, options: [.atomic])
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    }
}
