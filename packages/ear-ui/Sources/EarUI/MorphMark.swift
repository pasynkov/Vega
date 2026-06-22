import SwiftUI
import EarProtocol

/// Seamless morph mark. All visual primitives — halo, ring, dot, wave
/// bars, thinking arc, processing arc, success check tick — are always
/// rendered. State-driven `opacity` / `color` / `scale` properties
/// crossfade smoothly when `kind` changes, mirroring the `mHalo`,
/// `mRing`, `mCore`, `mWave`, `mArc`, `mArc2`, `mCheck` keyframes
/// from `design/Vega v1/Vega Overlay.html` section 03.
///
/// Per-state local animations (vDot/vHalo/vWave/vSpin/vRipple) keep
/// looping inside every primitive and are hidden by opacity when their
/// owning state isn't active.
public struct MorphMark: View {
    public let kind: OverlayKind
    public let size: CGFloat
    private let transition: Animation = .easeInOut(duration: 0.5)

    public init(kind: OverlayKind, size: CGFloat = 168) {
        self.kind = kind
        self.size = size
    }

    public var body: some View {
        ZStack {
            // halo (listening, success, immersive, error)
            HaloLayer(kind: kind)

            // outline ring — color/glow morph
            RingLayer(kind: kind)

            // success ripple gate
            RippleLayer(kind: kind)

            // wave bars (capturing)
            WaveLayer(kind: kind)

            // thinking + processing arcs
            ArcLayer(kind: kind, primary: true)
            ArcLayer(kind: kind, primary: false)

            // success check
            CheckLayer(kind: kind)

            // error exclamation
            ExclamationLayer(kind: kind)

            // central dot — drawn LAST so it stays on top
            DotLayer(kind: kind)
        }
        .frame(width: size, height: size)
        .animation(transition, value: kind)
    }
}

// MARK: - Halo

private struct HaloLayer: View {
    let kind: OverlayKind
    @State private var pulse = false

    private var color: Color {
        kind == .error ? Theme.errorAccent
            : (kind == .success ? Theme.violetSoft : Theme.violetLight)
    }
    private var visibleOpacity: Double {
        switch kind {
        case .listening, .immersive: return 1.0
        case .success: return 1.0
        case .error: return 0.7
        default: return 0
        }
    }
    private var radiusFraction: CGFloat {
        kind == .error ? (152.0/168.0) : 1.0
    }

    var body: some View {
        Circle()
            .fill(RadialGradient(
                gradient: Gradient(colors: [color.opacity(0.34), .clear]),
                center: .center, startRadius: 0, endRadius: 84 * radiusFraction))
            .frame(width: 168 * radiusFraction, height: 168 * radiusFraction)
            .scaleEffect(pulse ? 1.12 : 0.9)
            .opacity(pulse ? 0.95 : 0.6)
            .opacity(visibleOpacity)
            .onAppear {
                withAnimation(.easeInOut(duration: 2.6).repeatForever(autoreverses: true)) {
                    pulse = true
                }
            }
    }
}

// MARK: - Ring

private struct RingLayer: View {
    let kind: OverlayKind

    private var color: Color {
        switch kind {
        case .listening, .immersive: return Theme.violetLight.opacity(0.85)
        case .capturing:             return Color(red: 0xB9/255.0, green: 0xA6/255.0, blue: 0xFC/255.0).opacity(0.7)
        case .thinking, .processing: return Theme.violetLight.opacity(0.16)
        case .success:               return Theme.violetSoft
        case .error:                 return Theme.errorAccent.opacity(0.7)
        case .view, .idle:           return .clear
        default:                     return .clear
        }
    }
    private var lineWidth: CGFloat {
        switch kind {
        case .success: return 3.5
        case .thinking, .processing: return 2.5
        default: return 3
        }
    }
    private var dashed: Bool { kind == .error }
    private var glowRadius: CGFloat {
        switch kind {
        case .listening, .immersive: return 14
        case .capturing: return 12
        case .success: return 16
        default: return 0
        }
    }
    private var glowColor: Color {
        kind == .success ? Theme.violetSoft.opacity(0.6) : Theme.violetLight.opacity(0.5)
    }
    private var visibleOpacity: Double {
        switch kind {
        case .view, .idle: return 0
        default: return 1
        }
    }

    var body: some View {
        Circle()
            .stroke(color,
                    style: dashed
                        ? StrokeStyle(lineWidth: lineWidth, dash: [5, 8])
                        : StrokeStyle(lineWidth: lineWidth))
            .frame(width: 116, height: 116)
            .shadow(color: glowColor, radius: glowRadius)
            .opacity(visibleOpacity)
    }
}

// MARK: - Dot (central)

private struct DotLayer: View {
    let kind: OverlayKind
    @State private var pulse = false

    private var fill: AnyShapeStyle {
        AnyShapeStyle(
            RadialGradient(
                gradient: Gradient(colors: [Theme.violetHighlight, Theme.violetLight]),
                center: .center, startRadius: 0, endRadius: 12))
    }
    private var size: CGFloat {
        switch kind {
        case .listening:  return 24
        case .immersive:  return 22
        case .thinking:   return 14
        case .processing: return 16
        default:          return 0
        }
    }
    private var visibleOpacity: Double {
        switch kind {
        case .listening, .immersive: return 1.0
        case .thinking:   return 0.5
        case .processing: return 1.0
        default: return 0
        }
    }
    private var glow: Bool { kind == .listening || kind == .immersive || kind == .processing }
    private var animated: Bool { kind == .listening || kind == .immersive }

    var body: some View {
        Circle()
            .fill(fill)
            .frame(width: size, height: size)
            .shadow(color: glow ? Theme.violetLight.opacity(0.9) : .clear, radius: glow ? 10 : 0)
            .scaleEffect(animated && pulse ? 1.12 : (animated ? 0.78 : 1.0))
            .opacity(animated && pulse ? visibleOpacity : (animated ? 0.7 * visibleOpacity : visibleOpacity))
            .onAppear {
                withAnimation(.easeInOut(duration: 2.6).repeatForever(autoreverses: true)) {
                    pulse = true
                }
            }
    }
}

// MARK: - Wave bars (capturing)

private struct WaveLayer: View {
    let kind: OverlayKind
    private static let cfg: [(duration: Double, delay: Double, fill: Color)] = [
        (1.00, 0.00, Theme.violetLighter),
        (0.90, 0.18, Theme.violetLighter),
        (1.10, 0.05, Theme.violetSoft),
        (0.95, 0.28, Theme.violetLighter),
        (1.05, 0.12, Theme.violetLighter),
    ]
    var body: some View {
        HStack(spacing: 6) {
            ForEach(Self.cfg.indices, id: \.self) { i in
                WaveBar(duration: Self.cfg[i].duration,
                        delay: Self.cfg[i].delay,
                        fill: Self.cfg[i].fill)
            }
        }
        .frame(height: 54)
        .opacity(kind == .capturing ? 1 : 0)
    }
}

private struct WaveBar: View {
    let duration: Double
    let delay: Double
    let fill: Color
    @State private var amp = false
    var body: some View {
        RoundedRectangle(cornerRadius: 3)
            .fill(fill)
            .frame(width: 5, height: 54)
            .scaleEffect(y: amp ? 1.0 : 0.32, anchor: .center)
            .onAppear {
                DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                    withAnimation(.easeInOut(duration: duration).repeatForever(autoreverses: true)) {
                        amp = true
                    }
                }
            }
    }
}

// MARK: - Arcs (thinking + processing)

private struct ArcLayer: View {
    let kind: OverlayKind
    let primary: Bool
    @State private var rotation: Double = 0

    private var visible: Bool {
        if primary { return kind == .thinking || kind == .processing }
        return kind == .processing
    }
    private var diameter: CGFloat {
        if !primary { return 92 }                  // inner processing arc
        return kind == .processing ? 124 : 116    // thinking ring 116, processing outer 124
    }
    private var lineWidth: CGFloat {
        if !primary { return 4.5 }
        return kind == .processing ? 5 : 5
    }
    private var sweep: Double {
        if !primary { return 66.0 / (66.0 + 240.0) }
        if kind == .processing { return 124.0 / (124.0 + 320.0) }
        return 100.0 / (100.0 + 280.0)
    }
    private var duration: Double {
        if !primary { return 1.0 }
        return kind == .processing ? 0.7 : 1.0
    }
    private var clockwise: Bool { primary }
    private var color: Color {
        if !primary { return Theme.violet }
        return kind == .processing ? Theme.violetLighter : Theme.violetLight
    }

    var body: some View {
        Circle()
            .trim(from: 0, to: CGFloat(sweep))
            .stroke(color, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
            .frame(width: diameter, height: diameter)
            .rotationEffect(.degrees(rotation))
            .opacity(visible ? 1 : 0)
            .onAppear {
                withAnimation(.linear(duration: duration).repeatForever(autoreverses: false)) {
                    rotation = clockwise ? 360 : -360
                }
            }
    }
}

// MARK: - Ripple (success)

private struct RippleLayer: View {
    let kind: OverlayKind
    var body: some View {
        ZStack {
            RippleRing(duration: 2.6, delay: 0)
            RippleRing(duration: 2.6, delay: 1.3)
        }
        .opacity(kind == .success ? 1 : 0)
    }
}

private struct RippleRing: View {
    let duration: Double
    let delay: Double
    @State private var phase = false
    var body: some View {
        Circle()
            .stroke(Theme.violetSoft.opacity(0.5), lineWidth: 2)
            .frame(width: 116, height: 116)
            .scaleEffect(phase ? 1.55 : 0.5)
            .opacity(phase ? 0.0 : 0.7)
            .onAppear {
                DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                    withAnimation(.easeOut(duration: duration).repeatForever(autoreverses: false)) {
                        phase = true
                    }
                }
            }
    }
}

// MARK: - Check (success)

private struct CheckLayer: View {
    let kind: OverlayKind
    var body: some View {
        CheckPath()
            .stroke(Theme.violetHighlight,
                    style: StrokeStyle(lineWidth: 6, lineCap: .round, lineJoin: .round))
            .frame(width: 116, height: 116)
            .opacity(kind == .success ? 1 : 0)
    }
}

private struct CheckPath: Shape {
    // "M39 60 l14 14 l27 -34" normalized to 116×116
    func path(in rect: CGRect) -> Path {
        let sx = rect.width / 116
        let sy = rect.height / 116
        let p0 = CGPoint(x: rect.minX + 39 * sx, y: rect.minY + 60 * sy)
        let p1 = CGPoint(x: p0.x + 14 * sx, y: p0.y + 14 * sy)
        let p2 = CGPoint(x: p1.x + 27 * sx, y: p1.y - 34 * sy)
        var p = Path()
        p.move(to: p0)
        p.addLine(to: p1)
        p.addLine(to: p2)
        return p
    }
}

// MARK: - Exclamation (error)

private struct ExclamationLayer: View {
    let kind: OverlayKind
    var body: some View {
        VStack(spacing: 8) {
            RoundedRectangle(cornerRadius: 3)
                .fill(Theme.errorAccentLight)
                .frame(width: 5, height: 34)
            Circle()
                .fill(Theme.errorAccentLight)
                .frame(width: 5, height: 5)
        }
        .opacity(kind == .error ? 1 : 0)
    }
}
