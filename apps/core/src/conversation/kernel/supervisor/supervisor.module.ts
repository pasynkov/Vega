import { Global, Module } from "@nestjs/common";
import { PreSupervisorNode } from "./pre-supervisor.node";
import { SupervisorNode } from "./supervisor.node";

@Global()
@Module({
  providers: [PreSupervisorNode, SupervisorNode],
  exports: [PreSupervisorNode, SupervisorNode],
})
export class SupervisorModule {}

export { SupervisorNode } from "./supervisor.node";
export { PreSupervisorNode } from "./pre-supervisor.node";
export { VegaState, type VegaStateType, type ActiveContext } from "./state";
export { RouteSchema, makeRouteValidator, END_NODE, IMMERSIVE_OPEN_NODE } from "./route.schema";
export { MEMORY_SEARCH_PORT, type MemorySearchPort } from "./memory-search.port";
export { buildSupervisorPrompt } from "./supervisor.prompt";
