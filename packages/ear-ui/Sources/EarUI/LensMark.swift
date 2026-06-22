import SwiftUI

/// Small "Vega lens" mark used as the brand glyph next to the list-view
/// title. Two modes:
///
///   .static    — outline ring + violet dot, no animation.
///                Used by the regular `view` overlay state.
///
///   .live      — outline ring + concentric ripples (vRipple 1.7s) +
///                pulsing dot (vDot 1.3s). Used by the `immersive`
///                state to signal "Vega is listening continuously".
///
/// Mirrors the 20–22 pt mark from `design/Vega v1/Vega Overlay.html`
/// (sections 02 immersive and 04 view).
public struct VegaLensMark: View {
    public enum Mode { case staticMark, live }
    public let mode: Mode
    public let size: CGFloat

    public init(mode: Mode = .staticMark, size: CGFloat = 22) {
        self.mode = mode
        self.size = size
    }

    public var body: some View {
        ZStack {
            if mode == .live {
                LensRipple(size: size, delay: 0)
                LensRipple(size: size, delay: 0.85)
            }
            Circle()
                .stroke(Theme.violetLight.opacity(0.9), lineWidth: 1.5)
                .frame(width: size, height: size)
                .shadow(color: Theme.violetLight.opacity(0.45), radius: 4)
            LensDot(animated: mode == .live, size: size * (6.0 / 22.0))
        }
        .frame(width: size, height: size)
    }
}

private struct LensRipple: View {
    let size: CGFloat
    let delay: Double
    @State private var phase = false
    var body: some View {
        Circle()
            .stroke(Theme.violetLight.opacity(0.6), lineWidth: 1.5)
            .frame(width: size, height: size)
            .scaleEffect(phase ? 1.55 : 0.5)
            .opacity(phase ? 0.0 : 0.7)
            .onAppear {
                DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                    withAnimation(.easeOut(duration: 1.7).repeatForever(autoreverses: false)) {
                        phase = true
                    }
                }
            }
    }
}

private struct LensDot: View {
    let animated: Bool
    let size: CGFloat
    @State private var pulse = false
    var body: some View {
        Circle()
            .fill(Theme.violetLighter)
            .frame(width: size, height: size)
            .scaleEffect(animated && pulse ? 1.12 : (animated ? 0.78 : 1.0))
            .opacity(animated && pulse ? 1.0 : (animated ? 0.7 : 1.0))
            .onAppear {
                guard animated else { return }
                withAnimation(.easeInOut(duration: 1.3).repeatForever(autoreverses: true)) {
                    pulse = true
                }
            }
    }
}
