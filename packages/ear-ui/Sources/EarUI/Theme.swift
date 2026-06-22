import SwiftUI

// EarUI design system v1 — dark-only palette and typographic roles
// derived from `design/Vega v1/`. Tokens stay stable even if a future
// light theme is added; only the resolved colors would widen.
public enum Theme {
    // MARK: - Palette

    public static let violet          = Color(red: 0x8B/255.0, green: 0x5C/255.0, blue: 0xF6/255.0)
    public static let violetLight     = Color(red: 0xA7/255.0, green: 0x8B/255.0, blue: 0xFA/255.0)
    public static let violetLighter   = Color(red: 0xC4/255.0, green: 0xB5/255.0, blue: 0xFD/255.0)
    public static let violetSoft      = Color(red: 0xD6/255.0, green: 0xCB/255.0, blue: 0xFF/255.0)
    public static let violetHighlight = Color(red: 0xEF/255.0, green: 0xEA/255.0, blue: 0xFF/255.0)

    // Background gradient stops — radial(125% 80% at 50% 0%, top, mid 46%, bottom)
    public static let backgroundTop    = Color(red: 0x2A/255.0, green: 0x24/255.0, blue: 0x40/255.0)
    public static let backgroundMid    = Color(red: 0x16/255.0, green: 0x13/255.0, blue: 0x25/255.0)
    public static let backgroundBottom = Color(red: 0x0A/255.0, green: 0x08/255.0, blue: 0x12/255.0)
    public static let backgroundGlow   = Color(red: 0x3B/255.0, green: 0x1B/255.0, blue: 0x6B/255.0)

    // Error palette — desaturated cool grey, not violet.
    public static let errorAccent = Color(red: 0x9A/255.0, green: 0x93/255.0, blue: 0xB8/255.0)
    public static let errorAccentLight = Color(red: 0xA8/255.0, green: 0xA2/255.0, blue: 0xC0/255.0)
    public static let errorBgTop = Color(red: 0x24/255.0, green: 0x1D/255.0, blue: 0x2E/255.0)
    public static let errorBgMid = Color(red: 0x15/255.0, green: 0x12/255.0, blue: 0x1C/255.0)

    public static let surface         = Color(white: 1.0, opacity: 0.04)
    public static let surfaceStroke   = Color(white: 1.0, opacity: 0.08)

    public static let textPrimary     = Color(white: 1.0, opacity: 0.93)
    public static let textSecondary   = Color(white: 1.0, opacity: 0.62)
    public static let textTertiary    = Color(white: 1.0, opacity: 0.34)

    /// iOS full-screen backdrop.
    /// Radial gradient (125% 80% at 50% 0%): #2A2440 → #161325 (at 46%) → #0A0812.
    public static var background: some View {
        background(error: false)
    }

    public static func background(error: Bool) -> some View {
        let top = error ? errorBgTop : backgroundTop
        let mid = error ? errorBgMid : backgroundMid
        return RadialGradient(
            gradient: Gradient(stops: [
                .init(color: top, location: 0.0),
                .init(color: mid, location: 0.46),
                .init(color: backgroundBottom, location: 1.0)
            ]),
            center: UnitPoint(x: 0.5, y: 0.0),
            startRadius: 0,
            endRadius: 800
        )
        .ignoresSafeArea()
    }

    // MARK: - Typography roles

    public enum Font {
        public static func title(size: CGFloat) -> SwiftUI.Font { customFont("Golos Text", size: size, weight: .semibold) }
        public static func body(size: CGFloat) -> SwiftUI.Font { customFont("Golos Text", size: size, weight: .regular) }
        public static func bodyMedium(size: CGFloat) -> SwiftUI.Font { customFont("Golos Text", size: size, weight: .medium) }
        public static func mono(size: CGFloat) -> SwiftUI.Font { customFont("JetBrainsMono-Medium", size: size, weight: .medium) }
    }

    // Falls back to a system font when the embedded font is not yet
    // registered (or its file is missing — see registerFonts()).
    private static func customFont(_ name: String, size: CGFloat, weight: SwiftUI.Font.Weight) -> SwiftUI.Font {
        .system(size: size, weight: weight, design: .default)
    }

    // MARK: - Font registration

    private static var fontsRegistered = false
    private static let registrationLock = NSLock()

    /// Registers `Golos Text` and `JetBrains Mono` font files bundled in
    /// EarUI's resources with the host process's font system. Idempotent:
    /// subsequent calls are no-ops.
    ///
    /// NOTE: as of v1 the font files are not yet committed to the
    /// repository; this function still runs (no-op when files are absent)
    /// so call sites don't need a conditional. Once the .ttf/.otf files
    /// land in `Sources/EarUI/Resources/Fonts/`, registration becomes
    /// effective and `Theme.Font.title(...)` resolves to the real face.
    public static func registerFonts() {
        registrationLock.lock()
        defer { registrationLock.unlock() }
        guard !fontsRegistered else { return }
        fontsRegistered = true

        // Font files (Golos Text + JetBrains Mono) are not yet committed
        // to `Resources/Fonts/`. When they land, this becomes:
        //
        //     let bundle = Bundle.module
        //     for ext in ["ttf", "otf"] {
        //         for url in bundle.urls(forResourcesWithExtension: ext, subdirectory: "Fonts") ?? [] {
        //             CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
        //         }
        //     }
        //
        // Until then, the typographic roles fall back to system fonts
        // and registration is a no-op.
    }
}
