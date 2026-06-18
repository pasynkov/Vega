import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { buildUpdateOverlayTool } from "../../src/conversation/kernel/tools/update-overlay.tool";

function makeTool(overlayResp = true) {
  const overlay = { set: vi.fn(() => overlayResp) } as any;
  const sessions = { getDeviceIdForSession: vi.fn((sid: string) => sid === "sess-1" ? "dev-1" : undefined) } as any;
  const tool = buildUpdateOverlayTool(overlay, sessions) as any;
  return { tool, overlay, sessions };
}

async function invoke(tool: any, input: unknown, ctx: Record<string, unknown> = {}): Promise<unknown> {
  return tool.invoke(input, { configurable: ctx });
}

describe("update_overlay tool", () => {
  it("forwards state to OverlayService for an active session", async () => {
    const { tool, overlay } = makeTool();
    const out = await invoke(tool, { kind: "processing", hint: "Сохраняю заметку" }, { thread_id: "sess-1" });
    expect(overlay.set).toHaveBeenCalledTimes(1);
    expect(overlay.set.mock.calls[0][0]).toBe("dev-1");
    expect(overlay.set.mock.calls[0][1]).toEqual({ kind: "processing", hint: "Сохраняю заметку" });
    expect(JSON.parse(out as string)).toEqual({ ok: true, dispatched: true });
  });

  it("forwards ttl as the second-arg option", async () => {
    const { tool, overlay } = makeTool();
    await invoke(tool, { kind: "success", sound: "ack_success", ttl: 1500 }, { thread_id: "sess-1" });
    expect(overlay.set.mock.calls[0][2]).toEqual({ ttl: 1500 });
  });

  it("no-ops when there is no active session for ctx.sessionId", async () => {
    const { tool, overlay } = makeTool();
    const out = await invoke(tool, { kind: "thinking" }, { thread_id: "unknown-session" });
    expect(overlay.set).not.toHaveBeenCalled();
    expect(JSON.parse(out as string)).toEqual({ ok: true, dispatched: false });
  });

  it("prefers ctx.earSession.deviceId when present (session-bound flow)", async () => {
    const { tool, overlay, sessions } = makeTool();
    await invoke(tool, { kind: "processing" }, {
      thread_id: "sess-1",
      ear_session: { sessionId: "sess-1", deviceId: "dev-bound", mode: "continuous", arrivedAt: 0 },
    });
    expect(sessions.getDeviceIdForSession).not.toHaveBeenCalled();
    expect(overlay.set.mock.calls[0][0]).toBe("dev-bound");
  });
});
