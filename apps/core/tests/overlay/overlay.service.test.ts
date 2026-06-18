import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { OverlayService } from "../../src/conversation/overlay/overlay.service";

class StubLogger {
  info() {}
  warn() {}
  error() {}
  debug() {}
}

function makeService(): OverlayService {
  return new OverlayService(new StubLogger() as any);
}

function bind(svc: OverlayService, deviceId = "dev-1") {
  const send = vi.fn();
  const terminate = vi.fn();
  svc.bindDevice(deviceId, send as any, terminate);
  return { send, terminate };
}

describe("OverlayService", () => {
  it("assigns strictly monotonic seq per device, starting at 1", () => {
    const svc = makeService();
    const { send } = bind(svc);
    expect(svc.set("dev-1", { kind: "listening" })).toBe(true);
    expect(svc.set("dev-1", { kind: "thinking", caption: "hi" })).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][0]).toBe("overlay_update");
    expect(send.mock.calls[0][1]).toEqual({ seq: 1, state: { kind: "listening" } });
    expect(send.mock.calls[1][0]).toBe("overlay_update");
    expect(send.mock.calls[1][1]).toEqual({ seq: 2, state: { kind: "thinking", caption: "hi" } });
  });

  it("no-ops when device is unknown", () => {
    const svc = makeService();
    expect(svc.set("ghost", { kind: "listening" })).toBe(false);
  });

  it("rejects oversize hint at the service boundary", () => {
    const svc = makeService();
    const { send } = bind(svc);
    expect(svc.set("dev-1", { kind: "thinking", hint: "x".repeat(121) })).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects oversize caption", () => {
    const svc = makeService();
    const { send } = bind(svc);
    expect(svc.set("dev-1", { kind: "capturing", caption: "y".repeat(241) })).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("schedules ttl and fires terminator on expiry", () => {
    vi.useFakeTimers();
    const svc = makeService();
    const { terminate } = bind(svc);
    svc.set("dev-1", { kind: "success", sound: "ack_success" }, { ttl: 1500 });
    expect(svc.hasTtlTimer("dev-1")).toBe(true);
    vi.advanceTimersByTime(1499);
    expect(terminate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(svc.hasTtlTimer("dev-1")).toBe(false);
    vi.useRealTimers();
  });

  it("cancels a pending ttl when a new state arrives", () => {
    vi.useFakeTimers();
    const svc = makeService();
    const { terminate } = bind(svc);
    svc.set("dev-1", { kind: "success" }, { ttl: 500 });
    svc.set("dev-1", { kind: "listening" });
    vi.advanceTimersByTime(1_000);
    expect(terminate).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("cancelTtl clears pending ttl without dropping the binding", () => {
    vi.useFakeTimers();
    const svc = makeService();
    const { send, terminate } = bind(svc);
    svc.set("dev-1", { kind: "success" }, { ttl: 500 });
    svc.cancelTtl("dev-1");
    vi.advanceTimersByTime(1_000);
    expect(terminate).not.toHaveBeenCalled();
    expect(svc.set("dev-1", { kind: "idle" })).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("unbindDevice resets seq for a future binding (reconnect)", () => {
    const svc = makeService();
    const first = bind(svc);
    svc.set("dev-1", { kind: "listening" });
    expect(svc.getSeq("dev-1")).toBe(1);
    svc.unbindDevice("dev-1");
    const second = bind(svc);
    svc.set("dev-1", { kind: "listening" });
    expect(second.send.mock.calls[0][1].seq).toBe(1);
    // first sender should not get the second message
    expect(first.send).toHaveBeenCalledTimes(1);
  });

  it("unbindDevice cancels pending ttl", () => {
    vi.useFakeTimers();
    const svc = makeService();
    const { terminate } = bind(svc);
    svc.set("dev-1", { kind: "success" }, { ttl: 500 });
    svc.unbindDevice("dev-1");
    vi.advanceTimersByTime(1_000);
    expect(terminate).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("rejects `wake` in state.sound (wake is local-only)", () => {
    const svc = makeService();
    const { send } = bind(svc);
    // OverlaySoundEnum excludes wake; service boundary must reject.
    // (`as any` to bypass TS typing, mirrors what a misbehaving caller would do.)
    expect(svc.set("dev-1", { kind: "listening", sound: "wake" as any })).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});
