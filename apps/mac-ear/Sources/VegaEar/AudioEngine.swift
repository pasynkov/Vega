import AVFoundation
import Foundation

// Captures 48 kHz mono PCM from the default input device and broadcasts the
// frames to two consumers: the wake-word detector and the session capture
// pipeline. A 1-second pre-roll ring buffer is retained so a session can
// include the moments just before the wake word fired.

final class AudioEngine {
    typealias PCMSink = (Data) -> Void

    let sampleRate: Double = 48_000
    private let engine = AVAudioEngine()
    private let queue = DispatchQueue(label: "vega.ear.audio", qos: .userInitiated)
    private var sinks: [PCMSink] = []
    private var preRoll = RingBuffer<Data>(capacityHint: 50)

    init() throws {
        let input = engine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        let targetFormat = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: sampleRate,
            channels: 1,
            interleaved: true
        )!

        // Install the tap on the input bus and convert chunks to mono int16 at 48 kHz.
        input.installTap(onBus: 0, bufferSize: 1024, format: inputFormat) { [weak self] buffer, _ in
            guard let self else { return }
            guard let converted = Self.convert(buffer: buffer, to: targetFormat) else { return }
            let data = Self.dataFromBuffer(converted)
            self.queue.async {
                self.preRoll.push(data)
                for sink in self.sinks {
                    sink(data)
                }
            }
        }
    }

    func start() throws {
        engine.prepare()
        try engine.start()
    }

    func stop() {
        engine.stop()
    }

    func addSink(_ sink: @escaping PCMSink) {
        queue.async { self.sinks.append(sink) }
    }

    func drainPreRoll() -> [Data] {
        var copy: [Data] = []
        queue.sync { copy = preRoll.drain() }
        return copy
    }

    private static func convert(buffer: AVAudioPCMBuffer, to targetFormat: AVAudioFormat) -> AVAudioPCMBuffer? {
        guard let converter = AVAudioConverter(from: buffer.format, to: targetFormat) else { return nil }
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
