import { Global, Module, OnModuleInit } from "@nestjs/common";
import { AgentRegistry } from "../agents/agent-registry.service";
import { EarModule } from "../ear/ear.module";
import { EarSessionsModule } from "../ear-sessions/ear-sessions.module";
import { NotesStorageService } from "./notes-storage.service";
import { NotesAgentService } from "./notes-agent.service";

@Global()
@Module({
  imports: [EarModule, EarSessionsModule],
  providers: [NotesStorageService, NotesAgentService],
  exports: [NotesStorageService, NotesAgentService],
})
export class NotesModule implements OnModuleInit {
  constructor(
    private readonly registry: AgentRegistry,
    private readonly notesAgent: NotesAgentService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this.notesAgent.spec);
  }
}
