import AVFoundation
import CoreAudio
import Foundation

// Captures PCM from the chosen input device at the device's native sample
// rate (no resampling on the Ear) and broadcasts the frames to consumers.
// A 1-second pre-roll ring buffer retains a few seconds of audio so a
// session can include the moments just before the wake word fired.
//
// AVAudioEngine on macOS requires a downstream consumer to actually pull
// audio from inputNode, so the engine routes inputNode -> mainMixerNode at
// outputVolume 0 (mute) — without this the installTap closure is never
// invoked.
//
// AVAudioConverter was previously used to resample to 48 kHz int16 mono,
// but its block-based API silently truncated each callback's output due to
// per-call priming, so we now do a trivial manual Float32 -> Int16 cast and
// expose the actual capture rate via `currentSampleRate`. Consumers (Core,
// Deepgram, ffmpeg) are told the real rate via the session_start message.

final class AudioEngine {
    typealias PCMSink = (Data) -> Void

    private var engine = AVAudioEngine()
    private let queue = DispatchQueue(label: "vega.ear.audio", qos: .userInitiated)
    private var sinks: [PCMSink] = []
    private var preRoll = RingBuffer<Data>(capacityHint: 100)
    private(set) var isRunning = false
    private(set) var currentDevice: MicDevice?
    private(set) var currentSampleRate: Double = 48_000
    private var tapCallbackCount: Int = 0
    private var tapBytesProducedSinceReport: Int = 0
    private var tapReportAt: Date = Date()

    init() throws {}

    func selectDevice(_ device: MicDevice?) throws {
        NSLog("[VegaEar] AudioEngine.selectDevice begin: target=\(device?.name ?? "(system default)")")
        let wasRunning = isRunning
        if wasRunning { stop() }

        engine = AVAudioEngine()
        NSLog("[VegaEar] AudioEngine rebuilt")

        if let device {
            try Self.setInputDevice(engine.inputNode, deviceId: device.id)
            NSLog("[VegaEar] setInputDevice ok: id=\(device.id) name=\(device.name)")
        }
        currentDevice = device

        if wasRunning {
            try start()
        } else {
            NSLog("[VegaEar] selectDevice complete (engine was idle, not auto-starting)")
        }
    }

    func start() throws {
        if isRunning { return }
        NSLog("[VegaEar] AudioEngine.start: preparing…")

        let mixer = engine.mainMixerNode
        mixer.outputVolume = 0
        let inputFormat = engine.inputNode.inputFormat(forBus: 0)
        NSLog("[VegaEar] AudioEngine.start: connect input→mainMixer, mute, format=\(inputFormat)")
        engine.connect(engine.inputNode, to: mixer, format: inputFormat)

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
        currentSampleRate = inputFormat.sampleRate
        NSLog("[VegaEar] tap installing: format=\(inputFormat) sampleRate=\(currentSampleRate) channels=\(inputFormat.channelCount)")
        input.removeTap(onBus: 0)
        tapCallbackCount = 0
        tapBytesProducedSinceReport = 0
        tapReportAt = Date()
        input.installTap(onBus: 0, bufferSize: 1024, format: inputFormat) { [weak self] buffer, _ in
            guard let self else { return }
            self.tapCallbackCount += 1
            let data = Self.floatBufferToInt16Mono(buffer)
            if self.tapCallbackCount <= 3 {
                NSLog("[VegaEar] tap callback #\(self.tapCallbackCount): frameLength=\(buffer.frameLength) inFmt=\(buffer.format) outBytes=\(data.count)")
            }
            self.tapBytesProducedSinceReport += data.count
            let now = Date()
            if now.timeIntervalSince(self.tapReportAt) >= 2.0 {
                NSLog("[VegaEar] tap throughput: \(self.tapBytesProducedSinceReport) bytes / 2s (callbacks=\(self.tapCallbackCount))")
                self.tapBytesProducedSinceReport = 0
                self.tapReportAt = now
            }
            if data.isEmpty { return }
            self.queue.async {
                self.preRoll.push(data)
                if self.sinks.isEmpty && self.tapCallbackCount <= 3 {
                    NSLog("[VegaEar] tap callback #\(self.tapCallbackCount): WARNING sinks is empty, data discarded")
                }
                for sink in self.sinks {
                    sink(data)
                }
            }
        }
        NSLog("[VegaEar] tap installed")
    }

    // Convert a buffer's first channel of Float32 samples to interleaved Int16.
    // Falls back to int16ChannelData when the engine already gave us int16.
    private static func floatBufferToInt16Mono(_ buffer: AVAudioPCMBuffer) -> Data {
        let frameCount = Int(buffer.frameLength)
        if frameCount == 0 { return Data() }

        if let int16 = buffer.int16ChannelData?[0] {
            let byteCount = frameCount * MemoryLayout<Int16>.size
            return Data(bytes: int16, count: byteCount)
        }
        guard let float = buffer.floatChannelData?[0] else { return Data() }

        var out = Data(count: frameCount * MemoryLayout<Int16>.size)
        out.withUnsafeMutableBytes { rawDst in
            guard let dst = rawDst.baseAddress?.assumingMemoryBound(to: Int16.self) else { return }
            for i in 0..<frameCount {
                let clipped = max(-1.0, min(1.0, float[i]))
                dst[i] = Int16(clipped * 32_767)
            }
        }
        return out
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
