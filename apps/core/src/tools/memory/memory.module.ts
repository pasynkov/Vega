import { Global, Module } from "@nestjs/common";
import { MEMORY_SEARCH_PORT } from "../../conversation/kernel/supervisor/memory-search.port";
import { MemoryService } from "./memory.service";
import { MemoryAgentService } from "./memory-agent.service";
import { RememberToolProvider } from "./remember.tool";

const memorySearchPortProvider = {
  provide: MEMORY_SEARCH_PORT,
  useExisting: MemoryService,
};

// Memory is a tool, not a domain. It does NOT register an AgentSpec with
// AgentRegistry, so the supervisor cannot route to it. RememberToolProvider
// is injected by other domains' tools to persist facts; MemoryAgentService
// still runs internally to mediate dedup-aware writes triggered by the
// rememberTool's fire-and-forget dispatch.
@Global()
@Module({
  providers: [
    MemoryService,
    MemoryAgentService,
    RememberToolProvider,
    memorySearchPortProvider,
  ],
  exports: [
    MemoryService,
    MemoryAgentService,
    RememberToolProvider,
    MEMORY_SEARCH_PORT,
  ],
})
export class MemoryModule {}
