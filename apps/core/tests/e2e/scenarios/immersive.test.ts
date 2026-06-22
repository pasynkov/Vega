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

describe("e2e/immersive", () => {
  let ctx: ScenarioCtx;

  beforeEach(async () => {
    ctx = await scenarioBoot();
  });

  afterEach(async () => {
    await scenarioTeardown(ctx);
  });

  it("supervisor's __immersive_open__ → arm_capture(immersive)", async () => {
    // Shopping is a registered immersive domain (see shopping.module.ts).
    ctx.llm.expectRoute({ goto: "__immersive_open__", task: "shopping" });

    await startRegularSession(ctx);
    ctx.dg.simulateFinal("открой шопинг");

    const arm = await ctx.ear.waitArmCapture("immersive", { timeoutMs: 3_000 });
    expect(arm.mode).toBe("immersive");
    ctx.llm.assertConsumed();
  });

  it.todo("immersive: turn loop hands finals directly to session-spec, not top supervisor");
});
