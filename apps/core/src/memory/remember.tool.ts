import { Injectable } from "@nestjs/common";
import { makeTool } from "../agents/tool-factory";
import type { AgentTool } from "../agents/agent.types";
import { RememberDto } from "./memory.dtos";
import { MemoryAgentService } from "./memory-agent.service";

@Injectable()
export class RememberToolProvider {
  private readonly _tool: AgentTool;

  constructor(private readonly memoryAgent: MemoryAgentService) {
    this._tool = makeTool({
      dto: RememberDto,
      name: "remember",
      description: "Persist a fact about the user via the memory agent. Returns immediately; the underlying agent runs asynchronously and dedup-aware.",
      handler: (dto) => {
        this.memoryAgent.dispatch(`remember: ${dto.fact}`);
        return { queued: true };
      },
    });
  }

  get tool(): AgentTool {
    return this._tool;
  }
}
