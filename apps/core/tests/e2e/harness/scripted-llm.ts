import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";

// ────────────────────────────────────────────────────────────────────
// Queue entries
// ────────────────────────────────────────────────────────────────────

interface RouteEntry {
  kind: "route";
  args: { goto: string; task?: string; speakText?: string };
}

interface ToolCallSpec {
  name: string;
  args: Record<string, unknown>;
}

interface SubAgentEntry {
  kind: "subagent";
  domain: string;
  toolCalls: ToolCallSpec[];
  result: { status: "ok" | "clarify" | "error"; summary?: string; data?: unknown };
}

type Entry = RouteEntry | SubAgentEntry;

interface Store {
  queue: Entry[];
  lastSupervisorPrompt: BaseMessage[] | null;
  lastSubAgentPrompt: { domain: string; messages: BaseMessage[] } | null;
}

const store: Store = {
  queue: [],
  lastSupervisorPrompt: null,
  lastSubAgentPrompt: null,
};

// Exposed so the mock factories can capture the same singleton.
export function getStore(): Store {
  return store;
}

// ────────────────────────────────────────────────────────────────────
// Public controller
// ────────────────────────────────────────────────────────────────────

export class ScriptedLlm {
  reset(): void {
    store.queue = [];
    store.lastSupervisorPrompt = null;
    store.lastSubAgentPrompt = null;
  }

  expectRoute(args: { goto: string; task?: string; speakText?: string }): this {
    store.queue.push({ kind: "route", args });
    return this;
  }

  expectSubAgent(
    domain: string,
    spec: {
      toolCalls?: ToolCallSpec[];
      result?: {
        status?: "ok" | "clarify" | "error";
        summary?: string;
        data?: unknown;
      };
    },
  ): this {
    store.queue.push({
      kind: "subagent",
      domain,
      toolCalls: spec.toolCalls ?? [],
      result: {
        status: spec.result?.status ?? "ok",
        summary: spec.result?.summary,
        data: spec.result?.data,
      },
    });
    return this;
  }

  get remaining(): Entry[] {
    return [...store.queue];
  }

  get lastSupervisorPrompt(): BaseMessage[] | null {
    return store.lastSupervisorPrompt;
  }

  get lastSubAgentPrompt(): { domain: string; messages: BaseMessage[] } | null {
    return store.lastSubAgentPrompt;
  }

  assertConsumed(): void {
    if (store.queue.length === 0) return;
    const summary = store.queue
      .map((e) =>
        e.kind === "route"
          ? `route(${e.args.goto})`
          : `subagent(${e.domain})`,
      )
      .join(", ");
    throw new Error(
      `ScriptedLlm: queue not fully consumed; remaining: ${summary}`,
    );
  }
}

// ────────────────────────────────────────────────────────────────────
// Mock builders — installed by each scenario file via vi.mock.
// ────────────────────────────────────────────────────────────────────

function takeRoute(): RouteEntry {
  const entry = store.queue.shift();
  if (!entry) {
    throw new Error("ScriptedLlm: queue exhausted (expected route)");
  }
  if (entry.kind !== "route") {
    throw new Error(
      `ScriptedLlm: expected route at queue head, got ${entry.kind}(${
        entry.kind === "subagent" ? entry.domain : ""
      })`,
    );
  }
  return entry;
}

function takeSubAgent(domain: string): SubAgentEntry {
  const entry = store.queue.shift();
  if (!entry) {
    throw new Error(
      `ScriptedLlm: queue exhausted (expected sub-agent for ${domain})`,
    );
  }
  if (entry.kind !== "subagent") {
    throw new Error(
      `ScriptedLlm: expected sub-agent at queue head, got route(${
        entry.kind === "route" ? entry.args.goto : ""
      })`,
    );
  }
  if (entry.domain !== domain) {
    throw new Error(
      `ScriptedLlm: expected sub-agent for "${entry.domain}", got "${domain}"`,
    );
  }
  return entry;
}

/**
 * Build the `@langchain/anthropic` mock exports. The mock implements just
 * enough of ChatAnthropic to drive the supervisor's `.bindTools(...).invoke(...)`
 * path: invoke returns an AIMessage carrying a single `tool_calls: [{name:"route",args}]`
 * pulled from the queue head.
 */
export function buildAnthropicMock(): { ChatAnthropic: new (...args: unknown[]) => unknown } {
  class StubChatAnthropic {
    constructor(_opts: unknown) {
      void _opts;
    }
    bindTools(_tools: unknown, _opts?: unknown) {
      void _tools;
      void _opts;
      return {
        invoke: async (messages: BaseMessage[]): Promise<AIMessage> => {
          store.lastSupervisorPrompt = messages;
          const entry = takeRoute();
          return new AIMessage({
            content: "",
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            tool_calls: [
              {
                id: `rt-${Math.floor(Math.random() * 1e9)}`,
                name: "route",
                args: entry.args,
              },
            ],
          } as unknown as { content: string });
        },
      };
    }
    async invoke(_messages: BaseMessage[]): Promise<AIMessage> {
      void _messages;
      return new AIMessage("ok");
    }
  }
  return { ChatAnthropic: StubChatAnthropic };
}

/**
 * Build the `@langchain/langgraph/prebuilt` mock exports. The mock
 * implements `createReactAgent({tools, ...})` whose `invoke` consumes one
 * `expectSubAgent(domain, ...)` entry from the queue and:
 *   1. extracts the domain name from the sub-agent prompt (the
 *      `systemPrompt` field configured by the AgentSpec doesn't carry the
 *      name, but the prompt is bound at factory time so the closure
 *      remembers it; instead we read the supervisor's `task: ...` marker
 *      and match by queue head expectation),
 *   2. invokes each scripted tool against the real `tools` array passed
 *      by sub-agent.factory.ts,
 *   3. returns a final AIMessage whose content is JSON.stringify(result)
 *      so parseAgentOutput in sub-agent.factory.ts surfaces the scripted
 *      status/summary/data to the supervisor.
 */
export function buildReactAgentMock(): {
  createReactAgent: (args: { llm: unknown; tools: unknown[]; prompt?: string }) => {
    invoke: (state: { messages: BaseMessage[] }, config?: unknown) => Promise<{ messages: BaseMessage[] }>;
  };
} {
  return {
    createReactAgent: ({ tools, prompt }) => {
      const toolList = tools as Array<{ name: string; invoke: (args: unknown, config?: unknown) => Promise<unknown> }>;
      // Infer the domain name from the AgentSpec's systemPrompt. The
      // project's prompt convention starts each domain prompt with
      // "You are the {name} sub-agent." or similar; rather than parse,
      // we match against the queue head's expected domain at invoke time
      // (one entry per call, in order). The prompt itself is unused.
      void prompt;
      return {
        invoke: async (
          state: { messages: BaseMessage[] },
          config?: unknown,
        ): Promise<{ messages: BaseMessage[] }> => {
          // Peek at queue to know which domain to match; takeSubAgent
          // enforces order.
          const head = store.queue[0];
          if (!head || head.kind !== "subagent") {
            throw new Error(
              "ScriptedLlm: queue exhausted (expected sub-agent at invoke time)",
            );
          }
          store.lastSubAgentPrompt = { domain: head.domain, messages: state.messages };
          const entry = takeSubAgent(head.domain);

          const newMessages: BaseMessage[] = [...state.messages];
          for (const call of entry.toolCalls) {
            const tool = toolList.find((t) => t.name === call.name);
            if (!tool) {
              throw new Error(
                `ScriptedLlm: tool "${call.name}" not found in sub-agent "${entry.domain}" toolset`,
              );
            }
            // Append the assistant's tool_call so any downstream
            // bookkeeping (countToolCalls, collectToolNames) sees it.
            newMessages.push(
              new AIMessage({
                content: "",
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                tool_calls: [
                  {
                    id: `tc-${entry.domain}-${call.name}-${newMessages.length}`,
                    name: call.name,
                    args: call.args,
                  },
                ],
              } as unknown as { content: string }),
            );
            let toolResult: unknown;
            try {
              toolResult = await tool.invoke(call.args, config);
            } catch (err) {
              // Surface tool errors as test failures by re-throwing —
              // they're real bugs, not expected behavior to swallow.
              throw new Error(
                `ScriptedLlm: tool "${call.name}" in "${entry.domain}" threw: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            }
            newMessages.push(
              new ToolMessage({
                name: call.name,
                tool_call_id: `tc-${entry.domain}-${call.name}-${newMessages.length}`,
                content:
                  typeof toolResult === "string"
                    ? toolResult
                    : JSON.stringify(toolResult),
              }),
            );
          }
          const finalContent = JSON.stringify({
            status: entry.result.status,
            summary: entry.result.summary ?? "",
            data: entry.result.data,
          });
          newMessages.push(new AIMessage(finalContent));
          return { messages: newMessages };
        },
      };
    },
  };
}

// Re-export utilities for ad-hoc use inside scenario files when needed.
export { HumanMessage };
