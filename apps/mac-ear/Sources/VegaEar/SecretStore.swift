import Foundation
import Security

final class SecretStore {
    private let keychainService = "vega.picovoice"

    func porcupineAccessKey() throws -> String {
        if let value = readKeychain() {
            return value
        }
        if let value = readDotEnvFallback() {
            return value
        }
        throw VegaEarError.missingSecret("PICOVOICE_ACCESS_KEY (not in Keychain, not in ~/.config/vega/ear.env)")
    }

    private func readKeychain() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecMatchLimit as String: kSecMatchLimitOne,
            kSecReturnData as String: true,
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data, let value = String(data: data, encoding: .utf8) else {
            return nil
        }
        return value
    }

    private func readDotEnvFallback() -> String? {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let path = home.appendingPathComponent(".config/vega/ear.env")
        guard let contents = try? String(contentsOf: path, encoding: .utf8) else { return nil }
        for line in contents.split(separator: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard !trimmed.hasPrefix("#") else { continue }
            guard let eq = trimmed.firstIndex(of: "=") else { continue }
            let key = trimmed[..<eq].trimmingCharacters(in: .whitespaces)
            let value = trimmed[trimmed.index(after: eq)...].trimmingCharacters(in: .whitespaces)
            if key == "PICOVOICE_ACCESS_KEY", !value.isEmpty {
                return String(value)
            }
        }
        return nil
    }
}
