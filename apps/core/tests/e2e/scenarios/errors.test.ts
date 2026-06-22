import "reflect-metadata";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

vi.mock("@langchain/anthropic", async () => {
  const m = await import("../harness/scripted-llm");
  return m.buildAnthropicMock();
});

vi.mock("@langchain/langgraph/prebuilt", async () => {
  const m = await import("../harness/scripted-llm");
  return m.buildReactAgentMock();
});

import { scenarioBoot, scenarioTeardown, type ScenarioCtx } from "../harness/boot";
import { sleep } from "../harness/waiters";

async function startRegularSession(ctx: ScenarioCtx): Promise<void> {
  await ctx.ear.register();
  await ctx.ear.wake({ score: 0.92 });
  await ctx.ear.sessionStart({ mode: "regular" });
  await vi.waitFor(
    () => {
      if (ctx.dg.openSessions.length < 1) throw new Error("no dg session yet");
    },
    { timeout: 2_000 },
  );
}

describe("e2e/errors", () => {
  let ctx: ScenarioCtx;

  beforeEach(async () => {
    ctx = await scenarioBoot();
  });

  afterEach(async () => {
    await scenarioTeardown(ctx);
  });

  it("malformed audio_frame payload → ignored, active session unaffected", async () => {
    await startRegularSession(ctx);
    // emit garbage shape: socket.io expects [sessionId, Buffer] tuple.
    ctx.ear.emitRaw("audio_frame", { not: "a tuple" });
    await sleep(100);
    expect(ctx.dg.framesReceived(0)).toBe(0);
    expect(ctx.ear.inbox.sessionEnd.length).toBe(0);
  });

  it("scripted tool throws inside sub-agent → orchestrator absorbs error, queue consumed", async () => {
    // Script the supervisor to route to shopping, then expect a sub-agent
    // with a non-existent tool name. The harness's mock throws "tool ...
    // not found in sub-agent ... toolset" inside the sub-agent invoke.
    // sub-agent.factory's try/catch absorbs the throw and posts back to
    // the supervisor as `AgentOutput{status:"error"}` carried by a named
    // AIMessage — which ConversationService.wasActed() reads as outcome
    // = "acted" (the agent did act, the action just failed). Production
    // therefore paints `success` via the acted-safety overlay, not
    // `error`. This documents the current behavior; a future change
    // could differentiate "acted-with-status-error" from "acted-with-
    // status-ok" at the overlay layer.
    ctx.llm
      .expectRoute({ goto: "shopping", task: "do impossible" })
      .expectSubAgent("shopping", {
        toolCalls: [{ name: "this_tool_does_not_exist", args: {} }],
        result: { status: "ok" },
      });

    await startRegularSession(ctx);
    ctx.dg.simulateFinal("сделай невозможное");

    // Wait until the supervisor queue head is empty (one route + one
    // subagent consumed; the supervisor's follow-up call past the queue
    // end triggers SupervisorNode's fallback path).
    await vi.waitFor(
      () => {
        if (ctx.llm.remaining.length > 0) {
          throw new Error(`remaining: ${ctx.llm.remaining.length}`);
        }
      },
      { timeoutMs: 4_000 },
    );
    // No wire session_end fired for the regular session — the orchestrator
    // run completed without terminating the capture session.
    expect(ctx.ear.inbox.sessionEnd.length).toBe(0);
  });

  it.todo("supervisor LLM throws → overlay error → session_end with reason");
});
