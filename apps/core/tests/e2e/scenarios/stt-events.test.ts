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

async function startSession(ctx: ScenarioCtx): Promise<void> {
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

describe("e2e/stt-events", () => {
  let ctx: ScenarioCtx;

  beforeEach(async () => {
    ctx = await scenarioBoot();
  });

  afterEach(async () => {
    await scenarioTeardown(ctx);
  });

  it("partial transcripts flow to Ear in order", async () => {
    await startSession(ctx);

    ctx.dg.simulatePartial("куп");
    ctx.dg.simulatePartial("купи");
    ctx.dg.simulatePartial("купить");

    await ctx.ear.waitPartial((m) => m.text === "купить");
    const texts = ctx.ear.inbox.partial.map((m) => m.text);
    expect(texts).toEqual(["куп", "купи", "купить"]);
  });

  it("final transcript fires the supervisor route once", async () => {
    ctx.llm.expectRoute({ goto: "__end__", speakText: "" });
    await startSession(ctx);

    ctx.dg.simulatePartial("купить");
    ctx.dg.simulateFinal("купить молоко");

    // Supervisor consumes the scripted route as the orchestrator turn fires.
    await vi.waitFor(
      () => {
        if (ctx.llm.remaining.length > 0) throw new Error("supervisor not invoked yet");
      },
      { timeout: 2_000 },
    );
    expect(ctx.llm.remaining.length).toBe(0);
  });

  it("Deepgram error mid-utterance closes session with stt_error", async () => {
    await startSession(ctx);

    ctx.dg.simulateError("transient network problem");

    const end = await ctx.ear.waitSessionEnd("stt_error");
    expect(end.reason).toBe("stt_error");
    // LLM queue stays untouched — no route happened.
    expect(ctx.llm.remaining.length).toBe(0);
  });

  // The DeepgramClient `onClose` callback intentionally no-ops in
  // production (SessionService.onFinal is responsible for end-of-session,
  // not the Deepgram lifecycle event). So a bare `simulateClose` does NOT
  // emit a wire `session_end`. We document the current behaviour here.
  it("Deepgram close alone does NOT end the session (onClose is no-op)", async () => {
    await startSession(ctx);

    ctx.dg.simulateClose();
    await sleep(150);
    expect(ctx.ear.inbox.sessionEnd.length).toBe(0);
  });

  it("multiple partials → all delivered, supervisor still invoked exactly once on the final", async () => {
    ctx.llm.expectRoute({ goto: "__end__" });
    await startSession(ctx);

    for (const t of ["к", "ку", "куп", "купи", "купит"]) {
      ctx.dg.simulatePartial(t);
    }
    ctx.dg.simulateFinal("купить");

    await vi.waitFor(
      () => {
        if (ctx.ear.inbox.partial.length < 5) throw new Error("partials still arriving");
        if (ctx.llm.remaining.length > 0) throw new Error("supervisor not invoked yet");
      },
      { timeout: 2_000 },
    );
    expect(ctx.ear.inbox.partial.length).toBe(5);
    expect(ctx.llm.remaining.length).toBe(0);
  });

  // Mark as todo: utterance_end semantics in Core are "informational only"
  // per vega-core spec — the authoritative end-of-utterance is Core's
  // own silence detector. A wire-level test of "utterance_end → session
  // close" would assert behavior that's specifically NOT in the spec.
  it.todo("utterance_end alone does NOT terminate the session (spec: informational only)");
});
