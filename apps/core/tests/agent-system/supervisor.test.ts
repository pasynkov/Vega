import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { HumanMessage } from "@langchain/core/messages";
import { END } from "@langchain/langgraph";
import { SupervisorNode } from "../../src/agents/supervisor/supervisor.node";

class StubLogger {
  info() {}
  warn() {}
  error() {}
  debug() {}
}

function makeRegistry(domains: { name: string; description: string; examples: string[] }[]) {
  return {
    metaForSupervisor: () => domains,
  };
}

function makeStubModelService(routerOutput: unknown) {
  return {
    getModel: () => ({
      withStructuredOutput: () => ({
        invoke: async () => routerOutput,
      }),
    }),
  };
}

const baseState = {
  messages: [new HumanMessage("привет")],
  sessionId: "default",
  activeContext: { lastEntityIds: {} },
  memoryHints: [],
  lastAgentResult: undefined,
};

describe("SupervisorNode", () => {
  it("routes to a registered domain when LLM picks one", async () => {
    const registry = makeRegistry([
      { name: "memory", description: "save/recall facts", examples: ["запомни X"] },
      { name: "calendar", description: "manage calendar", examples: ["встреча завтра"] },
    ]);
    const llm = makeStubModelService({ goto: "memory", task: "remember user prefers espresso" });

    const node = new SupervisorNode(new StubLogger() as any, registry as any, llm as any);
    const cmd: any = await node.run(baseState as any);

    expect(Array.isArray(cmd.goto) ? cmd.goto[0] : cmd.goto).toBe("memory");
    expect(cmd.update.messages).toHaveLength(1);
    expect(String(cmd.update.messages[0].content)).toContain("remember user prefers espresso");
  });

  it("ends the turn with speakText when LLM chooses __end__", async () => {
    const registry = makeRegistry([
      { name: "memory", description: "save/recall facts", examples: [] },
    ]);
    const llm = makeStubModelService({ goto: "__end__", speakText: "Здравствуй" });

    const node = new SupervisorNode(new StubLogger() as any, registry as any, llm as any);
    const cmd: any = await node.run(baseState as any);

    expect(Array.isArray(cmd.goto) ? cmd.goto[0] : cmd.goto).toBe(END);
    expect(String(cmd.update.messages[0].content)).toBe("Здравствуй");
  });

  it("falls back to clarification reply when LLM returns invalid route", async () => {
    const registry = makeRegistry([
      { name: "memory", description: "save/recall facts", examples: [] },
    ]);
    const llm = makeStubModelService({ goto: "nonsense" });

    const node = new SupervisorNode(new StubLogger() as any, registry as any, llm as any);
    const cmd: any = await node.run(baseState as any);

    expect(Array.isArray(cmd.goto) ? cmd.goto[0] : cmd.goto).toBe(END);
    expect(String(cmd.update.messages[0].content)).toMatch(/повтори/);
  });
});
