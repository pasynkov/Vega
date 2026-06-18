import { Global, Module, OnModuleInit } from "@nestjs/common";
import { AgentRegistry } from "../../conversation/kernel/agent-registry.service";
import { ConversationModule } from "../../conversation/conversation.module";
import { NotesStorageService } from "./notes-storage.service";
import { NotesAgentService } from "./notes-agent.service";

@Global()
@Module({
  imports: [ConversationModule],
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
