import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { Logger } from "nestjs-pino";
import { AppModule } from "./app.module";
import { EnvConfig } from "./config/env";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));

  const env = app.get(EnvConfig);
  // The WS gateway binds itself on its own port via the ws library; we keep
  // the Nest HTTP listener bound to a closed port purely so the module
  // initialization completes.
  await app.init();

  const logger = app.get(Logger);
  logger.log(
    `Vega Core started. WS=ws://${env.earWsHost}:${env.earWsPort}/ear` +
      ` lang=${env.deepgramLanguage} timeout=${env.sessionTimeoutMs}ms` +
      ` recordings=${env.recordingsDir}`,
    "Bootstrap",
  );

  const shutdown = async () => {
    logger.log("Shutting down…", "Bootstrap");
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Fatal during bootstrap:", err);
  process.exit(1);
});
