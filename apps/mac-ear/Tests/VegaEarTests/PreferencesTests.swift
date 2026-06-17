import XCTest
@testable import VegaEar

final class PreferencesTests: XCTestCase {
    private func makeTempDir() throws -> URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("VegaPrefsTest-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    func testDefaultThreshold() throws {
        let dir = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        let prefs = Preferences(directory: dir)
        XCTAssertEqual(prefs.wakeThreshold, 0.5, accuracy: 0.0001)
    }

    func testThresholdPersistsAcrossInstances() throws {
        let dir = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        let a = Preferences(directory: dir)
        a.setWakeThreshold(0.7)
        XCTAssertEqual(a.wakeThreshold, 0.7, accuracy: 0.0001)

        let b = Preferences(directory: dir)
        XCTAssertEqual(b.wakeThreshold, 0.7, accuracy: 0.0001)
    }

    func testInvalidThresholdClampedIntoOpenInterval() throws {
        let dir = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        let prefs = Preferences(directory: dir)
        prefs.setWakeThreshold(-1.0)
        XCTAssertGreaterThan(prefs.wakeThreshold, 0.0)
        XCTAssertLessThan(prefs.wakeThreshold, 1.0)

        prefs.setWakeThreshold(2.0)
        XCTAssertGreaterThan(prefs.wakeThreshold, 0.0)
        XCTAssertLessThan(prefs.wakeThreshold, 1.0)
    }

    func testInvalidPersistedThresholdFallsBackToDefault() throws {
        let dir = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        let prefsFile = dir.appendingPathComponent("preferences.json")
        // Persisted threshold outside (0, 1) should be ignored on load.
        let bad = #"{"wakeThreshold": 1.5}"#
        try bad.write(to: prefsFile, atomically: true, encoding: .utf8)

        let prefs = Preferences(directory: dir)
        XCTAssertEqual(prefs.wakeThreshold, 0.5, accuracy: 0.0001)
    }

    func testMicUIDStillPersists() throws {
        let dir = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        let a = Preferences(directory: dir)
        a.setMicUID("device-abc")
        a.setWakeThreshold(0.3)

        let b = Preferences(directory: dir)
        XCTAssertEqual(b.micUID, "device-abc")
        XCTAssertEqual(b.wakeThreshold, 0.3, accuracy: 0.0001)
    }
}
