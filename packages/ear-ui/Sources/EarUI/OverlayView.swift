import SwiftUI
import EarCore
import EarProtocol

public enum OverlayLayout {
    case compact     // macOS: rounded card, ~360 pt max width
    case fullScreen  // iOS: edge-to-edge background, centered mark
}

public struct OverlayView: View {
    @ObservedObject var vm: OverlayViewModel
    let layout: OverlayLayout

    public init(vm: OverlayViewModel, layout: OverlayLayout) {
        self.vm = vm
        self.layout = layout
    }

    public var body: some View {
        Group {
            switch layout {
            case .compact:   compactLayout
            case .fullScreen: fullScreenLayout
            }
        }
    }

    // MARK: - compact (mac panel card)
    //
    // Same layering as the iOS full-screen layout, just wrapped in a
    // fixed-width card and with a tighter list ceiling. Card height
    // adapts to the active state — orb states stay compact, list/immersive
    // grow to fit the items.

    private var compactLayout: some View {
        ZStack(alignment: .top) {
            cardBackground

            // Body branches by whether the list view is open.
            //   list open  → list (+ immersive bottom pill), mark overlays on top
            //                during transient ack states (success / error / thinking)
            //   list closed → mark + caption only (listening / capturing / …)
            //
            // The list takes the card's vertical space; the mark floats above
            // its top edge so the user keeps seeing the list while an ack plays.
            if listOpen {
                VStack(alignment: .leading, spacing: 0) {
                    EarListView(title: vm.viewTitle, items: vm.viewItems,
                                live: lensIsLive, badge: titleBadge)
                        .padding(.horizontal, 24)
                        .padding(.top, 26)
                        .padding(.bottom, captionText == nil ? 26 : 0)

                    if let cap = captionText {
                        ImmersiveBottomCaption(text: cap)
                            .padding(.horizontal, 18)
                            .padding(.top, 18)
                            .padding(.bottom, 18)
                    }
                }
            } else if vm.kind != .idle {
                VStack(spacing: 22) {
                    MorphMark(kind: vm.kind, size: 168)
                    if let belowText = belowOrbText, !belowText.isEmpty {
                        Text(belowText)
                            .font(Theme.Font.body(size: vm.kind == .error ? 17 : 16))
                            .fontWeight(vm.kind == .error ? .semibold : .regular)
                            .foregroundColor(belowColor)
                            .multilineTextAlignment(.center)
                            .lineLimit(3)
                    }
                }
                .padding(.horizontal, 24)
                .padding(.vertical, 28)
            }
        }
        .frame(width: 376)
        .fixedSize(horizontal: false, vertical: true)
        .padding(8)
        .animation(.easeInOut(duration: 0.45), value: vm.kind)
        .animation(.easeInOut(duration: 0.45), value: vm.viewOpen)
    }

    /// list is open whenever the most recent `list_view_update` left it open.
    /// The `view` / `immersive` overlay kinds typically arrive with the list
    /// but they don't drive list-visibility on their own.
    private var listOpen: Bool { vm.viewOpen }

    /// Lens mark in the title pulses when the list is being driven by
    /// an active immersive session — i.e. the list is open and we're
    /// not in the static `view` (read-only browse) kind. After an ack
    /// Core swings the overlay through success → idle while the list
    /// stays open; the lens should keep pulsing so the user knows the
    /// mic is still live in that domain.
    private var lensIsLive: Bool {
        vm.viewOpen && vm.kind != .view
    }

    /// When a list is open, transient ack states map to a small badge
    /// next to the list title instead of a floating mark overlay.
    private var titleBadge: EarListView.TitleBadge {
        switch vm.kind {
        case .success:                    return .success
        case .error:                      return .error
        case .thinking, .processing:      return .thinking
        default:                          return .none
        }
    }

    private var cardBackground: some View {
        RoundedRectangle(cornerRadius: 26, style: .continuous)
            .fill(Theme.backgroundMid.opacity(0.82))
            .overlay(
                RoundedRectangle(cornerRadius: 26, style: .continuous)
                    .stroke(Theme.surfaceStroke, lineWidth: 1)
            )
    }

    // MARK: - fullScreen (iOS)

    private var fullScreenLayout: some View {
        GeometryReader { geo in
            ZStack(alignment: .top) {
                // Background crossfade — error palette vs default.
                ZStack {
                    Theme.background(error: false)
                    Theme.background(error: true)
                        .opacity(vm.kind == .error ? 1 : 0)
                }

                if vm.viewOpen {
                    // List mode: list with live lens (or ack badge) at the
                    // title, STT live caption pill at the bottom.
                    EarListView(title: vm.viewTitle, items: vm.viewItems,
                                live: lensIsLive,
                                badge: titleBadge)
                        .padding(.horizontal, 30)
                        .padding(.top, geo.size.height * 0.13)
                        .frame(maxWidth: .infinity, alignment: .topLeading)

                    if let cap = captionText, !cap.isEmpty {
                        VStack {
                            Spacer()
                            ImmersiveBottomCaption(text: cap)
                                .padding(.horizontal, 30)
                                .padding(.bottom, 42)
                        }
                    }
                } else if vm.kind != .idle {
                    // Orb mode: big mark + caption below.
                    MorphMark(kind: vm.kind, size: 168)
                        .position(x: geo.size.width / 2, y: geo.size.height * 0.42)

                    if let belowText = belowOrbText, !belowText.isEmpty {
                        Text(belowText)
                            .font(Theme.Font.body(size: vm.kind == .error ? 19 : 18))
                            .fontWeight(vm.kind == .error ? .semibold : .regular)
                            .foregroundColor(belowColor)
                            .multilineTextAlignment(.center)
                            .lineLimit(3)
                            .padding(.horizontal, 44)
                            .position(x: geo.size.width / 2, y: geo.size.height * 0.62)
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .animation(.easeInOut(duration: 0.45), value: vm.kind)
            .animation(.easeInOut(duration: 0.45), value: vm.viewOpen)
        }
    }

    // MARK: - shared content

    @ViewBuilder
    private func content(markSize: CGFloat, hintSize: CGFloat, captionSize: CGFloat, listMaxWidth: CGFloat) -> some View {
        if vm.kind == .view {
            EarListView(title: vm.viewTitle, items: vm.viewItems)
                .frame(maxWidth: listMaxWidth)
        } else if vm.kind == .idle {
            EmptyView()
        } else {
            VStack(spacing: 40) {
                MorphMark(kind: vm.kind, size: markSize)
                if let belowText = belowOrbText, !belowText.isEmpty {
                    Text(belowText)
                        .font(belowFont(size: vm.kind == .error ? 19 : captionSize))
                        .fontWeight(vm.kind == .error ? .semibold : .regular)
                        .foregroundColor(belowColor)
                        .multilineTextAlignment(.center)
                        .lineLimit(3)
                        .padding(.horizontal, 44)
                }
            }
        }
    }

    private func belowFont(size: CGFloat) -> SwiftUI.Font {
        Theme.Font.body(size: size)
    }

    private var belowColor: Color {
        // Per HTML: listening 18px white 0.6; capturing/thinking/processing
        // 18px white 0.82; error 19px white 0.82 bold.
        switch vm.kind {
        case .listening: return Color.white.opacity(0.6)
        case .error:     return Color.white.opacity(0.82)
        default:         return Color.white.opacity(0.82)
        }
    }

    private var belowOrbText: String? {
        // In v1 mockups the only text per state sits below the mark.
        // hint slot (when present) wins; otherwise caption.
        if let h = vm.hint, !h.isEmpty { return h }
        return vm.caption
    }

    /// Non-empty text for the in-card live caption (used while the list
    /// is open). Priority: sticky live STT transcript → per-overlay
    /// caption → hint.
    private var captionText: String? {
        if let c = vm.liveCaption, !c.isEmpty { return c }
        if let c = vm.caption, !c.isEmpty { return c }
        if let h = vm.hint, !h.isEmpty { return h }
        return nil
    }
}

private struct ImmersiveBottomCaption: View {
    let text: String
    @State private var pulse = false
    var body: some View {
        HStack(spacing: 11) {
            Circle()
                .fill(Theme.violetLighter)
                .frame(width: 9, height: 9)
                .shadow(color: Theme.violetLighter.opacity(0.9), radius: 4)
                .scaleEffect(pulse ? 1.12 : 0.78)
                .opacity(pulse ? 1.0 : 0.7)
            Text(text)
                .font(Theme.Font.body(size: 17))
                .foregroundColor(Color.white.opacity(0.82))
                .lineLimit(2)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(Theme.violetLight.opacity(0.15))
                .overlay(
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .stroke(Theme.violetLight.opacity(0.2), lineWidth: 1)
                )
        )
        .onAppear {
            withAnimation(.easeInOut(duration: 1.3).repeatForever(autoreverses: true)) {
                pulse = true
            }
        }
    }
}
