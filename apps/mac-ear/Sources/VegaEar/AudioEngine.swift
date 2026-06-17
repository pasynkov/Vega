import AVFoundation
import CoreAudio
import Foundation

// Captures 48 kHz mono PCM from the chosen input device and broadcasts the
// frames to two consumers: the wake-word detector and the session capture
// pipeline. A 1-second pre-roll ring buffer is retained so a session can
// include the moments just before the wake word fired.
//
// AVAudioEngine on macOS does not reliably re-target the input AudioUnit's
// HAL device after the engine has started, so each `selectDevice(_:)`
// call rebuilds a fresh AVAudioEngine and reinstalls the tap.

final class AudioEngine {
    typealias PCMSink = (Data) -> Void

    let sampleRate: Double = 48_000
    private var engine = AVAudioEngine()
    private let queue = DispatchQueue(label: "vega.ear.audio", qos: .userInitiated)
    private var sinks: [PCMSink] = []
    private var preRoll = RingBuffer<Data>(capacityHint: 50)
    private let targetFormat: AVAudioFormat
    private var converter: AVAudioConverter?
    private var converterInputFormat: AVAudioFormat?
    private(set) var isRunning = false
    private(set) var currentDevice: MicDevice?

    init() throws {
        targetFormat = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: sampleRate,
            channels: 1,
            interleaved: true
        )!
    }

    func selectDevice(_ device: MicDevice?) throws {
        NSLog("[VegaEar] AudioEngine.selectDevice begin: target=\(device?.name ?? "(system default)")")
        let wasRunning = isRunning
        if wasRunning { stop() }

        // Rebuild the engine. AVAudioEngine caches a HAL AudioUnit on the
        // input node that survives stop()/start() but doesn't reliably
        // honour kAudioOutputUnitProperty_CurrentDevice after first use.
        engine = AVAudioEngine()
        converter = nil
        converterInputFormat = nil
        NSLog("[VegaEar] AudioEngine rebuilt")

        if let device {
            try Self.setInputDevice(engine.inputNode, deviceId: device.id)
            NSLog("[VegaEar] setInputDevice ok: id=\(device.id) name=\(device.name)")
        }
        currentDevice = device

        // Defer installTap until engine.start() — querying inputNode.outputFormat
        // (which installTap requires) can block on macOS while the HAL AudioUnit
        // is still negotiating the new device's format (esp. AirPods HFP).
        if wasRunning {
            try start()
        } else {
            NSLog("[VegaEar] selectDevice complete (engine was idle, not auto-starting)")
        }
    }

    func start() throws {
        if isRunning { return }
        NSLog("[VegaEar] AudioEngine.start: preparing…")
        engine.prepare()
        NSLog("[VegaEar] AudioEngine.start: starting engine…")
        do {
            try engine.start()
        } catch {
            NSLog("[VegaEar] engine.start() threw: \(error)")
            throw error
        }
        isRunning = true
        let actualId = Self.readCurrentInputDevice(engine.inputNode)
        NSLog("[VegaEar] AudioEngine started, requested=\(currentDevice?.name ?? "(system default)") audioUnit.deviceID=\(actualId?.description ?? "?")")
        installTap()
        NSLog("[VegaEar] tap installed (format=\(engine.inputNode.outputFormat(forBus: 0)))")
    }

    func stop() {
        if !isRunning { return }
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        isRunning = false
        NSLog("[VegaEar] AudioEngine stopped")
    }

    func addSink(_ sink: @escaping PCMSink) {
        queue.async { self.sinks.append(sink) }
    }

    func drainPreRoll() -> [Data] {
        var copy: [Data] = []
        queue.sync { copy = preRoll.drain() }
        return copy
    }

    private func installTap() {
        let input = engine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: inputFormat) { [weak self] buffer, _ in
            guard let self else { return }
            guard let converted = self.convert(buffer: buffer) else { return }
            let data = Self.dataFromBuffer(converted)
            self.queue.async {
                self.preRoll.push(data)
                for sink in self.sinks {
                    sink(data)
                }
            }
        }
    }

    private func convert(buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        if converter == nil || converterInputFormat != buffer.format {
            converter = AVAudioConverter(from: buffer.format, to: targetFormat)
            converterInputFormat = buffer.format
        }
        guard let converter else { return nil }
        let capacity = AVAudioFrameCount(targetFormat.sampleRate * Double(buffer.frameLength) / buffer.format.sampleRate) + 16
        guard let out = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity) else { return nil }
        var error: NSError?
        var supplied = false
        converter.convert(to: out, error: &error) { _, status in
            if supplied {
                status.pointee = .endOfStream
                return nil
            }
            supplied = true
            status.pointee = .haveData
            return buffer
        }
        if error != nil { return nil }
        return out
    }

    private static func dataFromBuffer(_ buffer: AVAudioPCMBuffer) -> Data {
        let frameCount = Int(buffer.frameLength)
        let channels = Int(buffer.format.channelCount)
        let byteCount = frameCount * channels * MemoryLayout<Int16>.size
        guard let ptr = buffer.int16ChannelData?[0] else { return Data() }
        return Data(bytes: ptr, count: byteCount)
    }

    private static func readCurrentInputDevice(_ inputNode: AVAudioInputNode) -> AudioDeviceID? {
        guard let unit = inputNode.audioUnit else { return nil }
        var id: AudioDeviceID = 0
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        let status = AudioUnitGetProperty(
            unit,
            kAudioOutputUnitProperty_CurrentDevice,
            kAudioUnitScope_Global,
            0,
            &id,
            &size
        )
        return status == noErr ? id : nil
    }

    // Bind the input node's underlying HAL AudioUnit to a specific CoreAudio
    // device. Must run while the engine is stopped.
    private static func setInputDevice(_ inputNode: AVAudioInputNode, deviceId: AudioDeviceID) throws {
        guard let unit = inputNode.audioUnit else {
            throw NSError(domain: "VegaEar.AudioEngine", code: 1, userInfo: [NSLocalizedDescriptionKey: "Input node has no AudioUnit"])
        }
        var id = deviceId
        let status = AudioUnitSetProperty(
            unit,
            kAudioOutputUnitProperty_CurrentDevice,
            kAudioUnitScope_Global,
            0,
            &id,
            UInt32(MemoryLayout<AudioDeviceID>.size)
        )
        if status != noErr {
            throw NSError(domain: "VegaEar.AudioEngine", code: Int(status), userInfo: [NSLocalizedDescriptionKey: "AudioUnitSetProperty(CurrentDevice) failed: \(status)"])
        }
    }
}

// MARK: - Ring buffer

struct RingBuffer<Element> {
    private var storage: [Element] = []
    private let capacityHint: Int

    init(capacityHint: Int) {
        self.capacityHint = capacityHint
    }

    mutating func push(_ element: Element) {
        storage.append(element)
        if storage.count > capacityHint {
            storage.removeFirst(storage.count - capacityHint)
        }
    }

    mutating func drain() -> [Element] {
        let out = storage
        storage.removeAll(keepingCapacity: true)
        return out
    }
}
