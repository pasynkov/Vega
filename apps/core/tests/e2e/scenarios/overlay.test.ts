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

describe("e2e/overlay", () => {
  let ctx: ScenarioCtx;

  beforeEach(async () => {
    ctx = await scenarioBoot();
  });

  afterEach(async () => {
    await scenarioTeardown(ctx);
  });

  it("short turn paint sequence: listening → thinking → success → idle", async () => {
    ctx.llm
      .expectRoute({ goto: "shopping", task: "add" })
      .expectSubAgent("shopping", {
        toolCalls: [{ name: "add_item", args: { name: "мука" } }],
        result: { status: "ok", summary: "added" },
      })
      .expectRoute({ goto: "__end__" });

    await startRegularSession(ctx);

    // After wake_detected proceed → overlay listening is already in the
    // inbox from startRegularSession's wake.
    await ctx.ear.waitOverlay((m) => m.state.kind === "listening");

    ctx.dg.simulateFinal("добавь муку");

    // thinking paint fires on STT-final-regular
    await ctx.ear.waitOverlay((m) => m.state.kind === "thinking", {
      timeoutMs: 3_000,
    });
    // Shopping tool emits success via overlay.set with ttl=1500
    await ctx.ear.waitOverlay((m) => m.state.kind === "success", {
      timeoutMs: 3_000,
    });
    // After ttl, overlay goes back to idle
    await ctx.ear.waitOverlay((m) => m.state.kind === "idle", {
      timeoutMs: 4_000,
    });

    // Monotonic seq
    const seqs = ctx.ear.inbox.overlay.map((m) => m.seq);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
  });

  it.todo("update_overlay TTL: overlay returns to idle but active session is NOT terminated");
});
