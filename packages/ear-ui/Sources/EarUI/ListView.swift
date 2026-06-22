import SwiftUI
import EarProtocol

/// List-view panel driven by `list_view_update`. Renders title, done/total
/// counter (compact only), and one row per item. Done rows render
/// struck-through with a filled-violet check bullet.
public struct EarListView: View {
    public enum TitleBadge {
        case none
        case success   // delete/add confirmation
        case error
        case thinking
    }

    let title: String?
    let items: [ListItem]
    let live: Bool   // true → immersive (animated lens), false → static view
    let badge: TitleBadge

    public init(title: String?, items: [ListItem], live: Bool = false, badge: TitleBadge = .none) {
        self.title = title
        self.items = items
        self.live = live
        self.badge = badge
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            if let title, !title.isEmpty {
                HStack(alignment: .center, spacing: 14) {
                    // Badge replaces the lens mark when a transient ack
                    // is active — same slot, same size, just a different
                    // glyph. When no badge → lens mark stays.
                    if badge == .none {
                        VegaLensMark(mode: live ? .live : .staticMark, size: 22)
                    } else {
                        badgeView
                    }
                    Text(title)
                        .font(Theme.Font.title(size: 19))
                        .fontWeight(.bold)
                        .foregroundColor(Theme.textPrimary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Spacer(minLength: 12)
                }
            }
            if items.isEmpty {
                Text("(пусто)")
                    .font(Theme.Font.body(size: 19))
                    .foregroundColor(Theme.textTertiary)
            } else {
                VStack(alignment: .leading, spacing: 18) {
                    ForEach(items, id: \.id) { item in
                        row(item)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 8)
    }

    private func row(_ item: ListItem) -> some View {
        HStack(spacing: 14) {
            bullet(done: item.done)
            label(item)
            Spacer(minLength: 0)
        }
    }

    @ViewBuilder
    private var badgeView: some View {
        switch badge {
        case .none:
            EmptyView()
        case .success:
            ZStack {
                Circle().fill(Color(red: 0x8B/255.0, green: 0x7F/255.0, blue: 0xD0/255.0))
                Image(systemName: "checkmark")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundColor(.white)
            }
            .frame(width: 22, height: 22)
            .transition(.scale.combined(with: .opacity))
        case .error:
            ZStack {
                Circle().stroke(Theme.errorAccent.opacity(0.7), lineWidth: 1.5)
                Image(systemName: "exclamationmark")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundColor(Theme.errorAccentLight)
            }
            .frame(width: 22, height: 22)
            .transition(.opacity)
        case .thinking:
            ProgressView()
                .controlSize(.small)
                .tint(Theme.violetLight)
                .frame(width: 22, height: 22)
                .transition(.opacity)
        }
    }

    @ViewBuilder
    private func bullet(done: Bool) -> some View {
        if done {
            ZStack {
                Circle().fill(Color(red: 0x8B/255.0, green: 0x7F/255.0, blue: 0xD0/255.0))
                Image(systemName: "checkmark")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundColor(.white)
            }
            .frame(width: 22, height: 22)
        } else {
            Circle()
                .stroke(Color.white.opacity(0.34), lineWidth: 1.5)
                .frame(width: 22, height: 22)
        }
    }

    @ViewBuilder
    private func label(_ item: ListItem) -> some View {
        if item.done {
            Text(item.label)
                .font(Theme.Font.body(size: 19))
                .foregroundColor(Theme.textTertiary)
                .strikethrough(true, color: Theme.textTertiary)
                .lineLimit(1)
        } else {
            Text(item.label)
                .font(Theme.Font.body(size: 19))
                .foregroundColor(Theme.textPrimary)
                .lineLimit(1)
        }
    }
}
