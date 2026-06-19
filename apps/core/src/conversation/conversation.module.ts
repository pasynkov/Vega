import { Global, Module } from "@nestjs/common";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { EnvConfig } from "../config/env";
import { DbModule } from "../integrations/database/db.module";
import { AgentSystemModule } from "./kernel/agent-system.module";
import { SupervisorModule } from "./kernel/supervisor/supervisor.module";
import { EarModule } from "./ear/ear.module";
import { EarSessionsModule } from "./sessions/ear-sessions.module";
import { GraphFactory, CHECKPOINTER } from "./kernel/graph.factory";
import { ConversationService } from "./conversation.service";
import { SessionRegistry } from "./session-registry.service";
import { ImmersiveModule } from "./immersive/immersive.module";

const checkpointerProvider = {
  provide: CHECKPOINTER,
  inject: [EnvConfig],
  useFactory: (env: EnvConfig): SqliteSaver => {
    return SqliteSaver.fromConnString(env.vegaDbPath);
  },
};

// The single public-facing module for domains. Re-exports the kernel
// (AgentSystemModule → AgentRegistry, SupervisorModule), the ear pipeline
// (EarModule → SessionService etc.), and the sessions glue (EarSessionsModule
// → FlushHookRegistry, EarSessionRouter). Domain modules do
// `imports: [ConversationModule]` and inject the services they need without
// naming any pipeline module in their own imports.
@Global()
@Module({
  imports: [DbModule, ImmersiveModule, AgentSystemModule, SupervisorModule, EarModule, EarSessionsModule],
  providers: [
    checkpointerProvider,
    GraphFactory,
    SessionRegistry,
    ConversationService,
  ],
  exports: [
    ImmersiveModule,
    AgentSystemModule,
    SupervisorModule,
    EarModule,
    EarSessionsModule,
    ConversationService,
    SessionRegistry,
    GraphFactory,
    CHECKPOINTER,
  ],
})
export class ConversationModule {}
