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

describe("e2e/ask-user", () => {
  let ctx: ScenarioCtx;

  beforeEach(async () => {
    ctx = await scenarioBoot();
  });

  afterEach(async () => {
    await scenarioTeardown(ctx);
  });

  it("ask_user answered in time → answer flows back into sub-agent", async () => {
    ctx.llm
      .expectRoute({ goto: "notes", task: "сохрани заметку" })
      .expectSubAgent("notes", {
        toolCalls: [
          {
            name: "ask_user",
            args: {
              question: "Как назовём заметку?",
              hint: "Скажи имя",
              captureMs: 5_000,
            },
          },
        ],
        result: { status: "ok", summary: "got name" },
      })
      .expectRoute({ goto: "__end__" });

    await startRegularSession(ctx);
    ctx.dg.simulateFinal("сохрани заметку");

    const arm = await ctx.ear.waitArmCapture("ask", { timeoutMs: 3_000 });
    expect(arm.mode).toBe("ask");

    // Ear opens an ask session in response to arm_capture(ask). The
    // gateway opens a fresh Deepgram session.
    await ctx.ear.sessionStart({ mode: "ask" });
    await vi.waitFor(
      () => {
        if (ctx.dg.openSessions.length < 2) throw new Error("ask dg session not opened");
      },
      { timeout: 3_000 },
    );
    // The simulated answer flows back into the router; ask_user resolves
    // and the sub-agent invoke completes.
    ctx.dg.simulateFinal("Вега");

    // The whole script consumes once the supervisor's end-of-turn route fires.
    await vi.waitFor(
      () => {
        if (ctx.llm.remaining.length > 0) {
          throw new Error(`remaining: ${ctx.llm.remaining.length}`);
        }
      },
      { timeoutMs: 5_000 },
    );
  });

  it.todo("ask_user timeout: Ear ignores arm → tool returns reason:timeout");
  it.todo("ask_user cancelled: status-bar tap → tool returns reason:cancelled");
});
