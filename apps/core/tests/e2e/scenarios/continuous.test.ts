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

describe("e2e/continuous", () => {
  let ctx: ScenarioCtx;

  beforeEach(async () => {
    ctx = await scenarioBoot();
  });

  afterEach(async () => {
    await scenarioTeardown(ctx);
  });

  it("open_continuous_session → arm_capture(continuous) → Ear opens continuous session", async () => {
    ctx.llm
      .expectRoute({ goto: "notes", task: "сохрани заметку дорога" })
      .expectSubAgent("notes", {
        toolCalls: [
          {
            name: "open_continuous_session",
            args: { name: "дорога", intent: "сохрани заметку" },
          },
        ],
        result: { status: "ok", summary: "armed" },
      })
      .expectRoute({ goto: "__end__" });

    await startRegularSession(ctx);
    ctx.dg.simulateFinal("сохрани заметку дорога");

    const arm = await ctx.ear.waitArmCapture("continuous", { timeoutMs: 3_000 });
    expect(arm.mode).toBe("continuous");

    // Ear honors the arm by opening a continuous session. The router
    // resolves it to the notes-session owner and the Deepgram session
    // is freshly opened.
    await ctx.ear.sessionStart({ mode: "continuous" });
    await vi.waitFor(
      () => {
        if (ctx.dg.openSessions.length < 2) throw new Error("continuous dg session not opened");
      },
      { timeout: 3_000 },
    );
    expect(ctx.dg.openSessions.length).toBe(2);

    ctx.llm.assertConsumed();
  });

  // The session-bound notes agent runs on pause delays and would consume
  // additional scripted sub-agent entries. Driving that interaction
  // deterministically requires extra harness scaffolding (pause-timer
  // control, finalize_note scripting) — out of scope for the harness
  // landing. Track as `todo` so the catalog records the gap.
  it.todo("continuous session: multiple finals → session-bound finalize_note exits cleanly");
});
