import Foundation

public protocol WakeWordDetector: AnyObject {
    var onDetect: ((Float) -> Void)? { get set }
    var requiredSampleRate: Double { get }
    func feed(_ pcm: Data)
    func start() throws
    func stop()
}

public final class NoopWakeDetector: WakeWordDetector {
    public var onDetect: ((Float) -> Void)?
    public let requiredSampleRate: Double = 16_000

    public init() {}

    public func feed(_ pcm: Data) {}
    public func start() throws {}
    public func stop() {}
}
