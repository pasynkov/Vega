import "reflect-metadata";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AppModule } from "../../../src/app.module";
import { DeepgramClient } from "../../../src/integrations/deepgram/deepgram.client";
import { EarIoAdapter } from "../../../src/conversation/ear/ear.io-adapter";
import { EnvConfig } from "../../../src/config/env";
import { FakeDeepgram } from "./fake-deepgram";
import { FakeEar } from "./fake-ear";
import { ScriptedLlm } from "./scripted-llm";
import type { Capability } from "@vega/ear-protocol";

// ────────────────────────────────────────────────────────────────────
// Harness boundary — four building blocks:
//
//   1) bootTestApp        — boots the real AppModule with tmp-root
//                           artifact directories, overrides only the
//                           DeepgramClient provider, and binds the
//                           gateway on an ephemeral port. The LLM
//                           replacement (Anthropic + react-agent) is
//                           installed by each scenario file via vi.mock
//                           against ./scripted-llm.
//   2) FakeEar            — socket.io-client wrapper, typed inbox,
//                           await-able waiters.
//   3) FakeDeepgram       — DeepgramClient override exposing
//                           simulatePartial/Final/UtteranceEnd/Error/Close.
//   4) ScriptedLlm        — imperative-queue controller for the
//                           scripted-llm.ts vi.mock factories.
//
// Test-only assumptions (production code is otherwise untouched):
//   * EAR_WS_PORT=0          — binds to an ephemeral port; harness reads
//                              back the chosen port via app.getHttpServer().
//   * VEGA_DISABLE_BOOT_PING — suppresses the LlmService.verifyAuth/ping
//                              and DeepgramClient.verifyAuth fetches so
//                              the boot is fully offline.
// ────────────────────────────────────────────────────────────────────

export interface ScenarioCtx {
  app: INestApplication;
  ear: FakeEar;
  dg: FakeDeepgram;
  llm: ScriptedLlm;
  tmpRoot: string;
  port: number;
}

export interface ScenarioBootOpts {
  deviceId?: string;
  deviceName?: string;
  capabilities?: Capability[];
  /** Skip connecting/registering the Fake Ear; the test will do it. */
  autoConnect?: boolean;
}

interface TestAppHandle {
  app: INestApplication;
  dg: FakeDeepgram;
  llm: ScriptedLlm;
  tmpRoot: string;
  port: number;
}

export async function bootTestApp(): Promise<TestAppHandle> {
  const tmpRoot = mkdtempSync(join(tmpdir(), "vega-e2e-"));
  const notesDir = join(tmpRoot, "notes");
  const recordingsDir = join(tmpRoot, "recordings");
  const dbPath = join(tmpRoot, "vega.sqlite");

  process.env.DEEPGRAM_API_KEY = "test-deepgram-key";
  process.env.ANTHROPIC_API_KEY = "sk-ant-api-test-stub";
  process.env.EAR_WS_HOST = "127.0.0.1";
  process.env.EAR_WS_PORT = "0";
  process.env.RECORDINGS_DIR = recordingsDir;
  process.env.VEGA_DB_PATH = dbPath;
  process.env.VEGA_NOTES_DIR = notesDir;
  process.env.VEGA_DISABLE_BOOT_PING = "1";
  process.env.LOG_LEVEL = "fatal";

  // Domain DataSources (shopping, ...) write to <repo-root>/output/db/<name>.sqlite
  // — outside the per-test tmp root. Clean them before each boot so
  // scenarios don't see leftovers from a prior test (the same .git anchor
  // resolves the same path every run).
  cleanRepoDomainDbs();

  const dg = new FakeDeepgram();
  const llm = new ScriptedLlm();
  llm.reset();

  // DbService's real onModuleInit walks `src/**/*.entity.{ts,js}` and
  // hands the matching files to TypeORM, which require()'s them through
  // Node's loader. In test mode the entity files are .ts source and
  // Node can't parse TypeScript — boot dies with SyntaxError. Provide a
  // StubDb that initializes the DataSource explicitly with the known
  // entity classes.
  const { DataSource } = await import("typeorm");
  const { DbService } = await import("../../../src/integrations/database/db.module");
  const { Memory } = await import("../../../src/tools/memory/memory.entity");
  const { ConversationSessionRow } = await import("../../../src/conversation/session.entity");

  const stubDataSource = new DataSource({
    type: "better-sqlite3",
    database: dbPath,
    entities: [Memory, ConversationSessionRow],
    synchronize: true,
  });
  await stubDataSource.initialize();
  const stubDb = {
    async onModuleInit() {},
    async onApplicationShutdown() {
      if (stubDataSource.isInitialized) await stubDataSource.destroy();
    },
    get dataSource() {
      return stubDataSource;
    },
  };

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(DeepgramClient)
    .useValue(dg)
    .overrideProvider(DbService)
    .useValue(stubDb)
    .compile();
  const app = moduleRef.createNestApplication();
  app.useWebSocketAdapter(new EarIoAdapter(app));
  await app.init();
  const env = app.get(EnvConfig);
  await app.listen(env.earWsPort, env.earWsHost);

  const server = app.getHttpServer();
  const addr = server.address();
  const port =
    typeof addr === "object" && addr && "port" in addr ? (addr.port as number) : 0;
  if (!port) {
    await app.close();
    rmSync(tmpRoot, { recursive: true, force: true });
    throw new Error("bootTestApp: failed to read ephemeral port from http server");
  }

  return { app, dg, llm, tmpRoot, port };
}

function cleanRepoDomainDbs(): void {
  // Walk up from this file to find the repo root (the dir containing .git).
  let cursor = __dirname;
  for (let depth = 0; depth < 10; depth++) {
    if (existsSync(resolve(cursor, ".git"))) break;
    cursor = resolve(cursor, "..");
  }
  const dbDir = resolve(cursor, "output", "db");
  if (!existsSync(dbDir)) return;
  for (const name of ["shopping"]) {
    for (const ext of ["sqlite", "sqlite-shm", "sqlite-wal"]) {
      const p = resolve(dbDir, `${name}.${ext}`);
      try {
        rmSync(p, { force: true });
      } catch {
        // best-effort
      }
    }
  }
}

export async function scenarioBoot(opts: ScenarioBootOpts = {}): Promise<ScenarioCtx> {
  const handle = await bootTestApp();
  const ear = new FakeEar({
    port: handle.port,
    deviceId: opts.deviceId,
    deviceName: opts.deviceName,
    capabilities: opts.capabilities ?? ["mic", "wake"],
  });
  return { ...handle, ear };
}

export async function scenarioTeardown(ctx: ScenarioCtx): Promise<void> {
  try {
    ctx.ear.disconnect();
  } catch {
    // best-effort
  }
  try {
    await ctx.app.close();
  } catch {
    // best-effort
  }
  rmSync(ctx.tmpRoot, { recursive: true, force: true });
}
