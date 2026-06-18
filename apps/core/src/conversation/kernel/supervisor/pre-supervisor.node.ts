import { Inject, Injectable, Optional } from "@nestjs/common";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { HumanMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { MEMORY_SEARCH_PORT, type MemorySearchPort } from "./memory-search.port";
import type { VegaStateType } from "./state";

const TOP_K = 5;

@Injectable()
export class PreSupervisorNode {
  constructor(
    @InjectPinoLogger(PreSupervisorNode.name) private readonly logger: PinoLogger,
    @Optional() @Inject(MEMORY_SEARCH_PORT) private readonly memory?: MemorySearchPort,
  ) {}

  asNode(): (state: VegaStateType) => Promise<Partial<VegaStateType>> {
    return (state) => this.run(state);
  }

  async run(state: VegaStateType): Promise<Partial<VegaStateType>> {
    if (!this.memory) {
      return { memoryHints: [] };
    }
    const latest = latestUserText(state.messages);
    if (!latest) {
      return { memoryHints: [] };
    }
    try {
      const matches = await this.memory.searchTopK(latest, TOP_K);
      const hints = matches.map((m) => m.content);
      this.logger.debug({ count: hints.length }, "Memory hints loaded");
      return { memoryHints: hints };
    } catch (err) {
      this.logger.warn({ err }, "Memory hint lookup failed, proceeding without hints");
      return { memoryHints: [] };
    }
  }
}

function latestUserText(messages: BaseMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m instanceof HumanMessage) {
      const c = m.content;
      if (typeof c === "string") return c;
      if (Array.isArray(c)) {
        const text = c
          .map((part) => (typeof part === "string" ? part : (part as { text?: string }).text ?? ""))
          .join(" ")
          .trim();
        if (text.length > 0) return text;
      }
    }
  }
  return null;
}
