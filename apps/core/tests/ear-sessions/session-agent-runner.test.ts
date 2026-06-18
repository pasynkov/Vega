import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";

const mocks = vi.hoisted(() => {
  const invokeMock = vi.fn();
  const createReactAgentMock = vi.fn(() => ({ invoke: invokeMock }));
  return { invokeMock, createReactAgentMock };
});
const { invokeMock, createReactAgentMock } = mocks;

vi.mock("@langchain/langgraph/prebuilt", () => ({
  createReactAgent: mocks.createReactAgentMock,
}));

import { SessionAgentRunner } from "../../src/conversation/sessions/session-agent-runner.service";
import type { EarSessionHandle } from "../../src/conversation/sessions/ear-session-handle";
import type { AgentSpec } from "../../src/conversation/kernel/agent.types";

class StubLogger {
  info() {}
  warn() {}
  error() {}
  debug() {}
}

const handle: EarSessionHandle = {
  sessionId: "sid-1",
  deviceId: "dev-1",
  mode: "long_note",
  arrivedAt: 0,
};

const spec: AgentSpec = {
  name: "notes-session",
  description: "test",
  examples: [],
  systemPrompt: "p",
  tools: [],
  enabled: true,
};

function makeRunner(opts: { capMs: number; pauseMs: number }) {
  const llm = { getModel: () => ({} as any) } as any;
  const env = { earSessionOwnerCapMs: opts.capMs, earSessionPauseMs: opts.pauseMs } as any;
  return new SessionAgentRunner(new StubLogger() as any, llm, env);
}

function emptyTurn(): { messages: BaseMessage[] } {
  return { messages: [new HumanMessage("…"), new AIMessage("")] };
}

function releaseTurn(reason: "endpoint" | "user" | "timeout" | "stt_error"): { messages: BaseMessage[] } {
  return {
    messages: [
      new HumanMessage("…"),
      new ToolMessage({
        name: "finalize_note",
        tool_call_id: "tc-1",
        content: JSON.stringify({ ok: true, release: true, reason }),
      }),
      new AIMessage(""),
    ],
  };
}

describe("SessionAgentRunner", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    createReactAgentMock.mockClear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("auto-appends every final via onFinalAppend; sub-agent NOT invoked per final", async () => {
    invokeMock.mockResolvedValue(emptyTurn());
    const runner = makeRunner({ capMs: 60_000, pauseMs: 3_000 });
    const onRelease = vi.fn();
    const onFinalAppend = vi.fn();
    const controller = runner.start({
      handle,
      spec,
      initialPrompt: "boot",
      callbacks: { onRelease, onFinalAppend },
    });
    controller.pushFinal("first");
    controller.pushFinal("second");
    controller.pushFinal("third");
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(onFinalAppend).toHaveBeenCalledTimes(3);
    expect(onFinalAppend.mock.calls.map((c) => c[1])).toEqual(["first", "second", "third"]);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("fires sub-agent on pause; new final cancels in-flight check", async () => {
    let invokeIdx = 0;
    invokeMock.mockImplementation(async (_state, _opts) => {
      invokeIdx += 1;
      return emptyTurn();
    });
    const runner = makeRunner({ capMs: 60_000, pauseMs: 100 });
    const controller = runner.start({
      handle,
      spec,
      initialPrompt: "boot",
      callbacks: { onRelease: vi.fn(), onFinalAppend: vi.fn() },
    });
    controller.pushFinal("first");
    await vi.advanceTimersByTimeAsync(50);
    // Within pause: no fire yet
    expect(invokeMock).not.toHaveBeenCalled();
    // New final cancels timer
    controller.pushFinal("second");
    await vi.advanceTimersByTimeAsync(50);
    expect(invokeMock).not.toHaveBeenCalled();
    // After full pause
    await vi.advanceTimersByTimeAsync(110);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(invokeIdx).toBe(1);
  });

  it("release tool result in pause check ends the session with core:tool_release", async () => {
    invokeMock.mockResolvedValue(releaseTurn("endpoint"));
    const runner = makeRunner({ capMs: 60_000, pauseMs: 50 });
    const onRelease = vi.fn();
    const controller = runner.start({
      handle,
      spec,
      initialPrompt: "boot",
      callbacks: { onRelease, onFinalAppend: vi.fn() },
    });
    controller.pushFinal("конец заметки");
    await vi.advanceTimersByTimeAsync(100);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(onRelease).toHaveBeenCalledTimes(1);
    expect(onRelease.mock.calls[0][1]).toBe("endpoint");
    expect(onRelease.mock.calls[0][2]).toBe("core:tool_release");
  });

  it("safety cap fires flush + release with core:owner_safety_cap", async () => {
    invokeMock.mockResolvedValue(emptyTurn());
    const runner = makeRunner({ capMs: 50, pauseMs: 60_000 });
    const onRelease = vi.fn();
    const onFlush = vi.fn();
    runner.start({
      handle,
      spec,
      initialPrompt: "boot",
      callbacks: { onRelease, onFlush, onFinalAppend: vi.fn() },
    });
    await vi.advanceTimersByTimeAsync(60);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(onFlush).toHaveBeenCalledWith("sid-1", "core:owner_safety_cap");
    expect(onRelease).toHaveBeenCalledTimes(1);
    expect(onRelease.mock.calls[0][1]).toBe("timeout");
    expect(onRelease.mock.calls[0][2]).toBe("core:owner_safety_cap");
  });

  it("signalEnd('user') runs a terminal check and force-releases if sub-agent does not call a tool", async () => {
    invokeMock.mockResolvedValue(emptyTurn());
    const runner = makeRunner({ capMs: 60_000, pauseMs: 60_000 });
    const onRelease = vi.fn();
    const onFlush = vi.fn();
    const controller = runner.start({
      handle,
      spec,
      initialPrompt: "boot",
      callbacks: { onRelease, onFlush, onFinalAppend: vi.fn() },
    });
    controller.signalEnd("user");
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledWith("sid-1", "core:forced_user");
    expect(onRelease).toHaveBeenCalledTimes(1);
    expect(onRelease.mock.calls[0][1]).toBe("user");
  });

  it("signalEnd('user') with release tool result accepts the sub-agent's finalize", async () => {
    invokeMock.mockResolvedValue(releaseTurn("user"));
    const runner = makeRunner({ capMs: 60_000, pauseMs: 60_000 });
    const onRelease = vi.fn();
    const controller = runner.start({
      handle,
      spec,
      initialPrompt: "boot",
      callbacks: { onRelease, onFinalAppend: vi.fn() },
    });
    controller.signalEnd("user");
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(onRelease).toHaveBeenCalledTimes(1);
    expect(onRelease.mock.calls[0][1]).toBe("user");
    expect(onRelease.mock.calls[0][2]).toBe("core:tool_release");
  });

  it("invocation throws on pause check → stt_error release with core:tool_error", async () => {
    invokeMock.mockImplementation(async () => {
      throw new Error("boom");
    });
    const runner = makeRunner({ capMs: 60_000, pauseMs: 50 });
    const onRelease = vi.fn();
    const onFlush = vi.fn();
    const controller = runner.start({
      handle,
      spec,
      initialPrompt: "boot",
      callbacks: { onRelease, onFlush, onFinalAppend: vi.fn() },
    });
    controller.pushFinal("explode");
    await vi.advanceTimersByTimeAsync(100);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(onFlush).toHaveBeenCalledWith("sid-1", "core:tool_error");
    expect(onRelease).toHaveBeenCalledTimes(1);
    expect(onRelease.mock.calls[0][1]).toBe("stt_error");
    expect(onRelease.mock.calls[0][2]).toBe("core:tool_error");
  });
});
