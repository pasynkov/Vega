import { Global, Module } from "@nestjs/common";
import { AgentRegistry } from "./agent-registry.service";

@Global()
@Module({
  providers: [AgentRegistry],
  exports: [AgentRegistry],
})
export class AgentSystemModule {}

export { AgentRegistry } from "./agent-registry.service";
export { makeTool, ToolValidationError, buildJsonSchema } from "./tool-factory";
export { AGENT_SPEC, RESERVED_AGENT_NAMES } from "./agent.tokens";
export type { AgentSpec, AgentOutput, AgentOutputStatus, AgentTool, AgentToolHandler, SupervisorDomainMeta } from "./agent.types";
