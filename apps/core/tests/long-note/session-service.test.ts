import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionService, CONTINUOUS_MODE_SILENCE_CAP_MS } from "../../src/conversation/ear/session/session.service";

class StubLogger {
  info() {}
  warn() {}
  error() {}
  debug() {}
}

class StubRegistry {
  list() { return [{ deviceId: "dev-1", socket: { emit: vi.fn() } }]; }
  setActiveSession() {}
  emitTo = vi.fn(() => true);
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

class StubOverlay {
  set = vi.fn(() => true);
  cancelTtl = vi.fn();
  bindDevice = vi.fn();
  unbindDevice = vi.fn();
}

function makeService(overlay: StubOverlay = new StubOverlay()): { svc: SessionService; overlay: StubOverlay } {
  const env = { deepgramLanguage: "ru", sessionTimeoutMs: 30_000 } as any;
  const svc = new SessionService(
    new StubLogger() as any,
    new StubRegistry() as any,
    env,
    new StubDeepgram() as any,
    new StubStore() as any,
    overlay as any,
  );
  return { svc, overlay };
}

describe("SessionService long-note mode", () => {
  let svc: SessionService;
  let overlay: StubOverlay;
  beforeEach(() => {
    ({ svc, overlay } = makeService());
    svc.start(
      { deviceId: "dev-1", deviceName: "test", socket: { send: vi.fn() } as any } as any,
      {
        type: "session_start",
        deviceId: "11111111-1111-1111-1111-111111111111",
        sessionId: "22222222-2222-2222-2222-222222222222",
        userId: null,
        sampleRate: 16000,
        codec: "linear16",
      },
    );
  });
  afterEach(() => {
    void svc.shutdownAll();
  });

  it("setMode('continuous') raises silenceCapMs and suppresses VAD endpoint", () => {
    const sid = "22222222-2222-2222-2222-222222222222";
    const ok = svc.setMode(sid, "continuous");
    expect(ok).toBe(true);
    // VAD endpoint suppression is exercised by forwardAudio path. We poke
    // an "endpoint" decision indirectly through internal state: the
    // session's vadEndpointSuppressed flag and silenceCapMs.
    const internal: any = (svc as any).bySessionId.get(sid);
    expect(internal.vadEndpointSuppressed).toBe(true);
    expect(internal.silenceCapMs).toBe(CONTINUOUS_MODE_SILENCE_CAP_MS);
    expect(internal.mode).toBe("continuous");
  });

  it("setMode is idempotent on repeat", () => {
    const sid = "22222222-2222-2222-2222-222222222222";
    expect(svc.setMode(sid, "continuous")).toBe(true);
    expect(svc.setMode(sid, "continuous")).toBe(true);
    const internal: any = (svc as any).bySessionId.get(sid);
    expect(internal.silenceCapMs).toBe(CONTINUOUS_MODE_SILENCE_CAP_MS);
  });

  it("setMode / setSilenceCap return false for unknown session", () => {
    expect(svc.setMode("unknown-session", "continuous")).toBe(false);
    expect(svc.setSilenceCap("unknown-session", 1234)).toBe(false);
  });

  it("addTranscriptListener fires on partial and final without overlay updates for a regular session", () => {
    const events: Array<{ k: string; t: string }> = [];
    svc.addTranscriptListener((_sid, kind, text) => events.push({ k: kind, t: text }));
    const sid = "22222222-2222-2222-2222-222222222222";
    const internal: any = (svc as any).bySessionId.get(sid);
    (svc as any).onPartial(internal, "hi");
    (svc as any).onFinal(internal, "hello there", 0.9);
    expect(events).toEqual([
      { k: "partial", t: "hi" },
      { k: "final", t: "hello there" },
    ]);
    // Regular (non-continuous) sessions do NOT push captions to the overlay
    // on partial/final — the overlay stays in its current visual.
    expect(overlay.set).not.toHaveBeenCalled();
  });

  it("continuous mode + owner: each final paints a capturing caption", () => {
    const sid = "22222222-2222-2222-2222-222222222222";
    expect(svc.setMode(sid, "continuous")).toBe(true);
    const internal: any = (svc as any).bySessionId.get(sid);
    internal.ownerController = { pushFinal: () => {}, signalEnd: () => {}, dispose: () => {} };
    (svc as any).onFinal(internal, "купи молоко", 0.9);
    (svc as any).onFinal(internal, "и хлеб", 0.9);
    const captionCalls = overlay.set.mock.calls
      .filter((c: any[]) => c[1]?.kind === "capturing")
      .map((c: any[]) => c[1].caption);
    expect(captionCalls).toEqual(["купи молоко", "и хлеб"]);
  });
});
