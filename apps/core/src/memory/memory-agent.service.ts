import { Injectable } from "@nestjs/common";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { LlmService } from "../llm/llm.module";
import { MemoryService } from "./memory.service";
import { buildMemoryTools } from "./memory.tools";
import { buildMemoryAgentSpec } from "./memory.agent";
import type { AgentSpec } from "../agents/agent.types";

@Injectable()
export class MemoryAgentService {
  private readonly agent: ReturnType<typeof createReactAgent>;
  private readonly _spec: AgentSpec;

  constructor(
    @InjectPinoLogger(MemoryAgentService.name) private readonly logger: PinoLogger,
    private readonly memory: MemoryService,
    private readonly llm: LlmService,
  ) {
    const tools = buildMemoryTools(this.memory);
    this._spec = buildMemoryAgentSpec(tools);
    this.agent = createReactAgent({
      llm: this.llm.getModel({ model: this._spec.model }),
      tools: tools as any,
      prompt: this._spec.systemPrompt,
    });
    this.logger.info({ tools: tools.length }, "Memory agent built");
  }

  get spec(): AgentSpec {
    return this._spec;
  }

  // Fire-and-forget invocation used by rememberTool. The caller is told
  // {queued: true} immediately; the underlying agent runs in the
  // background and its failures are logged but never propagate back.
  dispatch(task: string): void {
    void this.runInBackground(task);
  }

  private async runInBackground(task: string): Promise<void> {
    try {
      await this.agent.invoke({
        messages: [
          new SystemMessage("Background memory write requested by another agent."),
          new HumanMessage(task),
        ],
      });
    } catch (err) {
      this.logger.warn({ err, task }, "Background memory-agent invocation failed");
    }
  }
}
