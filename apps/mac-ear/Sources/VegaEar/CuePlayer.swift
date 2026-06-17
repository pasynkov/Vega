import AppKit

enum CueSound: String {
    case wake
    case endpoint
    case error

    var systemSoundPath: String {
        switch self {
        case .wake: return "/System/Library/Sounds/Tink.aiff"
        case .endpoint: return "/System/Library/Sounds/Pop.aiff"
        case .error: return "/System/Library/Sounds/Basso.aiff"
        }
    }
}

final class CuePlayer {
    private var cache: [CueSound: NSSound] = [:]

    func play(_ cue: CueSound) {
        let sound: NSSound
        if let cached = cache[cue] {
            sound = cached
        } else if let loaded = NSSound(contentsOfFile: cue.systemSoundPath, byReference: true) {
            cache[cue] = loaded
            sound = loaded
        } else {
            NSLog("[VegaEar] Could not load cue \(cue.rawValue) at \(cue.systemSoundPath)")
            return
        }
        // NSSound.play returns false if already playing; reset and try again.
        sound.stop()
        sound.play()
    }
}
