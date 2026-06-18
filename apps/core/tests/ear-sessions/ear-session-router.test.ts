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

function makeRouter() {
  const send = vi.fn();
  const list = vi.fn(() => [{ deviceId: "dev-1", socket: { send } as any }]);
  const registry = { list } as any;
  const router = new EarSessionRouter(new StubLogger() as any, registry);
  return { router, send };
}

function sessionStart(deviceId: string, sessionId: string, mode: "regular" | "long_note" = "long_note"): SessionStartMessage {
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
    const result = router.arm({ ownerSpec: spec, mode: "long_note" });
    expect(result.ok).toBe(true);
    expect(send).toHaveBeenCalledOnce();
    const sent = JSON.parse(send.mock.calls[0][0] as string);
    expect(sent).toEqual({ type: "arm_capture", mode: "long_note" });

    const ownership = router.bindOnSessionStart(sessionStart("dev-1", "sid-1", "long_note"), "dev-1");
    expect(ownership).toBeDefined();
    expect(router.ownerOf("sid-1")).toBe(spec);
  });

  it("double-arm before binding throws EarSessionReservationConflictError", () => {
    const { router } = makeRouter();
    router.arm({ ownerSpec: spec, mode: "long_note" });
    expect(() => router.arm({ ownerSpec: spec, mode: "long_note" })).toThrowError(
      EarSessionReservationConflictError,
    );
  });

  it("session_start with non-matching mode does NOT bind", () => {
    const { router } = makeRouter();
    router.arm({ ownerSpec: spec, mode: "long_note" });
    const ownership = router.bindOnSessionStart(sessionStart("dev-1", "sid-2", "regular"), "dev-1");
    expect(ownership).toBeUndefined();
    expect(router.ownerOf("sid-2")).toBeUndefined();
  });

  it("expired reservation is purged before next arm", () => {
    const { router } = makeRouter();
    router.arm({ ownerSpec: spec, mode: "long_note" });
    vi.advanceTimersByTime(10_500);
    // After expiry a second arm succeeds (purge happens inside arm)
    expect(() => router.arm({ ownerSpec: spec, mode: "long_note" })).not.toThrow();
  });

  it("release removes ownership lookup", () => {
    const { router } = makeRouter();
    router.arm({ ownerSpec: spec, mode: "long_note" });
    router.bindOnSessionStart(sessionStart("dev-1", "sid-3", "long_note"), "dev-1");
    expect(router.ownerOf("sid-3")).toBe(spec);
    router.release("sid-3");
    expect(router.ownerOf("sid-3")).toBeUndefined();
  });

  it("arm returns no-ear-connection when registry is empty", () => {
    const router = new EarSessionRouter(new StubLogger() as any, { list: () => [] } as any);
    const result = router.arm({ ownerSpec: spec, mode: "long_note" });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("no-ear-connection");
  });
});
