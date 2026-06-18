import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { ConversationService } from "../../src/conversation/conversation.service";

// Bug-3 coverage: ConversationService.handleTurn SHALL serialize per
// sessionId. The previous inFlight-read-then-set pattern raced when two
// callers read the same `prior` and both started `runTurn` after `prior`
// settled. The fixed implementation chains onto the latest tail.

class StubLogger {
  info() {}
  warn() {}
  error() {}
  debug() {}
  level: string = "info";
}

function makeService(graphInvoke: (state: any) => Promise<any>): ConversationService {
  const graph = { invoke: graphInvoke };
  const graphFactory = { build: () => graph } as any;
  const sessions = { touch: vi.fn(async () => undefined) } as any;
  return new ConversationService(new StubLogger() as any, graphFactory, sessions);
}

describe("ConversationService.handleTurn per-session serialization", () => {
  it("two concurrent calls run their runTurn sequentially (not in parallel)", async () => {
    const events: string[] = [];
    let activeCount = 0;
    let maxActive = 0;

    const graphInvoke = vi.fn(async (state: any) => {
      activeCount += 1;
      maxActive = Math.max(maxActive, activeCount);
      const userText = (state.messages.at(-1) as HumanMessage).content as string;
      events.push(`start:${userText}`);
      await new Promise((r) => setTimeout(r, 30));
      events.push(`end:${userText}`);
      activeCount -= 1;
      return { messages: [new AIMessage("ok")], lastAgentResult: { status: "ok" } };
    });

    const svc = makeService(graphInvoke);
    const [a, b] = await Promise.all([
      svc.handleTurn("S", "first"),
      svc.handleTurn("S", "second"),
    ]);

    expect(a.outcome).toBe("acted");
    expect(b.outcome).toBe("acted");
    expect(maxActive).toBe(1);
    expect(events).toEqual([
      "start:first",
      "end:first",
      "start:second",
      "end:second",
    ]);
  });

  it("three back-to-back calls run in arrival order", async () => {
    const events: string[] = [];
    const graphInvoke = vi.fn(async (state: any) => {
      const userText = (state.messages.at(-1) as HumanMessage).content as string;
      events.push(`start:${userText}`);
      await new Promise((r) => setTimeout(r, 15));
      events.push(`end:${userText}`);
      return { messages: [new AIMessage("ok")], lastAgentResult: { status: "ok" } };
    });
    const svc = makeService(graphInvoke);
    await Promise.all([
      svc.handleTurn("S", "first"),
      svc.handleTurn("S", "second"),
      svc.handleTurn("S", "third"),
    ]);
    expect(events).toEqual([
      "start:first",
      "end:first",
      "start:second",
      "end:second",
      "start:third",
      "end:third",
    ]);
  });

  it("a turn that throws does not block subsequent queued turns", async () => {
    const events: string[] = [];
    let firstCall = true;
    const graphInvoke = vi.fn(async (state: any) => {
      const userText = (state.messages.at(-1) as HumanMessage).content as string;
      if (firstCall) {
        firstCall = false;
        events.push(`throw:${userText}`);
        throw new Error("boom");
      }
      events.push(`ok:${userText}`);
      return { messages: [new AIMessage("ok")], lastAgentResult: { status: "ok" } };
    });
    const svc = makeService(graphInvoke);
    const [a, b] = await Promise.all([
      svc.handleTurn("S", "fail"),
      svc.handleTurn("S", "succeed"),
    ]);
    expect(a.outcome).toBe("error");
    expect(b.outcome).toBe("acted");
    expect(events).toEqual(["throw:fail", "ok:succeed"]);
  });
});
