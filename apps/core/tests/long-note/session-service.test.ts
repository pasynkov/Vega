import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionService, LONG_NOTE_SILENCE_CAP_MS } from "../../src/session/session.service";

class StubLogger {
  info() {}
  warn() {}
  error() {}
  debug() {}
}

class StubRegistry {
  list() { return [{ deviceId: "dev-1", socket: { send: vi.fn() } }]; }
  setActiveSession() {}
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

function makeService(): SessionService {
  const env = { deepgramLanguage: "ru", sessionTimeoutMs: 30_000 } as any;
  return new SessionService(
    new StubLogger() as any,
    new StubRegistry() as any,
    env,
    new StubDeepgram() as any,
    new StubStore() as any,
  );
}

describe("SessionService long-note mode", () => {
  let svc: SessionService;
  beforeEach(() => {
    svc = makeService();
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

  it("setMode('long_note') raises silenceCapMs and suppresses VAD endpoint", () => {
    const sid = "22222222-2222-2222-2222-222222222222";
    const ok = svc.setMode(sid, "long_note");
    expect(ok).toBe(true);
    // VAD endpoint suppression is exercised by forwardAudio path. We poke
    // an "endpoint" decision indirectly through internal state: the
    // session's vadEndpointSuppressed flag and silenceCapMs.
    const internal: any = (svc as any).bySessionId.get(sid);
    expect(internal.vadEndpointSuppressed).toBe(true);
    expect(internal.silenceCapMs).toBe(LONG_NOTE_SILENCE_CAP_MS);
    expect(internal.mode).toBe("long_note");
  });

  it("setMode is idempotent on repeat", () => {
    const sid = "22222222-2222-2222-2222-222222222222";
    expect(svc.setMode(sid, "long_note")).toBe(true);
    expect(svc.setMode(sid, "long_note")).toBe(true);
    const internal: any = (svc as any).bySessionId.get(sid);
    expect(internal.silenceCapMs).toBe(LONG_NOTE_SILENCE_CAP_MS);
  });

  it("emitCue / setMode return false for unknown session", () => {
    expect(svc.setMode("unknown-session", "long_note")).toBe(false);
    expect(svc.emitCue("unknown-session", "ack_done")).toBe(false);
    expect(svc.setSilenceCap("unknown-session", 1234)).toBe(false);
  });

  it("addTranscriptListener fires on partial and final", () => {
    const events: Array<{ k: string; t: string }> = [];
    svc.addTranscriptListener((_sid, kind, text) => events.push({ k: kind, t: text }));
    const sid = "22222222-2222-2222-2222-222222222222";
    const internal: any = (svc as any).bySessionId.get(sid);
    // Bypass deepgram and call private methods directly.
    (svc as any).onPartial(internal, "hi");
    (svc as any).onFinal(internal, "hello there", 0.9);
    expect(events).toEqual([
      { k: "partial", t: "hi" },
      { k: "final", t: "hello there" },
    ]);
  });
});
