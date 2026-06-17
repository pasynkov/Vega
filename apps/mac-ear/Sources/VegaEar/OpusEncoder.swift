import Foundation

// The MVP wire codec is `linear16`: the Ear streams raw PCM directly to Core.
// Core encodes the persisted artifact to OGG/OPUS via ffmpeg (see
// `apps/core/src/recording/recording-store.ts`). This protocol exists so a
// future change can swap in a real on-device encoder (Apple's
// `AVAudioConverter` with `kAudioFormatOpus`, libopus via a Swift bridge, etc.)
// without changing the session-coordinator wiring.

protocol AudioFrameProducer {
    func encode(_ pcm: Data) throws -> [Data]
    func flush() throws -> [Data]
}

final class PcmPassthroughEncoder: AudioFrameProducer {
    func encode(_ pcm: Data) throws -> [Data] {
        return [pcm]
    }

    func flush() throws -> [Data] {
        return []
    }
}
