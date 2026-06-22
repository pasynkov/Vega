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

describe("e2e/notes", () => {
  let ctx: ScenarioCtx;

  beforeEach(async () => {
    ctx = await scenarioBoot();
  });

  afterEach(async () => {
    await scenarioTeardown(ctx);
  });

  it("named note dictation: supervisor routes to notes, sub-agent opens continuous session, Ear gets arm_capture", async () => {
    // Script supervisor + notes sub-agent + closing route.
    ctx.llm
      .expectRoute({ goto: "notes", task: "сохрани заметку купить молоко" })
      .expectSubAgent("notes", {
        toolCalls: [
          {
            name: "open_continuous_session",
            args: { name: "купить молоко", intent: "сохрани заметку" },
          },
        ],
        result: { status: "ok", summary: "armed" },
      })
      .expectRoute({ goto: "__end__" });

    await startRegularSession(ctx);
    ctx.dg.simulateFinal("сохрани заметку купить молоко");

    // The orchestrator fires through the per-final listener; the notes
    // sub-agent's open_continuous_session tool calls EarSessionRouter.arm,
    // which fires arm_capture(continuous) to the Ear.
    const arm = await ctx.ear.waitArmCapture("continuous", { timeoutMs: 3_000 });
    expect(arm.mode).toBe("continuous");
    ctx.llm.assertConsumed();
  });
});
