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
  const dumpHandles = (label: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handles = (process as any)._getActiveHandles?.() ?? [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const requests = (process as any)._getActiveRequests?.() ?? [];
    const summary = (h: unknown) => {
      const obj = h as { constructor?: { name?: string } };
      return obj?.constructor?.name ?? typeof h;
    };
    // eslint-disable-next-line no-console
    console.error(
      `[Bootstrap] ${label}: handles=${handles.length} requests=${requests.length}\n` +
        `  handles: ${handles.map(summary).join(", ")}\n` +
        `  requests: ${requests.map(summary).join(", ")}`,
    );
  };

  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      logger.warn(`Second ${signal}, force exit`, "Bootstrap");
      process.exit(1);
    }
    shuttingDown = true;
    logger.log(`Shutting down (${signal})…`, "Bootstrap");

    dumpHandles("before app.close()");

    try {
      await app.close();
      logger.log("app.close() resolved", "Bootstrap");
    } catch (err) {
      logger.error(`app.close() threw: ${err}`, "Bootstrap");
    }

    dumpHandles("after app.close()");

    // Give pino a tick to flush, then dump again. If anything is still
    // pending the dump tells us what it is.
    setTimeout(() => dumpHandles("after 250 ms grace"), 250).unref();
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Fatal during bootstrap:", err);
  process.exit(1);
});
