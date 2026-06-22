import AVFoundation
import EarCore
import Foundation

/// iOS implementation of CuePlaying. Plays bundled .caf/.aiff cue files
/// via AVAudioPlayer. When a cue's asset is missing we fall back to
/// AudioServicesPlaySystemSound for a short generic tone so the user
/// hears *some* acknowledgement.
final class iOSCuePlayer: CuePlaying {
    private var cache: [CueSound: AVAudioPlayer] = [:]

    func play(_ cue: CueSound) {
        if let player = cache[cue] {
            player.stop()
            player.currentTime = 0
            player.play()
            return
        }
        guard let url = Self.assetURL(for: cue) else {
            AudioServicesPlaySystemSound(SystemSoundID(1057))  // Tink
            return
        }
        do {
            let player = try AVAudioPlayer(contentsOf: url)
            cache[cue] = player
            player.prepareToPlay()
            player.play()
        } catch {
            NSLog("[VegaEariOS] cue player error: \(error)")
        }
    }

    private static func assetURL(for cue: CueSound) -> URL? {
        // Until bundled assets land, every cue resolves to nil and the
        // fallback system sound plays. The mapping is here so adding
        // assets later is a no-code change.
        return Bundle.main.url(forResource: cue.rawValue, withExtension: "caf")
            ?? Bundle.main.url(forResource: cue.rawValue, withExtension: "aiff")
            ?? Bundle.main.url(forResource: cue.rawValue, withExtension: "wav")
    }
}
