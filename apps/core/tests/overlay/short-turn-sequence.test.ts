import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionService } from "../../src/conversation/ear/session/session.service";
import { OverlayService } from "../../src/conversation/overlay/overlay.service";

class StubLogger {
  info() {}
  warn() {}
  error() {}
  debug() {}
}

class StubRegistry {
  list() { return [{ deviceId: "dev-1", socket: { emit: () => {} } }]; }
  setActiveSession() {}
  emitTo() { return true; }
}

class StubDeepgramSession {
  send() {}
  close() {}
}

class StubDeepgram {
  open() { return new StubDeepgramSession(); }
}

class StubStore {
  async persist() {}
}

describe("Short-turn overlay sequence: wake → thinking on terminate → idle on success ttl", () => {
  let overlay: OverlayService;
  let svc: SessionService;
  const SESSION_ID = "22222222-2222-2222-2222-222222222222";

  beforeEach(() => {
    overlay = new OverlayService(new StubLogger() as any);
    const env = { deepgramLanguage: "ru", sessionTimeoutMs: 30_000 } as any;
    svc = new SessionService(
      new StubLogger() as any,
      new StubRegistry() as any,
      env,
      new StubDeepgram() as any,
      new StubStore() as any,
      overlay,
    );
  });

  afterEach(async () => {
    await svc.shutdownAll();
  });

  it("regular turn: listening → no overlay on partial/final → thinking on terminate(endpoint), overlay survives session_end", async () => {
    const sentMessages: any[] = [];
    overlay.bindDevice("dev-1", (event, payload) => sentMessages.push({ type: event, ...payload }), () => {});

    // Simulate wake_ack proceed.
    overlay.set("dev-1", { kind: "listening" });

    svc.start(
      { deviceId: "dev-1", deviceName: "test", socket: { send: vi.fn() } as any } as any,
      {
        type: "session_start",
        deviceId: "11111111-1111-1111-1111-111111111111",
        sessionId: SESSION_ID,
        userId: null,
        sampleRate: 16000,
        codec: "linear16",
      },
    );

    const internal: any = (svc as any).bySessionId.get(SESSION_ID);
    (svc as any).onPartial(internal, "купить");
    (svc as any).onFinal(internal, "купить молоко", 0.9);

    await svc.terminateExternal(SESSION_ID, "endpoint", "core:test");

    const overlayMessages = sentMessages.filter((m) => m.type === "overlay_update");
    // listening (wake) → thinking (immediate, on STT final) →
    // thinking (terminate adds caption + sound endpoint).
    expect(overlayMessages.map((m) => m.state.kind)).toEqual([
      "listening",
      "thinking",
      "thinking",
    ]);
    expect(overlayMessages[2].state.sound).toBe("endpoint");
    expect(overlayMessages[2].state.caption).toBe("купить молоко");
    expect(overlayMessages.map((m) => m.seq)).toEqual([1, 2, 3]);
  });

  it("silentOverlay terminate path does not paint thinking (used by ttl/arm flows)", async () => {
    const sentMessages: any[] = [];
    overlay.bindDevice("dev-1", (event, payload) => sentMessages.push({ type: event, ...payload }), () => {});

    svc.start(
      { deviceId: "dev-1", deviceName: "test", socket: { send: vi.fn() } as any } as any,
      {
        type: "session_start",
        deviceId: "11111111-1111-1111-1111-111111111111",
        sessionId: SESSION_ID,
        userId: null,
        sampleRate: 16000,
        codec: "linear16",
      },
    );
    await svc.terminateExternal(SESSION_ID, "endpoint", "core:test", undefined, { silentOverlay: true });
    const overlayMessages = sentMessages.filter((m) => m.type === "overlay_update");
    expect(overlayMessages.length).toBe(0);
  });

  it("continuous + owner: each final paints capturing with caption; regular session does NOT", async () => {
    const sentMessages: any[] = [];
    overlay.bindDevice("dev-1", (event, payload) => sentMessages.push({ type: event, ...payload }), () => {});

    svc.start(
      { deviceId: "dev-1", deviceName: "test", socket: { send: vi.fn() } as any } as any,
      {
        type: "session_start",
        deviceId: "11111111-1111-1111-1111-111111111111",
        sessionId: SESSION_ID,
        userId: null,
        sampleRate: 16000,
        codec: "linear16",
        mode: "continuous",
      },
    );
    const internal: any = (svc as any).bySessionId.get(SESSION_ID);
    internal.ownerController = { pushFinal: () => {}, signalEnd: () => {}, dispose: () => {} };
    (svc as any).onFinal(internal, "купи молоко", 0.9);
    (svc as any).onFinal(internal, "и хлеб", 0.9);
    (svc as any).onFinal(internal, "напомни завтра", 0.9);

    const captures = sentMessages
      .filter((m) => m.type === "overlay_update" && m.state.kind === "capturing")
      .map((m) => m.state.caption);
    expect(captures).toEqual(["купи молоко", "и хлеб", "напомни завтра"]);
  });
});
