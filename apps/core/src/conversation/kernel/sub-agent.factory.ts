import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { Command } from "@langchain/langgraph";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import type { PinoLogger } from "nestjs-pino";
import type { AgentOutput, AgentSpec } from "./agent.types";
import type { VegaStateType } from "./supervisor/state";
import type { LlmService } from "../../integrations/llm/llm.module";

interface BuildSubAgentArgs {
  spec: AgentSpec;
  llm: LlmService;
  logger: PinoLogger;
}

// Wraps a domain AgentSpec into a graph node function. The factory builds
// the underlying react-agent once at boot. Per-turn the returned node
// reads the supervisor's task off state.messages, invokes the react-agent,
// parses the final message into AgentOutput, and routes back to the
// supervisor with both the messages and lastAgentResult updated.
export function makeSubAgentNode({ spec, llm, logger }: BuildSubAgentArgs) {
  const agent = createReactAgent({
    llm: llm.getModel({ model: spec.model }),
    tools: spec.tools as any,
    prompt: spec.systemPrompt,
  });

  const modelId = spec.model ?? "default";
  return async (state: VegaStateType): Promise<Command> => {
    const task = extractSupervisorTask(state.messages);
    const startedAt = Date.now();
    logger.info(
      { agent: spec.name, model: modelId, taskLen: task.length, task: task.slice(0, 160) },
      "LLM → sub-agent",
    );
    try {
      const result = await agent.invoke({
        messages: [new HumanMessage(task)],
      });
      const finalMsg = lastAssistantMessage(result.messages);
      const output = parseAgentOutput(finalMsg);
      const toolCalls = countToolCalls(result.messages);
      const toolNames = collectToolNames(result.messages);
      const usage = sumUsage(result.messages);
      logger.info(
        {
          agent: spec.name,
          model: modelId,
          status: output.status,
          tools: toolCalls,
          toolNames,
          inputTokens: usage.input,
          outputTokens: usage.output,
          ms: Date.now() - startedAt,
          summary: output.summary.slice(0, 160),
        },
        "LLM ← sub-agent",
      );
      return new Command({
        goto: "supervisor",
        update: {
          messages: [new AIMessage({ content: renderForSupervisor(output), name: spec.name })],
          lastAgentResult: output,
        },
      });
    } catch (err) {
      const output: AgentOutput = {
        status: "error",
        summary: err instanceof Error ? err.message : String(err),
      };
      logger.error(
        { agent: spec.name, model: modelId, err, ms: Date.now() - startedAt },
        "LLM ← sub-agent ERROR",
      );
      return new Command({
        goto: "supervisor",
        update: {
          messages: [new AIMessage({ content: renderForSupervisor(output), name: spec.name })],
          lastAgentResult: output,
        },
      });
    }
  };
}

function countToolCalls(messages: BaseMessage[]): number {
  let n = 0;
  for (const m of messages) {
    const calls = (m as any).tool_calls;
    if (Array.isArray(calls)) n += calls.length;
  }
  return n;
}

function collectToolNames(messages: BaseMessage[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    const calls = (m as any).tool_calls;
    if (Array.isArray(calls)) {
      for (const c of calls) {
        if (typeof c?.name === "string") out.push(c.name);
      }
    }
  }
  return out;
}

function sumUsage(messages: BaseMessage[]): { input: number; output: number } {
  let input = 0;
  let output = 0;
  for (const m of messages) {
    const u = (m as any).usage_metadata ?? (m as any).response_metadata?.usage;
    if (u) {
      if (typeof u.input_tokens === "number") input += u.input_tokens;
      if (typeof u.output_tokens === "number") output += u.output_tokens;
    }
  }
  return { input, output };
}

function extractSupervisorTask(messages: BaseMessage[]): string {
  // Walk backwards looking for the supervisor's "task: ..." message.
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const content = typeof m.content === "string" ? m.content : "";
    if (content.startsWith("task: ")) {
      return content.slice("task: ".length);
    }
  }
  // Fallback: the most recent human message.
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m instanceof HumanMessage && typeof m.content === "string") {
      return m.content;
    }
  }
  return "";
}

function lastAssistantMessage(messages: BaseMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m instanceof AIMessage) {
      const c = m.content;
      if (typeof c === "string") return c;
      if (Array.isArray(c)) {
        return c
          .map((p) => (typeof p === "string" ? p : (p as { text?: string }).text ?? ""))
          .join("");
      }
    }
  }
  return "";
}

function parseAgentOutput(raw: string): AgentOutput {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed = JSON.parse(trimmed) as Partial<AgentOutput>;
      if (parsed && typeof parsed === "object" && typeof parsed.summary === "string") {
        const status: AgentOutput["status"] =
          parsed.status === "clarify" || parsed.status === "error" ? parsed.status : "ok";
        return {
          status,
          summary: parsed.summary,
          data: parsed.data,
        };
      }
    } catch {
      // fall through to plain-text path
    }
  }
  return { status: "ok", summary: trimmed };
}

function renderForSupervisor(out: AgentOutput): string {
  return JSON.stringify(out);
}
