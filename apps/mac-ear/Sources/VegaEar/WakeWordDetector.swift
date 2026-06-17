import Foundation

protocol WakeWordDetector: AnyObject {
    var onDetect: ((Float) -> Void)? { get set }
    var requiredSampleRate: Double { get }
    func feed(_ pcm: Data)
    func start() throws
    func stop()
}

final class NoopWakeDetector: WakeWordDetector {
    var onDetect: ((Float) -> Void)?
    let requiredSampleRate: Double = 16_000

    func feed(_ pcm: Data) {}
    func start() throws {}
    func stop() {}
}
