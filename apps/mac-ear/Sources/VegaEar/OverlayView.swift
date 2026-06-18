import SwiftUI
import EarProtocol

struct OverlayView: View {
    @ObservedObject var vm: OverlayViewModel

    var body: some View {
        VStack(spacing: 14) {
            if let hint = vm.hint, !hint.isEmpty {
                Text(hint)
                    .font(.callout)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.primary)
                    .lineLimit(2)
            }
            Orb(kind: vm.kind)
                .frame(width: 96, height: 96)
            if let caption = vm.caption, !caption.isEmpty {
                Text(caption)
                    .font(.footnote)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
            }
        }
        .padding(.horizontal, 22)
        .padding(.vertical, 18)
        .frame(maxWidth: 320)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 22))
        .opacity(vm.visible ? 1 : 0)
        .scaleEffect(vm.visible ? 1 : 0.96)
        // Animate only show/hide. State transitions (kind/hint/caption)
        // are applied instantly — crossfading them produced a visible
        // lag where the old icon kept showing while the sound had
        // already changed.
        .animation(.smooth(duration: 0.18), value: vm.visible)
    }
}

struct Orb: View {
    let kind: OverlayKind

    var body: some View {
        // TimelineView drives a single, predictable animation clock —
        // we compute phase from absolute time so changes to `kind`
        // never stack overlapping repeatForever animations (which was
        // causing visible jank on every overlay_update).
        TimelineView(.animation(minimumInterval: 1.0 / 60.0, paused: kind == .idle)) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            let phase = (t.truncatingRemainder(dividingBy: breathingPeriod)) / breathingPeriod * 2 * .pi
            let breath = sin(phase)
            let orbitT = (t.truncatingRemainder(dividingBy: orbitPeriod)) / orbitPeriod * 360.0
            ZStack {
                Circle()
                    .fill(RadialGradient(colors: gradientColors,
                                         center: .center,
                                         startRadius: 4,
                                         endRadius: 60))
                    .scaleEffect(1 + breathingAmplitude * breath)
                    .opacity(coreOpacity)
                Circle()
                    .stroke(ringColor.opacity(0.45), lineWidth: 1.5)
                    .scaleEffect(1 + 0.12 * sin(phase + .pi / 2))
                    .opacity(0.55)
                // Spinning arc for thinking/processing — gives the orb
                // an unmistakable "working" feel distinct from the calm
                // listening glow.
                if showsSpinner {
                    Circle()
                        .trim(from: 0.0, to: 0.28)
                        .stroke(spinnerColor, style: StrokeStyle(lineWidth: 4, lineCap: .round))
                        .frame(width: 84, height: 84)
                        .rotationEffect(.degrees(orbitT))
                }
                // Center glyph — distinct per state. SF Symbols read
                // instantly even at small size, removing the need to
                // tell states apart by color/animation alone.
                Image(systemName: centerSymbol)
                    .font(.system(size: 28, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.92))
                    .symbolRenderingMode(.hierarchical)
            }
        }
    }

    // Gradient — bigger color jumps between states so the eye registers
    // the transition without reading text.
    private var gradientColors: [Color] {
        switch kind {
        case .idle:       return [.gray.opacity(0.6), .gray.opacity(0.1)]
        case .listening:  return [.cyan, .blue.opacity(0.35)]
        case .capturing:  return [.teal, .cyan.opacity(0.5)]
        case .thinking:   return [.purple, .indigo.opacity(0.55)]
        case .processing: return [.pink.opacity(0.95), .purple.opacity(0.55)]
        case .success:    return [.green, .green.opacity(0.35)]
        case .error:      return [.red, .orange.opacity(0.35)]
        }
    }

    private var ringColor: Color {
        switch kind {
        case .listening:  return .cyan
        case .capturing:  return .teal
        case .thinking:   return .purple
        case .processing: return .pink
        case .success:    return .green
        case .error:      return .red
        case .idle:       return .gray
        }
    }

    private var coreOpacity: Double {
        kind == .idle ? 0.5 : 0.95
    }

    private var showsSpinner: Bool {
        switch kind {
        case .thinking, .processing: return true
        default: return false
        }
    }

    private var spinnerColor: Color {
        kind == .processing ? .pink : .purple
    }

    private var centerSymbol: String {
        switch kind {
        case .idle:       return "circle"
        case .listening:  return "mic.fill"
        case .capturing:  return "waveform"
        case .thinking:   return "sparkle"
        case .processing: return "gearshape.fill"
        case .success:    return "checkmark"
        case .error:      return "exclamationmark"
        }
    }

    private var breathingPeriod: Double {
        switch kind {
        case .listening:             return 1.6
        case .capturing:             return 1.1
        case .thinking, .processing: return 0.6
        case .success, .error:       return 1.0
        case .idle:                  return 1.6
        }
    }

    private var breathingAmplitude: CGFloat {
        switch kind {
        case .listening:             return 0.06
        case .thinking, .processing: return 0.12
        default:                     return 0.08
        }
    }

    private var orbitPeriod: Double {
        kind == .processing ? 0.9 : 1.4
    }
}
