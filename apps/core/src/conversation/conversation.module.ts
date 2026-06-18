import { Global, Module } from "@nestjs/common";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { EnvConfig } from "../config/env";
import { GraphFactory, CHECKPOINTER } from "./kernel/graph.factory";
import { ConversationService } from "./conversation.service";
import { SessionRegistry } from "./session-registry.service";

const checkpointerProvider = {
  provide: CHECKPOINTER,
  inject: [EnvConfig],
  useFactory: (env: EnvConfig): SqliteSaver => {
    return SqliteSaver.fromConnString(env.vegaDbPath);
  },
};

@Global()
@Module({
  providers: [
    checkpointerProvider,
    GraphFactory,
    SessionRegistry,
    ConversationService,
  ],
  exports: [ConversationService, SessionRegistry, GraphFactory, CHECKPOINTER],
})
export class ConversationModule {}
