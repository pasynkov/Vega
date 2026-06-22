import EarCore
import Foundation
import OnnxRuntimeBindings

// OpenWakeWord ONNX-based wake-word detector.
//
// Pipeline (per the upstream openWakeWord reference impl):
//
//   1. Accumulate Int16 16 kHz mono PCM into a raw-sample buffer.
//   2. Every 1280 samples (80 ms hop), run `melspectrogram.onnx` over the
//      most recent 1760 samples (= 1280 new + 480 carry-over for frame
//      alignment) to produce 8 new mel frames of 32 bins each. Apply the
//      `(x / 10) + 2` transform that openWakeWord uses to match the
//      original TF speech-embedding model's expectations.
//   3. Run `embedding_model.onnx` over the most recent 76 mel frames to
//      produce a single 96-dim embedding. Append it to the embedding
//      buffer.
//   4. For each classifier head, when the embedding buffer holds at
//      least 16 entries, slice the last 16 embeddings and run the head;
//      its output is a single sigmoid score in [0, 1]. Fire `onDetect`
//      with the first candidate whose score crosses the threshold and
//      hold a short cooldown to prevent double-fires from one utterance.
//
// All ONNX call sites are confined to this file — the rest of the app sees
// only the `WakeWordDetector` protocol.

final class OpenWakeWordDetector: WakeWordDetector {
    var onDetect: ((Float) -> Void)?
    let requiredSampleRate: Double = 16_000

    // OWW streaming constants.
    private let chunkSamples = 1280            // 80 ms hop at 16 kHz
    private let melContextSamples = 1760       // 1280 + 480 carry-over
    private let melHopFramesPerChunk = 8       // mel frames added per 1280-sample chunk
    private let embedWindowFrames = 76         // mel frames per embedding inference
    private let melBins = 32
    private let embedDim = 96
    private let classifierWindow = 16          // embeddings per classifier inference
    private let cooldownSeconds: TimeInterval = 1.5
    // RMS-based audio-energy gate over the last ~1.28 s of raw mic samples.
    // The head can hallucinate on quiet mic floors the training data never
    // covered — gate makes the runtime ignore those ranges entirely.
    // Measured: real-mic silence captures peak at ~70 int16 RMS, real "Вега"
    // recordings start at ~115. Gate at 90 cleanly separates with a margin.
    private let rmsGate: Double = 90.0

    private struct Classifier {
        let name: String
        let session: ORTSession
        let inputName: String
        let outputName: String
        let windowFrames: Int                  // typically 16
    }

    private let env: ORTEnv
    private let sessionOptions: ORTSessionOptions
    private let melSession: ORTSession
    private let melInputName: String
    private let melOutputName: String
    private let embedSession: ORTSession
    private let embedInputName: String
    private let embedOutputName: String
    private let classifiers: [Classifier]

    // Mutable state (only mutated from `feed` which the coordinator serialises).
    private var rawBuffer: [Int16] = []
    private var melBuffer: [Float] = []        // flat row-major frames * 32 bins
    private var embedBuffer: [Float] = []      // flat row-major embeddings * 96 dims
    // Side ringbuffer kept just for the RMS energy gate — `rawBuffer` shrinks
    // as chunks are processed, so we can't use it for a multi-second RMS view.
    private var energyBuffer: [Int16] = []
    private let energyWindowSamples: Int       // initialised in init from chunkSamples * classifierWindow
    private var lastDetectAt: Date?
    private var threshold: Float

    init(threshold: Double, candidateNames: [String] = ["Vega"]) throws {
        self.threshold = Float(threshold)
        self.energyWindowSamples = 1280 * 16  // chunkSamples * classifierWindow; 1.28 s @ 16 kHz

        env = try ORTEnv(loggingLevel: .warning)
        sessionOptions = try ORTSessionOptions()
        try sessionOptions.setIntraOpNumThreads(1)
        try sessionOptions.setGraphOptimizationLevel(.all)

        let (mSession, mIn, mOut) = try Self.loadSession(
            resource: "melspectrogram", env: env, options: sessionOptions
        )
        melSession = mSession
        melInputName = mIn
        melOutputName = mOut

        let (eSession, eIn, eOut) = try Self.loadSession(
            resource: "embedding_model", env: env, options: sessionOptions
        )
        embedSession = eSession
        embedInputName = eIn
        embedOutputName = eOut

        var loaded: [Classifier] = []
        for name in candidateNames {
            let (s, i, o) = try Self.loadSession(resource: name, env: env, options: sessionOptions)
            let win = try Self.detectClassifierWindow(session: s, inputName: i) ?? classifierWindow
            loaded.append(Classifier(
                name: name, session: s, inputName: i, outputName: o, windowFrames: win
            ))
        }
        classifiers = loaded
        rawBuffer.reserveCapacity(chunkSamples * 4)
        melBuffer.reserveCapacity(melBins * 200)
        embedBuffer.reserveCapacity(embedDim * 200)

        NSLog("[VegaEar] OWW detector ready threshold=\(threshold) candidates=\(candidateNames.joined(separator: ","))")
    }

    func start() throws {}
    func stop() {}

    func setThreshold(_ value: Double) {
        let clamped = max(0.0, min(1.0, value))
        threshold = Float(clamped)
        NSLog("[VegaEar] OWW threshold set to \(clamped)")
    }

    func feed(_ pcm: Data) {
        let sampleCount = pcm.count / MemoryLayout<Int16>.size
        guard sampleCount > 0 else { return }
        var newSamples = [Int16](repeating: 0, count: sampleCount)
        _ = newSamples.withUnsafeMutableBytes { pcm.copyBytes(to: $0) }
        rawBuffer.append(contentsOf: newSamples)
        // Mirror into the energy ring (cap = 1.28 s) for the gate check.
        // `rawBuffer` is consumed as chunks are processed, so it cannot
        // carry a multi-second window for RMS calculation.
        energyBuffer.append(contentsOf: newSamples)
        if energyBuffer.count > energyWindowSamples {
            energyBuffer.removeFirst(energyBuffer.count - energyWindowSamples)
        }

        // Keep ~5 seconds of raw audio for context (more than enough — only
        // the last 1760 samples are actually used per chunk).
        let rawCap = chunkSamples * 64
        if rawBuffer.count > rawCap {
            rawBuffer.removeFirst(rawBuffer.count - rawCap)
        }

        // Cap mel and embedding buffers so unbounded operation does not
        // leak memory. ~10 seconds of mel ≈ 97 frames * 10 = 970 frames.
        let melFrameCap = 200 * melBins
        let embedCap = 200 * embedDim

        // Process one 1280-sample step at a time. We only fire if we just
        // crossed a 1280-sample boundary since the last process step.
        var processed = 0
        while rawBuffer.count - processed >= chunkSamples,
              rawBuffer.count >= melContextSamples {
            processed += chunkSamples

            do {
                try runStreamingStep()
            } catch {
                NSLog("[VegaEar] OWW step error: \(error)")
                return
            }

            if melBuffer.count > melFrameCap {
                let extra = melBuffer.count - melFrameCap
                melBuffer.removeFirst(extra)
            }
            if embedBuffer.count > embedCap {
                let extra = embedBuffer.count - embedCap
                embedBuffer.removeFirst(extra)
            }

            // Drop the chunk we just consumed from the raw buffer so the
            // next loop iteration sees a fresh chunk on top.
            if rawBuffer.count >= chunkSamples {
                // We do not pop chunkSamples here yet; we pop after the
                // outer loop completes so that `runStreamingStep` always
                // sees the full carry-over context.
            }
        }
        if processed > 0 {
            rawBuffer.removeFirst(min(processed, rawBuffer.count))
        }
    }

    // MARK: - Streaming step

    // One iteration: 1280 new samples → 8 mel frames → 1 embedding →
    // 1 classifier score per candidate.
    private func runStreamingStep() throws {
        // Mel input: the last `melContextSamples` (1760) Int16 samples
        // cast to Float32 *without* normalisation. openWakeWord's
        // melspectrogram.onnx was trained to receive raw int16-valued
        // floats, not amplitude-normalised [-1, 1].
        let start = rawBuffer.count - melContextSamples
        precondition(start >= 0, "raw buffer should always hold ≥ melContextSamples by the time we reach here")
        var melInputData = [Float](repeating: 0, count: melContextSamples)
        for i in 0..<melContextSamples {
            melInputData[i] = Float(rawBuffer[start + i])
        }
        let melOutput = try runFloatTensor(
            session: melSession,
            inputName: melInputName,
            outputName: melOutputName,
            data: melInputData,
            shape: [1, NSNumber(value: melContextSamples)]
        )
        // Mel output shape `[1, 1, n_frames, 32]`. We expect n_frames == 8.
        let producedFrames = melOutput.values.count / melBins
        if producedFrames < melHopFramesPerChunk {
            // Not enough mel context yet — skip this step quietly.
            return
        }
        // Apply OWW's standard transform x/10 + 2 and append the most
        // recent 8 frames (the model can produce more if its receptive
        // field is wider; we only care about the new ones).
        let newFramesStart = (producedFrames - melHopFramesPerChunk) * melBins
        for i in newFramesStart..<melOutput.values.count {
            melBuffer.append(melOutput.values[i] / 10.0 + 2.0)
        }

        // Need at least 76 mel frames for one embedding inference.
        let melFrameCount = melBuffer.count / melBins
        guard melFrameCount >= embedWindowFrames else { return }
        let windowStart = (melFrameCount - embedWindowFrames) * melBins
        let embedInputData = Array(melBuffer[windowStart..<melBuffer.count])
        let embedOutput = try runFloatTensor(
            session: embedSession,
            inputName: embedInputName,
            outputName: embedOutputName,
            data: embedInputData,
            // Embedding input is `[1, 76, 32, 1]`.
            shape: [1, NSNumber(value: embedWindowFrames), NSNumber(value: melBins), 1]
        )
        // Take the first (and only) embedding from the output.
        // Output shape is `[1, 1, 1, 96]` — we just append the flat 96 values.
        if embedOutput.values.count < embedDim {
            NSLog("[VegaEar] OWW unexpected embedding output count=\(embedOutput.values.count)")
            return
        }
        for i in 0..<embedDim {
            embedBuffer.append(embedOutput.values[i])
        }

        // Run each classifier head if we have enough embeddings.
        let totalEmbeddings = embedBuffer.count / embedDim
        // Cooldown: if we recently fired, skip classifier scoring entirely.
        if let last = lastDetectAt, Date().timeIntervalSince(last) < cooldownSeconds {
            return
        }

        // Energy gate: skip head inference on near-silent input.
        // RMS over the side `energyBuffer` (≈ 1.28 s of mic samples) since
        // `rawBuffer` is consumed as chunks are processed and would only ever
        // hold ~melContextSamples worth of data here.
        if energyBuffer.count >= energyWindowSamples / 2 {
            var sumSq: Double = 0
            for s in energyBuffer { let d = Double(s); sumSq += d * d }
            let rms = (sumSq / Double(energyBuffer.count)).squareRoot()
            if rms < rmsGate {
                return
            }
        }

        for clf in classifiers {
            let win = clf.windowFrames
            guard totalEmbeddings >= win else { continue }
            let sliceStart = (totalEmbeddings - win) * embedDim
            let clfInputData = Array(embedBuffer[sliceStart..<embedBuffer.count])
            let clfOutput = try runFloatTensor(
                session: clf.session,
                inputName: clf.inputName,
                outputName: clf.outputName,
                data: clfInputData,
                shape: [1, NSNumber(value: win), NSNumber(value: embedDim)]
            )
            guard let raw = clfOutput.values.first else { continue }
            let score = raw
            if score >= threshold {
                lastDetectAt = Date()
                NSLog("[VegaEar] OWW wake fired candidate=\(clf.name) score=\(score) threshold=\(threshold)")
                onDetect?(score)
                return
            }
        }
    }

    // MARK: - ORT helpers

    private struct FloatTensorOutput {
        let values: [Float]
    }

    private func runFloatTensor(
        session: ORTSession,
        inputName: String,
        outputName: String,
        data: [Float],
        shape: [NSNumber]
    ) throws -> FloatTensorOutput {
        var mutable = data
        let byteCount = mutable.count * MemoryLayout<Float>.size
        let nsData = mutable.withUnsafeMutableBufferPointer { buf -> NSMutableData in
            return NSMutableData(bytes: buf.baseAddress, length: byteCount)
        }
        let inputValue = try ORTValue(
            tensorData: nsData,
            elementType: .float,
            shape: shape
        )
        let outputs = try session.run(
            withInputs: [inputName: inputValue],
            outputNames: [outputName],
            runOptions: nil
        )
        guard let outValue = outputs[outputName] else {
            throw VegaEarError.missingResource("ORT output \(outputName)")
        }
        let outData = try outValue.tensorData()
        let floatCount = outData.length / MemoryLayout<Float>.size
        var floats = [Float](repeating: 0, count: floatCount)
        floats.withUnsafeMutableBytes { dst in
            outData.getBytes(dst.baseAddress!, length: outData.length)
        }
        return FloatTensorOutput(values: floats)
    }

    private static func loadSession(
        resource: String,
        env: ORTEnv,
        options: ORTSessionOptions
    ) throws -> (ORTSession, String, String) {
        guard let url = Bundle.module.url(forResource: resource, withExtension: "onnx") else {
            throw VegaEarError.missingResource("\(resource).onnx (expected in Sources/VegaEar/Resources/)")
        }
        let session = try ORTSession(env: env, modelPath: url.path, sessionOptions: options)
        let inputs = try session.inputNames()
        let outputs = try session.outputNames()
        guard let inName = inputs.first, let outName = outputs.first else {
            throw VegaEarError.missingResource("\(resource).onnx has no input/output")
        }
        return (session, inName, outName)
    }

    // Classifier heads vary in their per-frame window size (typically 16).
    // We cannot directly introspect tensor shapes through the ObjC API the
    // same way Python does, so we fall back to `classifierWindow` if shape
    // metadata is unavailable. Returns nil when we should fall back.
    private static func detectClassifierWindow(session: ORTSession, inputName: String) throws -> Int? {
        // The ORT Objective-C binding does not expose static input shapes,
        // so we keep the default of 16 (which is what the community models
        // we ship use). Concrete shape mismatches will fail loudly at the
        // first `session.run` call instead.
        return nil
    }
}

enum VegaEarError: Error, LocalizedError {
    case missingResource(String)

    var errorDescription: String? {
        switch self {
        case .missingResource(let name): return "Missing resource: \(name)"
        }
    }
}
