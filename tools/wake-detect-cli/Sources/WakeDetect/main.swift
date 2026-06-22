import Foundation
import OnnxRuntimeBindings

// Standalone ONNX wake-word tester. Mirrors apps/mac-ear's OpenWakeWordDetector
// streaming loop exactly so we can isolate model issues from microphone-capture
// issues. Decodes audio via the `ffmpeg` CLI, then feeds 1280-sample chunks of
// 16 kHz mono int16 PCM through mel → embedding → head ONNX sessions and
// reports per-window scores plus per-file peak.
//
// Usage:
//     swift run wake-detect \
//         --mel  ../../apps/mac-ear/Sources/VegaEar/Resources/melspectrogram.onnx \
//         --emb  ../../apps/mac-ear/Sources/VegaEar/Resources/embedding_model.onnx \
//         --head ../../apps/mac-ear/Sources/VegaEar/Resources/Vega.onnx \
//         --threshold 0.5 \
//         FILE [FILE...]

// MARK: - Args

struct Args {
    var melPath: String = "../../apps/mac-ear/Sources/VegaEar/Resources/melspectrogram.onnx"
    var embPath: String = "../../apps/mac-ear/Sources/VegaEar/Resources/embedding_model.onnx"
    var headPath: String = "../../apps/mac-ear/Sources/VegaEar/Resources/Vega.onnx"
    var threshold: Float = 0.5
    var verbose: Bool = false
    var paths: [String] = []
}

func parseArgs() -> Args {
    var a = Args()
    var i = 1
    let argv = CommandLine.arguments
    while i < argv.count {
        let s = argv[i]
        switch s {
        case "--mel":       i += 1; a.melPath  = argv[i]
        case "--emb":       i += 1; a.embPath  = argv[i]
        case "--head":      i += 1; a.headPath = argv[i]
        case "--threshold": i += 1; a.threshold = Float(argv[i]) ?? 0.5
        case "--verbose", "-v": a.verbose = true
        case "-h", "--help":
            print("""
            wake-detect — stream audio files through OWW + a head ONNX, report peak scores.

              --mel PATH        melspectrogram.onnx     (default: apps/mac-ear bundle)
              --emb PATH        embedding_model.onnx
              --head PATH       Vega.onnx
              --threshold X     fire threshold for the per-file summary [0.5]
              --verbose / -v    print every window score

            Any number of audio files (anything ffmpeg can decode).
            """)
            exit(0)
        default:
            a.paths.append(s)
        }
        i += 1
    }
    if a.paths.isEmpty {
        FileHandle.standardError.write("ERROR: no audio files given\n".data(using: .utf8)!)
        exit(2)
    }
    return a
}

// MARK: - ffmpeg decode

func ffmpegDecodePCM16(_ path: String) throws -> [Int16] {
    let task = Process()
    task.launchPath = "/opt/homebrew/bin/ffmpeg"
    if !FileManager.default.isExecutableFile(atPath: task.launchPath!) {
        task.launchPath = "/usr/local/bin/ffmpeg"
    }
    task.arguments = [
        "-loglevel", "error",
        "-i", path,
        "-ar", "16000",
        "-ac", "1",
        "-f", "s16le",
        "-",
    ]
    let out = Pipe(); let err = Pipe()
    task.standardOutput = out
    task.standardError = err
    try task.run()
    let data = out.fileHandleForReading.readDataToEndOfFile()
    task.waitUntilExit()
    if task.terminationStatus != 0 {
        let e = String(data: err.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        throw NSError(domain: "ffmpeg", code: Int(task.terminationStatus), userInfo: [NSLocalizedDescriptionKey: e])
    }
    var samples = [Int16](repeating: 0, count: data.count / MemoryLayout<Int16>.size)
    _ = samples.withUnsafeMutableBytes { data.copyBytes(to: $0) }
    return samples
}

// MARK: - ORT helpers

func loadSession(_ env: ORTEnv, _ opts: ORTSessionOptions, _ path: String) throws -> (ORTSession, String, String) {
    let s = try ORTSession(env: env, modelPath: path, sessionOptions: opts)
    let inName  = try s.inputNames().first  ?? ""
    let outName = try s.outputNames().first ?? ""
    return (s, inName, outName)
}

func runFloatTensor(_ s: ORTSession, in inName: String, out outName: String,
                    data: [Float], shape: [NSNumber]) throws -> [Float] {
    var mutable = data
    let byteCount = mutable.count * MemoryLayout<Float>.size
    let nsData = mutable.withUnsafeMutableBufferPointer { buf -> NSMutableData in
        NSMutableData(bytes: buf.baseAddress, length: byteCount)
    }
    let input = try ORTValue(tensorData: nsData, elementType: .float, shape: shape)
    let outputs = try s.run(withInputs: [inName: input], outputNames: [outName], runOptions: nil)
    guard let outValue = outputs[outName] else {
        throw NSError(domain: "ort", code: 1, userInfo: [NSLocalizedDescriptionKey: "no output \(outName)"])
    }
    let outData = try outValue.tensorData()
    let count = outData.length / MemoryLayout<Float>.size
    var floats = [Float](repeating: 0, count: count)
    floats.withUnsafeMutableBytes { dst in
        outData.getBytes(dst.baseAddress!, length: outData.length)
    }
    return floats
}

// MARK: - Streaming

let chunkSamples      = 1280
let melContextSamples = 1760
let melHopFramesPerChunk = 8
let embedWindowFrames = 76
let melBins           = 32
let embedDim          = 96
let headWindow        = 16

func streamScores(pcm: [Int16],
                  melSess: ORTSession, melIn: String, melOut: String,
                  embSess: ORTSession, embIn: String, embOut: String,
                  headSess: ORTSession, headIn: String, headOut: String) throws -> [Float] {
    var rawBuffer = pcm
    // Right-pad short clips with silence so at least one window can fire.
    let minSamples = 2 * 16_000 + chunkSamples * 4   // ~2.3s, enough for >=1 head window
    if rawBuffer.count < minSamples {
        rawBuffer.append(contentsOf: [Int16](repeating: 0, count: minSamples - rawBuffer.count))
    }

    var melBuffer: [Float] = []
    var embedBuffer: [Float] = []
    var scores: [Float] = []

    var cursor = melContextSamples
    while cursor <= rawBuffer.count {
        // Mel: raw int16-valued float, NO normalisation.
        let start = cursor - melContextSamples
        var melInput = [Float](repeating: 0, count: melContextSamples)
        for k in 0..<melContextSamples { melInput[k] = Float(rawBuffer[start + k]) }
        let mel = try runFloatTensor(melSess, in: melIn, out: melOut,
                                     data: melInput,
                                     shape: [1, NSNumber(value: melContextSamples)])
        // mel is [1, 1, n_frames, 32]. Take last MEL_HOP_PER_CHUNK frames.
        let producedFrames = mel.count / melBins
        if producedFrames >= melHopFramesPerChunk {
            let newStart = (producedFrames - melHopFramesPerChunk) * melBins
            for k in newStart..<mel.count {
                melBuffer.append(mel[k] / 10.0 + 2.0)
            }
        }

        let melFrameCount = melBuffer.count / melBins
        if melFrameCount >= embedWindowFrames {
            let from = (melFrameCount - embedWindowFrames) * melBins
            let emb = try runFloatTensor(
                embSess, in: embIn, out: embOut,
                data: Array(melBuffer[from..<melBuffer.count]),
                shape: [1, NSNumber(value: embedWindowFrames), NSNumber(value: melBins), 1]
            )
            for k in 0..<embedDim { embedBuffer.append(emb[k]) }
        }

        let totalEmbeds = embedBuffer.count / embedDim
        if totalEmbeds >= headWindow {
            let from = (totalEmbeds - headWindow) * embedDim
            let h = try runFloatTensor(
                headSess, in: headIn, out: headOut,
                data: Array(embedBuffer[from..<embedBuffer.count]),
                shape: [1, NSNumber(value: headWindow), NSNumber(value: embedDim)]
            )
            scores.append(h.first ?? 0)
        }
        cursor += chunkSamples
    }
    return scores
}

// MARK: - Main

headProbeIfRequested()
embProbeIfRequested()
melDumpIfRequested()
embedDumpIfRequested()
let args = parseArgs()

let env = try ORTEnv(loggingLevel: .warning)
let opts = try ORTSessionOptions()
try opts.setIntraOpNumThreads(1)
try opts.setGraphOptimizationLevel(.all)

let (melSess,  melIn,  melOut)  = try loadSession(env, opts, args.melPath)
let (embSess,  embIn,  embOut)  = try loadSession(env, opts, args.embPath)
let (headSess, headIn, headOut) = try loadSession(env, opts, args.headPath)

print("mel  in=\(melIn)  out=\(melOut)")
print("emb  in=\(embIn)  out=\(embOut)")
print("head in=\(headIn)  out=\(headOut)")
print("threshold=\(args.threshold)\n")

var fired = 0
var total = 0
var peaks: [Float] = []

for path in args.paths {
    let url = URL(fileURLWithPath: path)
    let name = url.lastPathComponent
    do {
        let pcm = try ffmpegDecodePCM16(path)
        let dur = Double(pcm.count) / 16000.0
        let scores = try streamScores(pcm: pcm,
                                      melSess: melSess, melIn: melIn, melOut: melOut,
                                      embSess: embSess, embIn: embIn, embOut: embOut,
                                      headSess: headSess, headIn: headIn, headOut: headOut)
        total += 1
        if scores.isEmpty {
            print(String(format: "%-50s  %.2fs  no windows", name, dur))
            continue
        }
        let peak = scores.max() ?? 0
        let peakIdx = scores.firstIndex(of: peak) ?? 0
        peaks.append(peak)
        let didFire = peak >= args.threshold
        if didFire { fired += 1 }
        let mark = didFire ? "FIRE" : "····"
        print(String(format: "%-50s  %.2fs  wins=%-3d peak=%.4f @win=%d  %@",
                     name, dur, scores.count, peak, peakIdx, mark))
        if args.verbose {
            for (i, s) in scores.enumerated() {
                let m = s >= args.threshold ? "✓" : "·"
                print(String(format: "    [%2d] %.4f %@", i, s, m))
            }
        }
    } catch {
        print(String(format: "%-50s  ERROR  %@", name, "\(error)"))
    }
}

print("\n=========================")
print("files: \(fired)/\(total) fired @ threshold \(args.threshold)")
if !peaks.isEmpty {
    let mean = peaks.reduce(0, +) / Float(peaks.count)
    let mn = peaks.min() ?? 0
    let mx = peaks.max() ?? 0
    print(String(format: "peak: min=%.4f mean=%.4f max=%.4f", mn, mean, mx))
}
