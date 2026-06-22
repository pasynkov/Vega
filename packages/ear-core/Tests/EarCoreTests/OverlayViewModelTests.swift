import XCTest
import EarProtocol
@testable import EarCore

@MainActor
final class OverlayViewModelTests: XCTestCase {

    private func update(seq: Int, kind: OverlayKind, hint: String? = nil, caption: String? = nil) -> OverlayUpdateMessage {
        OverlayUpdateMessage(seq: seq, state: OverlayState(kind: kind, hint: hint, caption: caption, sound: nil))
    }

    private func list(seq: Int, title: String? = nil, items: [ListItem] = [], open: Bool = true) -> ListViewUpdateMessage {
        ListViewUpdateMessage(seq: seq, view: ListView(title: title, items: items, open: open))
    }

    func testInitialStateIsHidden() {
        let vm = OverlayViewModel()
        XCTAssertFalse(vm.visible)
        XCTAssertNil(vm.hint)
        XCTAssertNil(vm.caption)
        XCTAssertFalse(vm.viewOpen)
        XCTAssertEqual(vm.viewItems, [])
    }

    func testFirstNonIdleUpdateMakesVisible() {
        let vm = OverlayViewModel()
        vm.apply(update(seq: 1, kind: .listening, hint: "Слушаю", caption: nil))
        XCTAssertTrue(vm.visible)
        XCTAssertEqual(vm.kind, .listening)
        XCTAssertEqual(vm.hint, "Слушаю")
        XCTAssertNil(vm.caption)
    }

    func testHintAndCaptionRenderTogether() {
        let vm = OverlayViewModel()
        vm.apply(update(seq: 7, kind: .processing, hint: "Сохраняю заметку…", caption: "купи молоко"))
        XCTAssertEqual(vm.kind, .processing)
        XCTAssertEqual(vm.hint, "Сохраняю заметку…")
        XCTAssertEqual(vm.caption, "купи молоко")
        XCTAssertTrue(vm.visible)
    }

    func testIdleUpdateHidesWhenNoListView() {
        let vm = OverlayViewModel()
        vm.apply(update(seq: 1, kind: .listening))
        vm.apply(update(seq: 2, kind: .idle))
        XCTAssertEqual(vm.kind, .idle)
        XCTAssertFalse(vm.visible)
    }

    func testIdleStaysVisibleWhenListViewIsOpen() {
        let vm = OverlayViewModel()
        vm.applyListView(list(seq: 1, title: "Список", items: [
            ListItem(id: "a", label: "молоко", done: false),
        ], open: true))
        vm.apply(update(seq: 1, kind: .idle))
        XCTAssertTrue(vm.visible, "Open list view keeps overlay visible even on idle")
    }

    func testOverlayStaleSeqDropped() {
        let vm = OverlayViewModel()
        vm.apply(update(seq: 5, kind: .thinking))
        vm.apply(update(seq: 3, kind: .listening))
        XCTAssertEqual(vm.kind, .thinking, "Out-of-order seq must be ignored")
    }

    func testOverlayEqualSeqDropped() {
        let vm = OverlayViewModel()
        vm.apply(update(seq: 5, kind: .thinking))
        vm.apply(update(seq: 5, kind: .listening))
        XCTAssertEqual(vm.kind, .thinking, "Equal seq must be treated as stale")
    }

    func testListViewItemsApplyAndRender() {
        let vm = OverlayViewModel()
        let items = [
            ListItem(id: "a", label: "молоко 1 л", done: false),
            ListItem(id: "b", label: "хлеб", done: true),
        ]
        vm.applyListView(list(seq: 1, title: "Список покупок", items: items, open: true))
        XCTAssertEqual(vm.viewTitle, "Список покупок")
        XCTAssertEqual(vm.viewItems.count, 2)
        XCTAssertEqual(vm.viewItems[0].label, "молоко 1 л")
        XCTAssertEqual(vm.viewItems[1].done, true)
        XCTAssertTrue(vm.viewOpen)
        XCTAssertTrue(vm.visible)
    }

    func testListViewCloseCollapsesPanel() {
        let vm = OverlayViewModel()
        vm.applyListView(list(seq: 1, items: [
            ListItem(id: "a", label: "x", done: false),
        ], open: true))
        vm.applyListView(list(seq: 2, items: [], open: false))
        XCTAssertFalse(vm.viewOpen)
        XCTAssertEqual(vm.viewItems, [])
    }

    func testListViewStaleSeqDropped() {
        let vm = OverlayViewModel()
        vm.applyListView(list(seq: 7, title: "A", items: [], open: true))
        vm.applyListView(list(seq: 5, title: "B", items: [], open: false))
        XCTAssertEqual(vm.viewTitle, "A", "Stale list seq must not overwrite")
        XCTAssertTrue(vm.viewOpen)
    }

    func testHideResetsAllStateAndSeqCounters() {
        let vm = OverlayViewModel()
        vm.apply(update(seq: 4, kind: .thinking, hint: "h", caption: "c"))
        vm.applyListView(list(seq: 4, title: "T", items: [
            ListItem(id: "x", label: "y", done: false),
        ], open: true))

        vm.hide()
        XCTAssertFalse(vm.visible)
        XCTAssertNil(vm.hint)
        XCTAssertNil(vm.caption)
        XCTAssertNil(vm.viewTitle)
        XCTAssertEqual(vm.viewItems, [])
        XCTAssertFalse(vm.viewOpen)

        // Counters reset → seq=1 after hide() must be accepted again.
        vm.apply(update(seq: 1, kind: .listening))
        XCTAssertEqual(vm.kind, .listening)
        XCTAssertTrue(vm.visible)
    }

    func testApplyUnknownRendersListeningFallback() {
        let vm = OverlayViewModel()
        let raw = RawOverlayState(rawKind: "wat", hint: "h", caption: nil, rawSound: nil)
        vm.applyUnknown(seq: 1, raw: raw)
        XCTAssertEqual(vm.kind, .listening)
        XCTAssertEqual(vm.hint, "h")
        XCTAssertTrue(vm.visible)
    }

    func testApplyUnknownStaleSeqIgnored() {
        let vm = OverlayViewModel()
        vm.apply(update(seq: 10, kind: .thinking))
        let raw = RawOverlayState(rawKind: "wat", hint: "h", caption: nil, rawSound: nil)
        vm.applyUnknown(seq: 9, raw: raw)
        XCTAssertEqual(vm.kind, .thinking)
    }
}
