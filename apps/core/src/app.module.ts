import { Module } from "@nestjs/common";
import { LoggerModule } from "nestjs-pino";
import pretty from "pino-pretty";
import { EnvConfigModule } from "./config/env.module";
import { EarModule } from "./ear/ear.module";

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
          paths: ["DEEPGRAM_API_KEY", "*.DEEPGRAM_API_KEY", "*.deepgramApiKey"],
          censor: "[redacted]",
        },
      },
    }),
    EnvConfigModule,
    EarModule,
  ],
})
export class AppModule {}
