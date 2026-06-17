import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { Logger } from "nestjs-pino";
import { AppModule } from "./app.module";
import { EnvConfig } from "./config/env";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  // NOTE: Do NOT call app.enableShutdownHooks() — it installs its own SIGINT
  // listener that races with the manual handler below and ends up calling
  // onApplicationShutdown twice. The manual handler calls app.close() which
  // already fires the lifecycle hooks.

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
      // eslint-disable-next-line no-console
      console.error("[Bootstrap] Shutdown watchdog tripped — forcing exit");
      process.exit(1);
    }, 2_000);
    watchdog.unref();
    try {
      await app.close();
    } catch (err) {
      logger.error(`Error during app.close(): ${err}`, "Bootstrap");
    } finally {
      clearTimeout(watchdog);
      // Pino's pretty-print transport runs in a worker thread that keeps the
      // event loop alive after app.close(). exit() is the only reliable way
      // to actually return the shell prompt.
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
