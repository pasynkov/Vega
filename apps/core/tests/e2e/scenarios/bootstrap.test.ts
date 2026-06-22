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
import { AgentRegistry } from "../../../src/conversation/kernel/agent-registry.service";
import { FlushHookRegistry } from "../../../src/conversation/sessions/flush-hook-registry.service";

describe("e2e/bootstrap", () => {
  let ctx: ScenarioCtx;

  beforeEach(async () => {
    ctx = await scenarioBoot();
  });

  afterEach(async () => {
    await scenarioTeardown(ctx);
  });

  it("AppModule boots cleanly under the harness", () => {
    expect(ctx.app).toBeDefined();
    expect(ctx.port).toBeGreaterThan(0);
  });

  it("AgentRegistry contains the notes domain", () => {
    const registry = ctx.app.get(AgentRegistry);
    const names = registry.listAll().map((s) => s.name);
    expect(names).toContain("notes");
  });

  it("AgentRegistry does NOT contain the memory spec after the memory refactor", () => {
    const registry = ctx.app.get(AgentRegistry);
    const names = registry.listAll().map((s) => s.name);
    expect(names).not.toContain("memory");
    expect(names).not.toContain("memory_search");
  });

  it("FlushHookRegistry has a hook registered for notes-session", () => {
    const flushHooks = ctx.app.get(FlushHookRegistry);
    const hook = flushHooks.get("notes-session");
    expect(hook).toBeTruthy();
  });
});
