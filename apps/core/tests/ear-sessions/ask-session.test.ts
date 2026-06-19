import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { EarSessionRouter } from "../../src/conversation/sessions/ear-session-router.service";
import type { SessionStartMessage } from "@vega/ear-protocol";

class StubLogger {
  info() {}
  warn() {}
  error() {}
  debug() {}
}

function makeRouter(opts: { activeSessionForDevice?: string } = {}) {
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const registry = {
    list: () => [{ deviceId: "dev-1", socket: { emit: vi.fn() } as any }],
    emitTo: (_deviceId: string, event: string, payload: unknown) => {
      emitted.push({ event, payload });
      return true;
    },
  } as any;
  const sessions = {
    getActiveSessionIdForDevice: vi.fn(
      (deviceId: string) => (deviceId === "dev-1" ? opts.activeSessionForDevice : undefined),
    ),
    terminateExternal: vi.fn(async () => true),
  } as any;
  const overlay = { set: vi.fn(() => true) } as any;
  const router = new EarSessionRouter(new StubLogger() as any, registry, sessions, overlay);
  return { router, sessions, overlay, emitted };
}

function startMsg(sessionId: string): SessionStartMessage {
  return {
    deviceId: "dev-1",
    sessionId,
    userId: null,
    sampleRate: 16000,
    codec: "linear16",
    mode: "ask",
  } as any;
}

describe("EarSessionRouter ask-session", () => {
  it("emits arm_capture {mode:'ask', captureMs} and binds on session_start", async () => {
    const { router, emitted } = makeRouter();
    const promise = router.openAskSession({ deviceId: "dev-1", captureMs: 5000 });
    expect(emitted[0].event).toBe("arm_capture");
    expect(emitted[0].payload).toEqual({ mode: "ask", captureMs: 5000 });
    const ownership = router.bindOnSessionStart(startMsg("sid-1"), "dev-1");
    expect(ownership?.kind).toBe("ask");
    expect(router.isAskSession("sid-1")).toBe(true);

    router.resolveAskAnswer("sid-1", "идея проекта");
    const outcome = await promise;
    expect(outcome).toEqual({ kind: "answer", text: "идея проекта" });
  });

  it("resolves as timeout when explicitly signalled", async () => {
    const { router } = makeRouter();
    const promise = router.openAskSession({ deviceId: "dev-1", captureMs: 5000 });
    router.bindOnSessionStart(startMsg("sid-2"), "dev-1");
    router.resolveAskOutcome("sid-2", { kind: "timeout" });
    const outcome = await promise;
    expect(outcome).toEqual({ kind: "timeout" });
  });

  it("resolves as cancelled when session is released without explicit outcome", async () => {
    const { router } = makeRouter();
    const promise = router.openAskSession({ deviceId: "dev-1", captureMs: 5000 });
    router.bindOnSessionStart(startMsg("sid-3"), "dev-1");
    router.release("sid-3");
    const outcome = await promise;
    expect(outcome).toEqual({ kind: "cancelled" });
  });

  it("backup safety timer resolves as timeout after captureMs + padding", async () => {
    vi.useFakeTimers();
    try {
      const { router } = makeRouter();
      const promise = router.openAskSession({ deviceId: "dev-1", captureMs: 1000 });
      // bind happens but no answer / outcome arrives
      router.bindOnSessionStart(startMsg("sid-4"), "dev-1");
      vi.advanceTimersByTime(1000 + 2000 + 10);
      const outcome = await promise;
      expect(outcome).toEqual({ kind: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("openAskSession resolves cancelled when no Ear is connected", async () => {
    const noEar = makeRouter();
    (noEar as any).router["registry"] = { list: () => [], emitTo: () => false };
    // Bypass the wired registry: openAskSession reads via this.registry,
    // so test the no-Ear path by mocking it directly via private field.
    const router = new EarSessionRouter(
      new StubLogger() as any,
      { list: () => [], emitTo: () => false } as any,
      { getActiveSessionIdForDevice: () => undefined, terminateExternal: async () => true } as any,
      { set: () => true } as any,
    );
    const outcome = await router.openAskSession({});
    expect(outcome).toEqual({ kind: "cancelled" });
  });
});
