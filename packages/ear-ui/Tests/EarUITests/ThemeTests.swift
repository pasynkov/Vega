import XCTest
import SwiftUI
@testable import EarUI

final class ThemeTests: XCTestCase {

    private func components(_ color: Color) -> (r: Double, g: Double, b: Double) {
        #if canImport(AppKit)
        let ns = NSColor(color).usingColorSpace(.sRGB) ?? NSColor(color)
        return (Double(ns.redComponent), Double(ns.greenComponent), Double(ns.blueComponent))
        #else
        var r: CGFloat = 0; var g: CGFloat = 0; var b: CGFloat = 0; var a: CGFloat = 0
        UIColor(color).getRed(&r, green: &g, blue: &b, alpha: &a)
        return (Double(r), Double(g), Double(b))
        #endif
    }

    private func assertColor(_ color: Color, _ hex: UInt32, accuracy: Double = 1.5 / 255.0, file: StaticString = #file, line: UInt = #line) {
        let er = Double((hex >> 16) & 0xFF) / 255.0
        let eg = Double((hex >> 8) & 0xFF) / 255.0
        let eb = Double(hex & 0xFF) / 255.0
        let c = components(color)
        XCTAssertEqual(c.r, er, accuracy: accuracy, file: file, line: line)
        XCTAssertEqual(c.g, eg, accuracy: accuracy, file: file, line: line)
        XCTAssertEqual(c.b, eb, accuracy: accuracy, file: file, line: line)
    }

    func testVioletPaletteHexes() {
        assertColor(Theme.violet,          0x8B5CF6)
        assertColor(Theme.violetLight,     0xA78BFA)
        assertColor(Theme.violetLighter,   0xC4B5FD)
        assertColor(Theme.violetHighlight, 0xEFEAFF)
    }

    func testBackgroundGradientStops() {
        assertColor(Theme.backgroundTop,    0x0A0612)
        assertColor(Theme.backgroundBottom, 0x1B0F30)
        assertColor(Theme.backgroundGlow,   0x3B1B6B)
    }

    func testRegisterFontsIsIdempotent() {
        // Should not crash on first call or subsequent calls.
        Theme.registerFonts()
        Theme.registerFonts()
        Theme.registerFonts()
    }
}
