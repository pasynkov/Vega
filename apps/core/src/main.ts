import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { Logger } from "nestjs-pino";
import { AppModule } from "./app.module";
import { EnvConfig } from "./config/env";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();

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

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      logger.warn(`Force exit on second ${signal}`, "Bootstrap");
      process.exit(1);
    }
    shuttingDown = true;
    logger.log(`Shutting down (${signal})…`, "Bootstrap");
    const watchdog = setTimeout(() => {
      logger.error("Shutdown watchdog tripped after 5s — forcing exit", "Bootstrap");
      process.exit(1);
    }, 5_000);
    try {
      await app.close();
    } catch (err) {
      logger.error(`Error during app.close(): ${err}`, "Bootstrap");
    } finally {
      clearTimeout(watchdog);
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Fatal during bootstrap:", err);
  process.exit(1);
});
