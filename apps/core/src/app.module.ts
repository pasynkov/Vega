import { Module } from "@nestjs/common";
import { LoggerModule } from "nestjs-pino";
import { EnvConfigModule } from "./config/env.module";
import { EarModule } from "./ear/ear.module";

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? "debug",
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            singleLine: true,
            translateTime: "HH:MM:ss.l",
            ignore: "pid,hostname",
            messageFormat: "[{context}] {msg}",
          },
        },
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
