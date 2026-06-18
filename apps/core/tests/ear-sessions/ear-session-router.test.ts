import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionStartMessage } from "@vega/ear-protocol";
import { EarSessionRouter } from "../../src/conversation/sessions/ear-session-router.service";
import { EarSessionReservationConflictError } from "../../src/conversation/sessions/ear-session.errors";
import type { AgentSpec } from "../../src/conversation/kernel/agent.types";

class StubLogger {
  info() {}
  warn() {}
  error() {}
  debug() {}
}

function makeStubSessions() {
  return {
    getActiveSessionIdForDevice: vi.fn(() => undefined),
    terminateExternal: vi.fn(async () => true),
  } as any;
}

function makeRouter() {
  const send = vi.fn();
  const list = vi.fn(() => [{ deviceId: "dev-1", socket: { send } as any }]);
  const registry = { list } as any;
  const sessions = makeStubSessions();
  const overlay = { set: () => true, cancelTtl: () => {}, bindDevice: () => {}, unbindDevice: () => {} } as any;
  const router = new EarSessionRouter(new StubLogger() as any, registry, sessions, overlay);
  return { router, send, sessions };
}

function sessionStart(deviceId: string, sessionId: string, mode: "regular" | "continuous" = "continuous"): SessionStartMessage {
  return {
    type: "session_start",
    deviceId,
    sessionId,
    userId: null,
    sampleRate: 16000,
    codec: "linear16",
    mode,
  } as SessionStartMessage;
}

const spec: AgentSpec = {
  name: "notes-session",
  description: "test",
  examples: [],
  systemPrompt: "p",
  tools: [],
  enabled: true,
};

describe("EarSessionRouter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-17T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("arm sends arm_capture and a matching session_start binds the owner", () => {
    const { router, send } = makeRouter();
    const result = router.arm({ ownerSpec: spec, mode: "continuous" });
    expect(result.ok).toBe(true);
    expect(send).toHaveBeenCalledOnce();
    const sent = JSON.parse(send.mock.calls[0][0] as string);
    expect(sent).toEqual({ type: "arm_capture", mode: "continuous" });

    const ownership = router.bindOnSessionStart(sessionStart("dev-1", "sid-1", "continuous"), "dev-1");
    expect(ownership).toBeDefined();
    expect(router.ownerOf("sid-1")).toBe(spec);
  });

  it("double-arm before binding throws EarSessionReservationConflictError", () => {
    const { router } = makeRouter();
    router.arm({ ownerSpec: spec, mode: "continuous" });
    expect(() => router.arm({ ownerSpec: spec, mode: "continuous" })).toThrowError(
      EarSessionReservationConflictError,
    );
  });

  it("session_start with non-matching mode does NOT bind", () => {
    const { router } = makeRouter();
    router.arm({ ownerSpec: spec, mode: "continuous" });
    const ownership = router.bindOnSessionStart(sessionStart("dev-1", "sid-2", "regular"), "dev-1");
    expect(ownership).toBeUndefined();
    expect(router.ownerOf("sid-2")).toBeUndefined();
  });

  it("expired reservation is purged before next arm", () => {
    const { router } = makeRouter();
    router.arm({ ownerSpec: spec, mode: "continuous" });
    vi.advanceTimersByTime(10_500);
    // After expiry a second arm succeeds (purge happens inside arm)
    expect(() => router.arm({ ownerSpec: spec, mode: "continuous" })).not.toThrow();
  });

  it("release removes ownership lookup", () => {
    const { router } = makeRouter();
    router.arm({ ownerSpec: spec, mode: "continuous" });
    router.bindOnSessionStart(sessionStart("dev-1", "sid-3", "continuous"), "dev-1");
    expect(router.ownerOf("sid-3")).toBe(spec);
    router.release("sid-3");
    expect(router.ownerOf("sid-3")).toBeUndefined();
  });

  it("arm returns no-ear-connection when registry is empty", () => {
    const router = new EarSessionRouter(
      new StubLogger() as any,
      { list: () => [] } as any,
      makeStubSessions(),
      { set: () => true } as any,
    );
    const result = router.arm({ ownerSpec: spec, mode: "continuous" });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("no-ear-connection");
  });
});
