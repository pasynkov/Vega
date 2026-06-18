import type { DynamicStructuredTool, DynamicTool, StructuredToolInterface } from "@langchain/core/tools";

export type AgentTool = DynamicStructuredTool | DynamicTool | StructuredToolInterface;

export interface AgentSpec {
  name: string;
  description: string;
  examples: string[];
  systemPrompt: string;
  tools: AgentTool[];
  enabled: boolean | (() => boolean);
  model?: string;
}

export type AgentOutputStatus = "ok" | "clarify" | "error";

export interface AgentOutput {
  status: AgentOutputStatus;
  summary: string;
  data?: Record<string, unknown>;
}

export interface SupervisorDomainMeta {
  name: string;
  description: string;
  examples: string[];
}

export type AgentToolHandler<DtoT = unknown, ResultT = unknown> = (
  dto: DtoT,
) => Promise<ResultT> | ResultT;
