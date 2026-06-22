import AVFAudio
import AVFoundation
import EarCore
import Foundation

/// AVAudioEngine-based capture for iOS. Produces 16-bit linear PCM
/// blocks from the input node's tap and broadcasts to sinks. Sample
/// rate is taken from the active AVAudioSession.
final class iOSAudioCapturing: AudioCapturing {
    var currentSampleRate: Double = 16_000

    private let engine = AVAudioEngine()
    private let queue = DispatchQueue(label: "vega.ear.ios.audio")
    private var sinks: [(Data) -> Void] = []
    private var tapInstalled = false

    func addSink(_ sink: @escaping (Data) -> Void) {
        queue.async { self.sinks.append(sink) }
    }

    /// Synthetically push a buffer of raw PCM through every attached
    /// sink — used by the VAD trigger to replay the ~400 ms pre-roll
    /// that captured the start of the user's phrase before VAD fired.
    /// Same queue as live frames so ordering is preserved.
    func injectPreroll(_ pcm: Data) {
        queue.async {
            for sink in self.sinks { sink(pcm) }
        }
    }

    private var tapCallbacks: Int = 0
    func start() throws {
        if engine.isRunning { return }
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        currentSampleRate = format.sampleRate
        NSLog("[VegaEariOS] iOSAudioCapturing.start sampleRate=\(format.sampleRate) channels=\(format.channelCount)")

        if !tapInstalled {
            input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
                guard let self else { return }
                let data = Self.convertToInt16Data(buffer: buffer)
                self.tapCallbacks += 1
                if self.tapCallbacks <= 5 || self.tapCallbacks % 200 == 0 {
                    NSLog("[VegaEariOS] mic tap #\(self.tapCallbacks) frames=\(buffer.frameLength) bytes=\(data.count)")
                }
                self.queue.async {
                    for sink in self.sinks { sink(data) }
                }
            }
            tapInstalled = true
        }

        engine.prepare()
        try engine.start()
        NSLog("[VegaEariOS] iOSAudioCapturing engine started")
    }

    func stop() {
        engine.stop()
        if tapInstalled {
            engine.inputNode.removeTap(onBus: 0)
            tapInstalled = false
        }
    }

    private static func convertToInt16Data(buffer: AVAudioPCMBuffer) -> Data {
        guard let floats = buffer.floatChannelData?[0] else { return Data() }
        let frameCount = Int(buffer.frameLength)
        var samples = [Int16](repeating: 0, count: frameCount)
        for i in 0..<frameCount {
            let clipped = max(-1.0, min(1.0, floats[i]))
            samples[i] = Int16(clipped * 32_767)
        }
        return samples.withUnsafeBufferPointer { Data(buffer: $0) }
    }
}
