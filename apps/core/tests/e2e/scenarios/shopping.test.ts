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

describe("e2e/shopping", () => {
  let ctx: ScenarioCtx;

  beforeEach(async () => {
    ctx = await scenarioBoot();
  });

  afterEach(async () => {
    await scenarioTeardown(ctx);
  });

  it("add_item emits list_view_update with the new entry and monotonic seq", async () => {
    ctx.llm
      .expectRoute({ goto: "shopping", task: "add milk" })
      .expectSubAgent("shopping", {
        toolCalls: [{ name: "add_item", args: { name: "молоко" } }],
        result: { status: "ok", summary: "added" },
      })
      .expectRoute({ goto: "__end__" });

    await startRegularSession(ctx);
    ctx.dg.simulateFinal("добавь молоко");

    const update = await ctx.ear.waitListView(
      (m) => m.view.items.some((it) => /молоко/i.test(it.label)),
      { timeoutMs: 3_000 },
    );
    expect(update.view.items.length).toBeGreaterThanOrEqual(1);
    expect(update.seq).toBeGreaterThan(0);
    ctx.llm.assertConsumed();
  });

  it("two add_items in one turn → list_view_update seq strictly increases", async () => {
    ctx.llm
      .expectRoute({ goto: "shopping", task: "add two" })
      .expectSubAgent("shopping", {
        toolCalls: [
          { name: "add_item", args: { name: "хлеб" } },
          { name: "add_item", args: { name: "сыр" } },
        ],
        result: { status: "ok", summary: "added two" },
      })
      .expectRoute({ goto: "__end__" });

    await startRegularSession(ctx);
    ctx.dg.simulateFinal("добавь хлеб и сыр");

    // Wait until both items appear in the latest list_view.
    await vi.waitFor(
      () => {
        const last = ctx.ear.inbox.listView[ctx.ear.inbox.listView.length - 1];
        if (!last) throw new Error("no list_view yet");
        const labels = last.view.items.map((i) => i.label.toLowerCase());
        if (!labels.some((l) => l.includes("хлеб")) || !labels.some((l) => l.includes("сыр"))) {
          throw new Error(`incomplete labels: ${JSON.stringify(labels)}`);
        }
      },
      { timeoutMs: 3_000 },
    );
    const seqs = ctx.ear.inbox.listView.map((m) => m.seq);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
    ctx.llm.assertConsumed();
  });

  it("clear_list empties the list_view", async () => {
    ctx.llm
      .expectRoute({ goto: "shopping", task: "seed" })
      .expectSubAgent("shopping", {
        toolCalls: [{ name: "add_item", args: { name: "сахар" } }],
        result: { status: "ok", summary: "added" },
      })
      .expectRoute({ goto: "__end__" })
      .expectRoute({ goto: "shopping", task: "clear" })
      .expectSubAgent("shopping", {
        toolCalls: [{ name: "clear_list", args: { intent: "очистка" } }],
        result: { status: "ok", summary: "cleared" },
      })
      .expectRoute({ goto: "__end__" });

    await startRegularSession(ctx);

    // Turn 1: seed
    ctx.dg.simulateFinal("добавь сахар");
    await ctx.ear.waitListView(
      (m) => m.view.items.some((i) => /сахар/i.test(i.label)),
      { timeoutMs: 3_000 },
    );

    // Turn 2: clear
    ctx.dg.simulateFinal("очисти список");
    await vi.waitFor(
      () => {
        const last = ctx.ear.inbox.listView[ctx.ear.inbox.listView.length - 1];
        if (!last) throw new Error("no list_view yet");
        if (last.view.items.length !== 0) {
          throw new Error(`still has items: ${last.view.items.length}`);
        }
      },
      { timeoutMs: 3_000 },
    );
    ctx.llm.assertConsumed();
  });
});
