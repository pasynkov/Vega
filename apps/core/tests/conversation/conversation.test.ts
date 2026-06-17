import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Test, TestingModule } from "@nestjs/testing";
import { LoggerModule } from "nestjs-pino";
import { EnvConfigModule } from "../../src/config/env.module";
import { EnvConfig } from "../../src/config/env";
import { DbModule } from "../../src/db/db.module";
import { LlmModule } from "../../src/llm/llm.module";
import { AgentSystemModule } from "../../src/agents/agent-system.module";
import { SupervisorModule } from "../../src/agents/supervisor/supervisor.module";
import { MemoryModule } from "../../src/memory/memory.module";
import { ConversationModule } from "../../src/conversation/conversation.module";
import { ConversationService } from "../../src/conversation/conversation.service";

// Integration test: drives a real graph against a temp on-disk SQLite.
// Gated behind VEGA_RUN_LLM_INTEGRATION=1 because:
//   1. every turn costs a real Claude API call (ANTHROPIC_API_KEY must be set);
//   2. better-sqlite3 + swc transform stack inside vitest is flaky for the
//      full module graph; run via the dev:llm-harness for confidence instead.
// Skipped by default. The dev harness at apps/core/test/orchestrator.harness.ts
// is the primary end-to-end smoke for this change.
const RUN = process.env.VEGA_RUN_LLM_INTEGRATION === "1";
const describeIfKey = RUN ? describe : describe.skip;

describeIfKey("ConversationService integration", () => {
  let tmpDir: string;
  let dbPath: string;
  let modA: TestingModule | undefined;
  let modB: TestingModule | undefined;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "vega-conv-"));
    dbPath = join(tmpDir, "vega.sqlite");
    process.env.VEGA_DB_PATH = dbPath;
    process.env.RECORDINGS_DIR = tmpDir;
  });

  afterAll(async () => {
    await modA?.close();
    await modB?.close();
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.VEGA_DB_PATH;
    delete process.env.RECORDINGS_DIR;
  });

  async function bootstrap(): Promise<{ mod: TestingModule; conv: ConversationService }> {
    const mod = await Test.createTestingModule({
      imports: [
        LoggerModule.forRoot({ pinoHttp: { level: "warn" } }),
        EnvConfigModule,
        DbModule,
        LlmModule,
        AgentSystemModule,
        SupervisorModule,
        MemoryModule,
        ConversationModule,
      ],
    }).compile();
    await mod.init();
    const conv = mod.get(ConversationService);
    return { mod, conv };
  }

  it("remembers a fact within a turn and recalls it after restart", async () => {
    {
      const { mod, conv } = await bootstrap();
      modA = mod;
      const r1 = await conv.handleTurn("default", "запомни что я люблю эспрессо");
      expect(typeof r1).toBe("string");
      await mod.close();
      modA = undefined;
    }
    {
      const { mod, conv } = await bootstrap();
      modB = mod;
      const r2 = await conv.handleTurn("default", "что я обычно пью утром?");
      expect(typeof r2).toBe("string");
      // Loose check: reply should reference espresso/coffee semantics.
      expect(r2.toLowerCase()).toMatch(/эспрессо|кофе|espresso/);
      await mod.close();
      modB = undefined;
    }
  }, 120_000);
});
