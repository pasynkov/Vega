import Foundation
import PvPorcupine

// Direct binding to Picovoice's C Porcupine SDK. Picovoice's official Swift
// SDK targets iOS only (its `ios-voice-processor` dependency uses
// AVAudioSession which is unavailable on macOS), so we wrap the C API
// ourselves. We do not need their VoiceProcessor because AudioEngine already
// owns microphone capture in this app.
//
// The `Vega.ppn` keyword file must be present in the app's resource bundle
// (drop it into `Sources/VegaEar/Resources/`). It is generated for the
// `mac (Apple Silicon)` or `mac (Intel)` platform via the Picovoice console.

final class PorcupineDetector: WakeWordDetector {
    var onDetect: ((Float) -> Void)?
    let requiredSampleRate: Double = 16_000

    private var handle: OpaquePointer?
    private let frameLength: Int
    private var pendingSamples: [Int16] = []

    init(accessKey: String, audioFrameSink: @escaping () -> Void = {}) throws {
        guard let modelURL = Bundle.module.url(forResource: "porcupine_params", withExtension: "pv") else {
            throw VegaEarError.missingResource("porcupine_params.pv (vendored under Vendor/PvModel)")
        }
        guard let keywordURL = Bundle.module.url(forResource: "Vega", withExtension: "ppn") else {
            throw VegaEarError.missingResource("Vega.ppn (drop into Sources/VegaEar/Resources/)")
        }

        var handle: OpaquePointer?
        let sensitivity: Float = 0.5

        let status = accessKey.withCString { accessKeyPtr -> pv_status_t in
            modelURL.path.withCString { modelPathPtr in
                keywordURL.path.withCString { keywordPathPtr in
                    var keywordPaths: [UnsafePointer<CChar>?] = [keywordPathPtr]
                    var sensitivities: [Float] = [sensitivity]
                    return keywordPaths.withUnsafeMutableBufferPointer { kwBuf in
                        sensitivities.withUnsafeMutableBufferPointer { senBuf in
                            pv_porcupine_init(
                                accessKeyPtr,
                                modelPathPtr,
                                1,
                                kwBuf.baseAddress,
                                senBuf.baseAddress,
                                &handle
                            )
                        }
                    }
                }
            }
        }

        guard status == PV_STATUS_SUCCESS, let h = handle else {
            throw VegaEarError.missingSecret("Porcupine init failed (status=\(status.rawValue)). Check PICOVOICE_ACCESS_KEY and slot availability.")
        }
        self.handle = h
        self.frameLength = Int(pv_porcupine_frame_length())
    }

    deinit {
        if let handle {
            pv_porcupine_delete(handle)
        }
    }

    func feed(_ pcm: Data) {
        pcm.withUnsafeBytes { raw in
            let buffer = raw.bindMemory(to: Int16.self)
            pendingSamples.append(contentsOf: buffer)
        }
        while pendingSamples.count >= frameLength {
            let frame = Array(pendingSamples.prefix(frameLength))
            pendingSamples.removeFirst(frameLength)
            guard let handle else { return }
            var keywordIndex: Int32 = -1
            let status = frame.withUnsafeBufferPointer { buf -> pv_status_t in
                pv_porcupine_process(handle, buf.baseAddress, &keywordIndex)
            }
            if status == PV_STATUS_SUCCESS, keywordIndex >= 0 {
                onDetect?(1.0)
            }
        }
    }

    func start() throws {}
    func stop() {}
}

enum VegaEarError: Error, LocalizedError {
    case missingResource(String)
    case missingSecret(String)

    var errorDescription: String? {
        switch self {
        case .missingResource(let name): return "Missing resource: \(name)"
        case .missingSecret(let name): return "Missing secret: \(name)"
        }
    }
}
