// Debug helper: invoke with env VEGA_HEAD_PROBE=1 to test the head in isolation.
import Foundation
import OnnxRuntimeBindings

func headProbeIfRequested() {
    guard ProcessInfo.processInfo.environment["VEGA_HEAD_PROBE"] != nil else { return }
    let env = try! ORTEnv(loggingLevel: .warning)
    let opts = try! ORTSessionOptions()
    try! opts.setIntraOpNumThreads(1)
    try! opts.setGraphOptimizationLevel(.all)
    let path = ProcessInfo.processInfo.environment["VEGA_HEAD"]
        ?? "../../apps/mac-ear/Sources/VegaEar/Resources/Vega.onnx"
    let s = try! ORTSession(env: env, modelPath: path, sessionOptions: opts)
    let inName = try! s.inputNames().first!
    let outName = try! s.outputNames().first!
    print("== probe head ==")
    print("inputs:  \(try! s.inputNames())")
    print("outputs: \(try! s.outputNames())")

    func runOne(_ tag: String, _ value: Float) {
        let n = 16 * 96
        var data = [Float](repeating: value, count: n)
        let bytes = data.count * MemoryLayout<Float>.size
        let nsd = data.withUnsafeMutableBufferPointer { buf in
            NSMutableData(bytes: buf.baseAddress, length: bytes)
        }
        let v = try! ORTValue(tensorData: nsd, elementType: .float, shape: [1, 16, 96])
        let outs = try! s.run(withInputs: [inName: v], outputNames: [outName], runOptions: nil)
        let outData = try! outs[outName]!.tensorData()
        var f = [Float](repeating: 0, count: outData.length / 4)
        f.withUnsafeMutableBytes { dst in outData.getBytes(dst.baseAddress!, length: outData.length) }
        print("[\(tag)] in=\(value) → \(f)")
    }
    runOne("all-zero",     0.0)
    runOne("all-one",      1.0)
    runOne("all-neg-one", -1.0)
    runOne("all-five",     5.0)
    exit(0)
}

// Probe embedding model with synthetic constant input (no audio).
// Trigger with env VEGA_EMB_PROBE=value
func embProbeIfRequested() {
    guard let valStr = ProcessInfo.processInfo.environment["VEGA_EMB_PROBE"] else { return }
    let value = Float(valStr) ?? 3.5
    let embPath = ProcessInfo.processInfo.environment["VEGA_EMB"]
        ?? "../../apps/mac-ear/Sources/VegaEar/Resources/embedding_model.onnx"
    let env = try! ORTEnv(loggingLevel: .warning)
    let opts = try! ORTSessionOptions()
    try! opts.setIntraOpNumThreads(1)
    let optLevel = ProcessInfo.processInfo.environment["VEGA_OPT"] ?? "all"
    switch optLevel {
    case "none":     try! opts.setGraphOptimizationLevel(.none)
    case "basic":    try! opts.setGraphOptimizationLevel(.basic)
    case "extended": try! opts.setGraphOptimizationLevel(.extended)
    default:         try! opts.setGraphOptimizationLevel(.all)
    }
    print("opt=\(optLevel)")
    let s = try! ORTSession(env: env, modelPath: embPath, sessionOptions: opts)
    let ei = try! s.inputNames().first!
    let eo = try! s.outputNames().first!
    print("emb in=\(ei) out=\(eo)")
    var data = [Float](repeating: value, count: 76 * 32)
    let bytes = data.count * MemoryLayout<Float>.size
    let nsd = data.withUnsafeMutableBufferPointer { buf in
        NSMutableData(bytes: buf.baseAddress, length: bytes)
    }
    let v = try! ORTValue(tensorData: nsd, elementType: .float, shape: [1, 76, 32, 1])
    let outs = try! s.run(withInputs: [ei: v], outputNames: [eo], runOptions: nil)
    let od = try! outs[eo]!.tensorData()
    var f = [Float](repeating: 0, count: od.length / 4)
    f.withUnsafeMutableBytes { dst in od.getBytes(dst.baseAddress!, length: od.length) }
    print("output elements=\(f.count)")
    print("first 96: \(f.prefix(96).map { String(format: "%.4f", $0) }.joined(separator: ","))")
    exit(0)
}

// Dump mel output from first 1760 samples of a wav.
// Trigger with env VEGA_MEL_DUMP=path/to.wav
func melDumpIfRequested() {
    guard let wav = ProcessInfo.processInfo.environment["VEGA_MEL_DUMP"] else { return }
    let melPath = ProcessInfo.processInfo.environment["VEGA_MEL"]
        ?? "../../apps/mac-ear/Sources/VegaEar/Resources/melspectrogram.onnx"
    let env = try! ORTEnv(loggingLevel: .warning)
    let opts = try! ORTSessionOptions()
    try! opts.setIntraOpNumThreads(1)
    try! opts.setGraphOptimizationLevel(.all)
    let mel = try! ORTSession(env: env, modelPath: melPath, sessionOptions: opts)
    let mi = try! mel.inputNames().first!
    let mo = try! mel.outputNames().first!
    let pcm = try! ffmpegDecodePCM16(wav)
    var window = [Float](repeating: 0, count: 1760)
    for k in 0..<1760 { window[k] = Float(pcm[k]) }
    let m = try! runFloatTensor(mel, in: mi, out: mo, data: window,
                                shape: [1, NSNumber(value: 1760)])
    print("mel output count=\(m.count)  frames=\(m.count/32)")
    print("first 32 (frame 0):")
    print(m.prefix(32).map { String(format: "%.4f", $0) }.joined(separator: ","))
    print("last 32 (final frame):")
    print(m.suffix(32).map { String(format: "%.4f", $0) }.joined(separator: ","))
    exit(0)
}

// Dump first 96-dim embedding from a wav file via the mel + embed pipeline.
// Trigger with env VEGA_EMBED_DUMP=path/to.wav
func embedDumpIfRequested() {
    guard let wav = ProcessInfo.processInfo.environment["VEGA_EMBED_DUMP"] else { return }
    let melPath = ProcessInfo.processInfo.environment["VEGA_MEL"]
        ?? "../../apps/mac-ear/Sources/VegaEar/Resources/melspectrogram.onnx"
    let embPath = ProcessInfo.processInfo.environment["VEGA_EMB"]
        ?? "../../apps/mac-ear/Sources/VegaEar/Resources/embedding_model.onnx"

    let env = try! ORTEnv(loggingLevel: .warning)
    let opts = try! ORTSessionOptions()
    try! opts.setIntraOpNumThreads(1)
    try! opts.setGraphOptimizationLevel(.all)
    let mel = try! ORTSession(env: env, modelPath: melPath, sessionOptions: opts)
    let emb = try! ORTSession(env: env, modelPath: embPath, sessionOptions: opts)
    let mi = try! mel.inputNames().first!
    let mo = try! mel.outputNames().first!
    let ei = try! emb.inputNames().first!
    let eo = try! emb.outputNames().first!

    let pcm = try! ffmpegDecodePCM16(wav)
    print("pcm samples: \(pcm.count)  first10=\(pcm.prefix(10).map{Int($0)})")

    var melBuf: [Float] = []
    let melCtx = 1760
    let chunk = 1280
    let melBins = 32
    let melHop = 8
    let embWin = 76
    let embDim = 96

    var cursor = melCtx
    while cursor <= pcm.count {
        var window = [Float](repeating: 0, count: melCtx)
        for k in 0..<melCtx { window[k] = Float(pcm[cursor - melCtx + k]) }
        let m = try! runFloatTensor(mel, in: mi, out: mo, data: window,
                                    shape: [1, NSNumber(value: melCtx)])
        let frames = m.count / melBins
        if frames >= melHop {
            let from = (frames - melHop) * melBins
            for k in from..<m.count { melBuf.append(m[k] / 10.0 + 2.0) }
        }
        let melFrames = melBuf.count / melBins
        if melFrames >= embWin {
            let from = (melFrames - embWin) * melBins
            let e = try! runFloatTensor(
                emb, in: ei, out: eo,
                data: Array(melBuf[from..<melBuf.count]),
                shape: [1, NSNumber(value: embWin), NSNumber(value: melBins), 1]
            )
            print("first embedding (96 dims):")
            print(e.prefix(96).map { String(format: "%.4f", $0) }.joined(separator: ","))
            exit(0)
        }
        cursor += chunk
    }
    print("not enough audio for one embedding")
    exit(1)
}
