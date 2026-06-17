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
            guard let uid = stringProperty(id, kAudioDevicePropertyDeviceUID) else { continue }
            let name = stringProperty(id, kAudioObjectPropertyName) ?? "(unnamed)"
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
        guard let uid = stringProperty(deviceId, kAudioDevicePropertyDeviceUID) else { return nil }
        let name = stringProperty(deviceId, kAudioObjectPropertyName) ?? "(unnamed)"
        return MicDevice(id: deviceId, uid: uid, name: name)
    }

    // Read the device's input-scope stream config (an AudioBufferList of
    // variable length) and report whether any buffer has channels.
    private static func hasInputChannels(_ deviceId: AudioDeviceID) -> Bool {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreamConfiguration,
            mScope: kAudioObjectPropertyScopeInput,
            mElement: kAudioObjectPropertyElementMain
        )
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(deviceId, &address, 0, nil, &size) == noErr,
              size >= UInt32(MemoryLayout<AudioBufferList>.size) else {
            return false
        }
        let raw = UnsafeMutableRawPointer.allocate(
            byteCount: Int(size),
            alignment: MemoryLayout<AudioBufferList>.alignment
        )
        defer { raw.deallocate() }
        guard AudioObjectGetPropertyData(deviceId, &address, 0, nil, &size, raw) == noErr else {
            return false
        }
        let listPtr = raw.assumingMemoryBound(to: AudioBufferList.self)
        let abl = UnsafeMutableAudioBufferListPointer(listPtr)
        for buf in abl where buf.mNumberChannels > 0 {
            return true
        }
        return false
    }

    private static func stringProperty(
        _ deviceId: AudioDeviceID,
        _ selector: AudioObjectPropertySelector
    ) -> String? {
        var address = AudioObjectPropertyAddress(
            mSelector: selector,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var cfStr: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        let status = withUnsafeMutablePointer(to: &cfStr) { ptr -> OSStatus in
            AudioObjectGetPropertyData(deviceId, &address, 0, nil, &size, ptr)
        }
        guard status == noErr, let value = cfStr?.takeRetainedValue() else {
            return nil
        }
        return value as String
    }
}
