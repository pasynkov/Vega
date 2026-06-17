import { Module } from "@nestjs/common";
import { LoggerModule } from "nestjs-pino";
import pretty from "pino-pretty";
import { EnvConfigModule } from "./config/env.module";
import { EarModule } from "./ear/ear.module";
import { DbModule } from "./db/db.module";
import { LlmModule } from "./llm/llm.module";
import { AgentSystemModule } from "./agents/agent-system.module";
import { SupervisorModule } from "./agents/supervisor/supervisor.module";
import { MemoryModule } from "./memory/memory.module";
import { NotesModule } from "./notes/notes.module";
import { ConversationModule } from "./conversation/conversation.module";
import { EarSessionsModule } from "./ear-sessions/ear-sessions.module";

// Use pino-pretty as a synchronous stream rather than a worker-thread
// transport. The transport keeps the event loop alive after app.close()
// because the worker is a separate thread Node won't terminate on its
// own, which made Ctrl+C feel like a hang.
const prettyStream = pretty({
  colorize: true,
  singleLine: true,
  translateTime: "HH:MM:ss.l",
  ignore: "pid,hostname",
  messageFormat: "[{context}] {msg}",
  sync: true,
});

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? "debug",
        stream: prettyStream,
        redact: {
          paths: [
            "DEEPGRAM_API_KEY",
            "*.DEEPGRAM_API_KEY",
            "*.deepgramApiKey",
            "ANTHROPIC_API_KEY",
            "*.ANTHROPIC_API_KEY",
            "*.anthropicApiKey",
          ],
          censor: "[redacted]",
        },
      },
    }),
    EnvConfigModule,
    DbModule,
    LlmModule,
    AgentSystemModule,
    SupervisorModule,
    EarModule,
    ConversationModule,
    EarSessionsModule,
    MemoryModule,
    NotesModule,
  ],
})
export class AppModule {}
