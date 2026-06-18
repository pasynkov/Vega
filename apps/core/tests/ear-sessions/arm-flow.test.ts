import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EarSessionRouter } from "../../src/conversation/sessions/ear-session-router.service";
import { isWakeWordFinal } from "../../src/conversation/ear/wake/wake-vocabulary";
import type { AgentSpec } from "../../src/conversation/kernel/agent.types";
import type { SessionStartMessage } from "@vega/ear-protocol";

class StubLogger {
  info() {}
  warn() {}
  error() {}
  debug() {}
}

const ownerSpec: AgentSpec = {
  name: "notes-session",
  description: "test",
  examples: [],
  systemPrompt: "p",
  tools: [],
  enabled: true,
};

function makeRouter(opts: {
  activeSessionForDevice?: string;
  send?: (raw: string) => void;
} = {}) {
  const send = opts.send ?? vi.fn();
  const registry = {
    list: () => [{ deviceId: "dev-1", socket: { send } as any }],
  } as any;
  const sessions = {
    getActiveSessionIdForDevice: vi.fn(
      (deviceId: string) => (deviceId === "dev-1" ? opts.activeSessionForDevice : undefined),
    ),
    terminateExternal: vi.fn(async () => true),
  } as any;
  const overlay = { set: vi.fn(() => true) } as any;
  const router = new EarSessionRouter(new StubLogger() as any, registry, sessions, overlay);
  return { router, sessions, send, overlay };
}

describe("Bug-2: arm terminates the device's active session before dispatch", () => {
  it("calls sessions.terminateExternal first, then sends arm_capture", async () => {
    const sendOrder: string[] = [];
    const { router, sessions } = makeRouter({
      activeSessionForDevice: "active-sid",
      send: (raw) => sendOrder.push(`send:${typeof raw === "string" ? raw : String(raw)}`),
    });
    const terminateSpy = sessions.terminateExternal as ReturnType<typeof vi.fn>;
    terminateSpy.mockImplementation(async () => {
      sendOrder.push("terminate:active-sid");
      return true;
    });

    const result = router.arm({ ownerSpec, mode: "continuous" });
    await Promise.resolve();
    await Promise.resolve();

    expect(result.ok).toBe(true);
    expect(terminateSpy).toHaveBeenCalledWith(
      "active-sid",
      "endpoint",
      "core:tool_release",
      undefined,
      { silentOverlay: true },
    );
    const armIdx = sendOrder.findIndex((e) => e.startsWith("send:") && e.includes("arm_capture"));
    const termIdx = sendOrder.findIndex((e) => e === "terminate:active-sid");
    expect(termIdx).toBeGreaterThanOrEqual(0);
    expect(armIdx).toBeGreaterThanOrEqual(0);
    expect(termIdx).toBeLessThan(armIdx);
  });

  it("no active session → arm proceeds without termination", () => {
    const { router, sessions } = makeRouter();
    const result = router.arm({ ownerSpec, mode: "continuous" });
    expect(result.ok).toBe(true);
    expect(sessions.terminateExternal).not.toHaveBeenCalled();
  });
});

describe("Bug-4: in-transition session marker", () => {
  it("wasTornDownByArm returns true for sessions terminated by arm, false afterwards", async () => {
    const { router } = makeRouter({ activeSessionForDevice: "active-sid" });
    router.arm({ ownerSpec, mode: "continuous" });
    expect(router.wasTornDownByArm("active-sid")).toBe(true);
    expect(router.wasTornDownByArm("other-sid")).toBe(false);
  });

  it("a fresh router (no arm) treats every sessionId as NOT torn down", () => {
    const { router } = makeRouter();
    expect(router.wasTornDownByArm("any-sid")).toBe(false);
  });
});

describe("Bug-1: wake-word vocabulary filter", () => {
  it("drops common wake-word transliterations", () => {
    expect(isWakeWordFinal("Этна")).toBe(true);
    expect(isWakeWordFinal("Этна.")).toBe(true);
    expect(isWakeWordFinal("эдна")).toBe(true);
    expect(isWakeWordFinal("Джанет.")).toBe(true);
    expect(isWakeWordFinal("Janet")).toBe(true);
    expect(isWakeWordFinal("edna")).toBe(true);
  });

  it("preserves real user speech", () => {
    expect(isWakeWordFinal("Давай запишем большую заметку.")).toBe(false);
    expect(isWakeWordFinal("Купить молоко")).toBe(false);
    expect(isWakeWordFinal("Этна и я сегодня поедем на гору")).toBe(false);
  });

  it("treats an empty string as wake-only (defensive)", () => {
    expect(isWakeWordFinal("")).toBe(true);
    expect(isWakeWordFinal("   ")).toBe(true);
  });
});
