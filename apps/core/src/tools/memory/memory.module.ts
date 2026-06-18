import { Global, Module, OnModuleInit } from "@nestjs/common";
import { AgentRegistry } from "../../conversation/kernel/agent-registry.service";
import { MEMORY_SEARCH_PORT } from "../../conversation/kernel/supervisor/memory-search.port";
import { MemoryService } from "./memory.service";
import { MemoryAgentService } from "./memory-agent.service";
import { RememberToolProvider } from "./remember.tool";

const memorySearchPortProvider = {
  provide: MEMORY_SEARCH_PORT,
  useExisting: MemoryService,
};

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
export class MemoryModule implements OnModuleInit {
  constructor(
    private readonly registry: AgentRegistry,
    private readonly memoryAgent: MemoryAgentService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this.memoryAgent.spec);
  }
}
