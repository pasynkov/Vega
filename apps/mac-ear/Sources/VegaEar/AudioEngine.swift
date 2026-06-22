import AudioToolbox
import AVFoundation
import CoreAudio
import EarCore
import Foundation

// Captures PCM from the chosen input device at the device's native sample
// rate and broadcasts the frames to consumers.
//
// Implemented as a raw CoreAudio HAL output AU (kAudioUnitSubType_HALOutput)
// in input-only mode: input bus enabled, output bus disabled. This avoids
// the AVAudioEngine pitfall on macOS where the engine builds an internal
// aggregate device combining input + system output, which forces a BT
// headset into HFP (mono ~16 kHz) and tanks A2DP music quality whenever
// the Ear is running. AUHAL with output IO disabled never opens the output
// device, so the headset stays in A2DP.

final class AudioEngine: AudioCapturing {
    typealias PCMSink = (Data) -> Void

    private var audioUnit: AudioUnit?
    private var renderListPtr: UnsafeMutablePointer<AudioBufferList>?
    private var renderDataPtr: UnsafeMutableRawPointer?
    private var renderDataCapacity: Int = 0

    private let queue = DispatchQueue(label: "vega.ear.audio", qos: .userInitiated)
    private var sinks: [PCMSink] = []
    private(set) var isRunning = false
    private(set) var currentDevice: MicDevice?
    private(set) var currentSampleRate: Double = 48_000
    private var callbackCount: Int = 0
    private var bytesSinceReport: Int = 0
    private var reportAt: Date = Date()

    init() throws {}

    func selectDevice(_ device: MicDevice?) throws {
        NSLog("[VegaEar] AudioEngine.selectDevice begin: target=\(device?.name ?? "(system default)")")
        let wasRunning = isRunning
        if wasRunning { stop() }
        currentDevice = device
        if wasRunning {
            try start()
        } else {
            NSLog("[VegaEar] selectDevice complete (engine was idle, not auto-starting)")
        }
    }

    func start() throws {
        if isRunning { return }
        NSLog("[VegaEar] AudioEngine.start: preparing AUHAL input-only…")

        var desc = AudioComponentDescription(
            componentType: kAudioUnitType_Output,
            componentSubType: kAudioUnitSubType_HALOutput,
            componentManufacturer: kAudioUnitManufacturer_Apple,
            componentFlags: 0,
            componentFlagsMask: 0
        )
        guard let comp = AudioComponentFindNext(nil, &desc) else {
            throw Self.makeError("AudioComponentFindNext returned nil", code: -1)
        }
        var unitOpt: AudioUnit?
        var st = AudioComponentInstanceNew(comp, &unitOpt)
        guard st == noErr, let unit = unitOpt else {
            throw Self.makeError("AudioComponentInstanceNew", code: st)
        }

        var enable: UInt32 = 1
        var disable: UInt32 = 0
        st = AudioUnitSetProperty(
            unit, kAudioOutputUnitProperty_EnableIO,
            kAudioUnitScope_Input, 1,
            &enable, UInt32(MemoryLayout<UInt32>.size)
        )
        guard st == noErr else {
            AudioComponentInstanceDispose(unit)
            throw Self.makeError("EnableIO input bus", code: st)
        }
        st = AudioUnitSetProperty(
            unit, kAudioOutputUnitProperty_EnableIO,
            kAudioUnitScope_Output, 0,
            &disable, UInt32(MemoryLayout<UInt32>.size)
        )
        guard st == noErr else {
            AudioComponentInstanceDispose(unit)
            throw Self.makeError("EnableIO output bus", code: st)
        }

        var deviceId: AudioDeviceID = currentDevice?.id ?? Self.systemDefaultInputDeviceID()
        guard deviceId != 0 else {
            AudioComponentInstanceDispose(unit)
            throw Self.makeError("No input device available", code: -1)
        }
        st = AudioUnitSetProperty(
            unit, kAudioOutputUnitProperty_CurrentDevice,
            kAudioUnitScope_Global, 0,
            &deviceId, UInt32(MemoryLayout<AudioDeviceID>.size)
        )
        guard st == noErr else {
            AudioComponentInstanceDispose(unit)
            throw Self.makeError("CurrentDevice", code: st)
        }

        var hwFormat = AudioStreamBasicDescription()
        var hwSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        st = AudioUnitGetProperty(
            unit, kAudioUnitProperty_StreamFormat,
            kAudioUnitScope_Input, 1,
            &hwFormat, &hwSize
        )
        guard st == noErr else {
            AudioComponentInstanceDispose(unit)
            throw Self.makeError("Get hardware format", code: st)
        }
        let hwRate = hwFormat.mSampleRate > 0 ? hwFormat.mSampleRate : 48_000
        let hwChannels = hwFormat.mChannelsPerFrame > 0 ? hwFormat.mChannelsPerFrame : 1

        var clientFormat = AudioStreamBasicDescription(
            mSampleRate: hwRate,
            mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
            mBytesPerPacket: 4,
            mFramesPerPacket: 1,
            mBytesPerFrame: 4,
            mChannelsPerFrame: 1,
            mBitsPerChannel: 32,
            mReserved: 0
        )
        st = AudioUnitSetProperty(
            unit, kAudioUnitProperty_StreamFormat,
            kAudioUnitScope_Output, 1,
            &clientFormat, UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        )
        guard st == noErr else {
            AudioComponentInstanceDispose(unit)
            throw Self.makeError("Set client format", code: st)
        }
        currentSampleRate = hwRate

        let maxFrames: UInt32 = 4096
        var maxSlice = maxFrames
        _ = AudioUnitSetProperty(
            unit, kAudioUnitProperty_MaximumFramesPerSlice,
            kAudioUnitScope_Global, 0,
            &maxSlice, UInt32(MemoryLayout<UInt32>.size)
        )

        let renderBytes = Int(maxFrames) * Int(clientFormat.mBytesPerFrame)
        let dataPtr = UnsafeMutableRawPointer.allocate(byteCount: renderBytes, alignment: 16)
        let listPtr = UnsafeMutablePointer<AudioBufferList>.allocate(capacity: 1)
        listPtr.pointee = AudioBufferList(
            mNumberBuffers: 1,
            mBuffers: AudioBuffer(
                mNumberChannels: 1,
                mDataByteSize: UInt32(renderBytes),
                mData: dataPtr
            )
        )
        renderDataPtr = dataPtr
        renderDataCapacity = renderBytes
        renderListPtr = listPtr

        var cb = AURenderCallbackStruct(
            inputProc: { (inRefCon, ioActionFlags, inTimeStamp, inBusNumber, inNumberFrames, _) -> OSStatus in
                let me = Unmanaged<AudioEngine>.fromOpaque(inRefCon).takeUnretainedValue()
                return me.handleInput(
                    ioActionFlags: ioActionFlags,
                    timeStamp: inTimeStamp,
                    bus: inBusNumber,
                    frames: inNumberFrames
                )
            },
            inputProcRefCon: Unmanaged.passUnretained(self).toOpaque()
        )
        st = AudioUnitSetProperty(
            unit, kAudioOutputUnitProperty_SetInputCallback,
            kAudioUnitScope_Global, 0,
            &cb, UInt32(MemoryLayout<AURenderCallbackStruct>.size)
        )
        guard st == noErr else {
            disposeRenderBuffers()
            AudioComponentInstanceDispose(unit)
            throw Self.makeError("SetInputCallback", code: st)
        }

        st = AudioUnitInitialize(unit)
        guard st == noErr else {
            disposeRenderBuffers()
            AudioComponentInstanceDispose(unit)
            throw Self.makeError("AudioUnitInitialize", code: st)
        }
        st = AudioOutputUnitStart(unit)
        guard st == noErr else {
            AudioUnitUninitialize(unit)
            disposeRenderBuffers()
            AudioComponentInstanceDispose(unit)
            throw Self.makeError("AudioOutputUnitStart", code: st)
        }

        audioUnit = unit
        isRunning = true
        callbackCount = 0
        bytesSinceReport = 0
        reportAt = Date()
        NSLog("[VegaEar] AUHAL started: device=\(deviceId) name=\(currentDevice?.name ?? "(system default)") rate=\(hwRate) hwChannels=\(hwChannels) clientChannels=1")
    }

    func stop() {
        if !isRunning { return }
        if let unit = audioUnit {
            AudioOutputUnitStop(unit)
            AudioUnitUninitialize(unit)
            AudioComponentInstanceDispose(unit)
        }
        audioUnit = nil
        disposeRenderBuffers()
        isRunning = false
        NSLog("[VegaEar] AUHAL stopped")
    }

    func addSink(_ sink: @escaping PCMSink) {
        queue.async { self.sinks.append(sink) }
    }

    private func handleInput(
        ioActionFlags: UnsafeMutablePointer<AudioUnitRenderActionFlags>,
        timeStamp: UnsafePointer<AudioTimeStamp>,
        bus: UInt32,
        frames: UInt32
    ) -> OSStatus {
        guard let unit = audioUnit, let listPtr = renderListPtr else { return noErr }
        let bytesPerFrame: UInt32 = 4
        let needed = frames * bytesPerFrame
        if Int(needed) > renderDataCapacity { return noErr }
        listPtr.pointee.mBuffers.mDataByteSize = needed
        let st = AudioUnitRender(unit, ioActionFlags, timeStamp, bus, frames, listPtr)
        guard st == noErr else { return st }
        let frameCount = Int(frames)
        guard let floatPtr = listPtr.pointee.mBuffers.mData?.assumingMemoryBound(to: Float32.self) else {
            return noErr
        }
        var data = Data(count: frameCount * MemoryLayout<Int16>.size)
        data.withUnsafeMutableBytes { rawDst in
            guard let dst = rawDst.baseAddress?.assumingMemoryBound(to: Int16.self) else { return }
            for i in 0..<frameCount {
                let clipped = max(-1.0, min(1.0, floatPtr[i]))
                dst[i] = Int16(clipped * 32_767)
            }
        }
        callbackCount += 1
        if callbackCount <= 3 {
            NSLog("[VegaEar] AUHAL callback #\(callbackCount): frames=\(frames) outBytes=\(data.count)")
        }
        bytesSinceReport += data.count
        let now = Date()
        if now.timeIntervalSince(reportAt) >= 2.0 {
            NSLog("[VegaEar] AUHAL throughput: \(bytesSinceReport) bytes / 2s (callbacks=\(callbackCount))")
            bytesSinceReport = 0
            reportAt = now
        }
        if data.isEmpty { return noErr }
        queue.async {
            if self.sinks.isEmpty && self.callbackCount <= 3 {
                NSLog("[VegaEar] AUHAL callback #\(self.callbackCount): WARNING sinks is empty, data discarded")
            }
            for sink in self.sinks {
                sink(data)
            }
        }
        return noErr
    }

    private func disposeRenderBuffers() {
        if let dataPtr = renderDataPtr { dataPtr.deallocate() }
        renderDataPtr = nil
        if let listPtr = renderListPtr { listPtr.deallocate() }
        renderListPtr = nil
        renderDataCapacity = 0
    }

    private static func systemDefaultInputDeviceID() -> AudioDeviceID {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultInputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var deviceId: AudioDeviceID = 0
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        _ = AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &deviceId
        )
        return deviceId
    }

    private static func makeError(_ message: String, code: OSStatus) -> NSError {
        NSError(
            domain: "VegaEar.AudioEngine",
            code: Int(code),
            userInfo: [NSLocalizedDescriptionKey: "\(message): \(code)"]
        )
    }
}

