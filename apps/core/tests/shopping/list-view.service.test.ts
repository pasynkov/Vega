import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { ListViewService } from "../../src/conversation/overlay/list-view.service";
import { OverlayService } from "../../src/conversation/overlay/overlay.service";

class StubLogger {
  info() {}
  warn() {}
  error() {}
  debug() {}
}

function makeServices(): { listView: ListViewService; overlay: OverlayService } {
  const overlay = new OverlayService(new StubLogger() as any);
  const listView = new ListViewService(new StubLogger() as any, overlay);
  return { listView, overlay };
}

function bindBoth(listView: ListViewService, overlay: OverlayService, deviceId = "dev-1") {
  const listSends: any[] = [];
  const overlaySends: any[] = [];
  listView.bindDevice(deviceId, (m) => listSends.push(m));
  overlay.bindDevice(deviceId, (m) => overlaySends.push(m), () => {});
  return { listSends, overlaySends };
}

const SNAPSHOT = {
  title: "Список",
  items: [{ id: "a", label: "молоко", done: false }],
  open: true,
};

describe("ListViewService", () => {
  it("refresh emits list_view_update with monotonic seq starting at 1", () => {
    const { listView, overlay } = makeServices();
    const { listSends } = bindBoth(listView, overlay);
    expect(listView.refresh("dev-1", SNAPSHOT)).toBe(true);
    expect(listView.refresh("dev-1", SNAPSHOT)).toBe(true);
    expect(listSends.map((m) => m.seq)).toEqual([1, 2]);
    expect(listSends[0].view.items[0].label).toBe("молоко");
  });

  it("refresh rejects snapshot with open=false", () => {
    const { listView, overlay } = makeServices();
    const { listSends } = bindBoth(listView, overlay);
    const result = listView.refresh("dev-1", { items: [], open: false } as any);
    expect(result).toBe(false);
    expect(listSends.length).toBe(0);
  });

  it("close emits open:false and paints overlay idle", () => {
    const { listView, overlay } = makeServices();
    const { listSends, overlaySends } = bindBoth(listView, overlay);
    listView.refresh("dev-1", SNAPSHOT);
    expect(listView.close("dev-1", "tool")).toBe(true);
    expect(listSends[1].view.open).toBe(false);
    expect(overlaySends.at(-1).state.kind).toBe("idle");
  });

  it("refresh resets auto-close timer", () => {
    vi.useFakeTimers();
    const { listView, overlay } = makeServices();
    bindBoth(listView, overlay);
    listView.refresh("dev-1", SNAPSHOT);
    vi.advanceTimersByTime(59_000);
    listView.refresh("dev-1", SNAPSHOT);
    vi.advanceTimersByTime(59_000);
    expect(listView.isOpen("dev-1")).toBe(true);
    vi.useRealTimers();
  });

  it("auto-close timer fires after 60 s of inactivity", () => {
    vi.useFakeTimers();
    const { listView, overlay } = makeServices();
    const { listSends, overlaySends } = bindBoth(listView, overlay);
    listView.refresh("dev-1", SNAPSHOT);
    vi.advanceTimersByTime(60_000);
    expect(listView.isOpen("dev-1")).toBe(false);
    expect(listSends.at(-1).view.open).toBe(false);
    expect(overlaySends.at(-1).state.kind).toBe("idle");
    vi.useRealTimers();
  });

  it("unbindDevice cancels timer and resets seq", () => {
    vi.useFakeTimers();
    const { listView, overlay } = makeServices();
    bindBoth(listView, overlay);
    listView.refresh("dev-1", SNAPSHOT);
    listView.unbindDevice("dev-1");
    vi.advanceTimersByTime(60_000);
    expect(listView.isOpen("dev-1")).toBe(false);
    // re-bind → seq restarts
    bindBoth(listView, overlay);
    listView.refresh("dev-1", SNAPSHOT);
    expect(listView.getSeq("dev-1")).toBe(1);
    vi.useRealTimers();
  });

  it("no-ops on unknown device", () => {
    const { listView, overlay } = makeServices();
    expect(listView.refresh("ghost", SNAPSHOT)).toBe(false);
    expect(listView.close("ghost")).toBe(false);
  });
});
