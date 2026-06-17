import CoreAudio
import Foundation

struct MicDevice: Equatable {
    let id: AudioDeviceID
    let uid: String
    let name: String
}

enum MicDeviceCatalog {
    static func list() -> [MicDevice] {
        var result: [MicDevice] = []
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDevices,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )

        var dataSize: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(
            AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &dataSize
        ) == noErr else { return result }

        let deviceCount = Int(dataSize) / MemoryLayout<AudioDeviceID>.size
        var ids = [AudioDeviceID](repeating: 0, count: deviceCount)
        guard AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &dataSize, &ids
        ) == noErr else { return result }

        for id in ids where hasInputChannels(id) {
            guard let uid = stringProperty(id, kAudioDevicePropertyDeviceUID, scope: kAudioObjectPropertyScopeGlobal) else { continue }
            let name = stringProperty(id, kAudioObjectPropertyName, scope: kAudioObjectPropertyScopeGlobal) ?? "(unnamed)"
            result.append(MicDevice(id: id, uid: uid, name: name))
        }
        return result
    }

    static func find(uid: String) -> MicDevice? {
        list().first { $0.uid == uid }
    }

    static func systemDefault() -> MicDevice? {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultInputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var deviceId: AudioDeviceID = 0
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        guard AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &deviceId
        ) == noErr, deviceId != 0 else { return nil }
        guard let uid = stringProperty(deviceId, kAudioDevicePropertyDeviceUID, scope: kAudioObjectPropertyScopeGlobal) else { return nil }
        let name = stringProperty(deviceId, kAudioObjectPropertyName, scope: kAudioObjectPropertyScopeGlobal) ?? "(unnamed)"
        return MicDevice(id: deviceId, uid: uid, name: name)
    }

    private static func hasInputChannels(_ deviceId: AudioDeviceID) -> Bool {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreamConfiguration,
            mScope: kAudioObjectPropertyScopeInput,
            mElement: kAudioObjectPropertyElementMain
        )
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(deviceId, &address, 0, nil, &size) == noErr, size > 0 else { return false }
        let data = UnsafeMutablePointer<UInt8>.allocate(capacity: Int(size))
        defer { data.deallocate() }
        guard AudioObjectGetPropertyData(deviceId, &address, 0, nil, &size, data) == noErr else { return false }
        let bufferList = data.withMemoryRebound(to: AudioBufferList.self, capacity: 1) { $0.pointee }
        let buffers = UnsafeBufferPointer<AudioBuffer>(
            start: withUnsafePointer(to: bufferList) { ptr in
                ptr.withMemoryRebound(to: AudioBuffer.self, capacity: Int(bufferList.mNumberBuffers)) { $0 }
            },
            count: Int(bufferList.mNumberBuffers)
        )
        for buf in buffers where buf.mNumberChannels > 0 { return true }
        return false
    }

    private static func stringProperty(
        _ deviceId: AudioDeviceID,
        _ selector: AudioObjectPropertySelector,
        scope: AudioObjectPropertyScope
    ) -> String? {
        var address = AudioObjectPropertyAddress(
            mSelector: selector,
            mScope: scope,
            mElement: kAudioObjectPropertyElementMain
        )
        var cfStr: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        let status = withUnsafeMutablePointer(to: &cfStr) { ptr -> OSStatus in
            ptr.withMemoryRebound(to: UInt8.self, capacity: Int(size)) { raw -> OSStatus in
                AudioObjectGetPropertyData(deviceId, &address, 0, nil, &size, raw)
            }
        }
        guard status == noErr, let value = cfStr?.takeRetainedValue() else { return nil }
        return value as String
    }
}
