import AppKit

enum CueSound: String {
    case wake
    case endpoint
    case error
    case ackDone
    case ackContinue
    case ackThinking
    case ackSuccess
    case ackError
    case ackUnknown
    case cueListen

    var systemSoundPath: String {
        switch self {
        case .wake: return "/System/Library/Sounds/Purr.aiff"
        case .endpoint: return "/System/Library/Sounds/Pop.aiff"
        case .error: return "/System/Library/Sounds/Basso.aiff"
        case .ackDone: return "/System/Library/Sounds/Tink.aiff"
        case .ackContinue: return "/System/Library/Sounds/Submarine.aiff"
        case .ackThinking: return "/System/Library/Sounds/Bottle.aiff"
        case .ackSuccess: return "/System/Library/Sounds/Glass.aiff"
        case .ackError: return "/System/Library/Sounds/Basso.aiff"
        case .ackUnknown: return "/System/Library/Sounds/Funk.aiff"
        // Ask-session listening cue. Tink is short and unambiguous as a
        // "I'm waiting for one short reply" tap.
        case .cueListen: return "/System/Library/Sounds/Tink.aiff"
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
