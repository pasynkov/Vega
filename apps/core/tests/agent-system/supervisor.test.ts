import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { END } from "@langchain/langgraph";
import { SupervisorNode } from "../../src/conversation/kernel/supervisor/supervisor.node";

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

function makeStubModelService(toolCall: { name: string; args: unknown } | null) {
  // Stub the AIMessage that bindTools(...).invoke returns. When toolCall is
  // null we return an empty assistant turn so the fallback path runs.
  const replyMessage = new AIMessage({
    content: "",
    tool_calls: toolCall ? [{ id: "tc-1", name: toolCall.name, args: toolCall.args as any }] : [],
  } as any);
  return {
    getModel: () => ({
      bindTools: () => ({
        invoke: async () => replyMessage,
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
    const llm = makeStubModelService({
      name: "route",
      args: { goto: "memory", task: "remember user prefers espresso" },
    });

    const node = new SupervisorNode(new StubLogger() as any, registry as any, llm as any);
    const cmd: any = await node.run(baseState as any);

    expect(Array.isArray(cmd.goto) ? cmd.goto[0] : cmd.goto).toBe("memory");
    expect(cmd.update.messages).toHaveLength(1);
    expect(String(cmd.update.messages[0].content)).toContain("remember user prefers espresso");
  });

  it("ends the turn with empty speakText when LLM chooses __end__", async () => {
    const registry = makeRegistry([
      { name: "memory", description: "save/recall facts", examples: [] },
    ]);
    const llm = makeStubModelService({ name: "route", args: { goto: "__end__", speakText: "" } });

    const node = new SupervisorNode(new StubLogger() as any, registry as any, llm as any);
    const cmd: any = await node.run(baseState as any);

    expect(Array.isArray(cmd.goto) ? cmd.goto[0] : cmd.goto).toBe(END);
    expect(String(cmd.update.messages[0].content)).toBe("");
  });

  it("falls back to empty reply when LLM returns invalid route", async () => {
    const registry = makeRegistry([
      { name: "memory", description: "save/recall facts", examples: [] },
    ]);
    const llm = makeStubModelService({ name: "route", args: { goto: "nonsense" } });

    const node = new SupervisorNode(new StubLogger() as any, registry as any, llm as any);
    const cmd: any = await node.run(baseState as any);

    expect(Array.isArray(cmd.goto) ? cmd.goto[0] : cmd.goto).toBe(END);
    expect(String(cmd.update.messages[0].content)).toBe("");
  });
});
