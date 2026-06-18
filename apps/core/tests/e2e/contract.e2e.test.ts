import "reflect-metadata";
import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "vega-contract-e2e-"));
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
process.env.LOG_LEVEL = "fatal";

vi.mock("@langchain/anthropic", () => {
  let supervisorTurnIdx = 0;
  class StubChatAnthropic {
    constructor(_opts: unknown) {}
    bindTools(_tools: unknown, _opts?: unknown) {
      return {
        invoke: async (_messages: BaseMessage[]): Promise<AIMessage> => {
          supervisorTurnIdx += 1;
          if (supervisorTurnIdx === 1) {
            return new AIMessage({
              content: "",
              tool_calls: [
                {
                  id: "rt-1",
                  name: "route",
                  args: {
                    goto: "notes",
                    task: "save short note купить молоко",
                    speakText: "",
                  },
                },
              ],
            } as any);
          }
          return new AIMessage({
            content: "",
            tool_calls: [
              {
                id: "rt-2",
                name: "route",
                args: { goto: "__end__", speakText: "" },
              },
            ],
          } as any);
        },
      };
    }
    async invoke(_messages: BaseMessage[]): Promise<AIMessage> {
      return new AIMessage("ok");
    }
  }
  return { ChatAnthropic: StubChatAnthropic };
});

vi.mock("@langchain/langgraph/prebuilt", () => {
  const factory = vi.fn(({ tools }: { tools: any[] }) => ({
    invoke: vi.fn(
      async (
        state: { messages: BaseMessage[] },
        config?: { configurable?: Record<string, unknown> },
      ) => {
        const last = state.messages[state.messages.length - 1];
        const text =
          last instanceof HumanMessage && typeof last.content === "string"
            ? last.content
            : "";
        const findTool = (n: string) => tools.find((t) => t.name === n);
        const saveShort = findTool("save_short_note");
        if (saveShort && /купить молоко/.test(text)) {
          try {
            await saveShort.invoke({ text: "купить молоко" }, config);
          } catch {
            // best-effort; the contract test only cares that the
            // sub-agent returned a status the supervisor reads as "acted"
          }
          return {
            messages: [
              ...state.messages,
              new AIMessage(
                JSON.stringify({ status: "ok", summary: "saved short note" }),
              ),
            ],
          };
        }
        return {
          messages: [
            ...state.messages,
            new AIMessage(JSON.stringify({ status: "ok", summary: "noop" })),
          ],
        };
      },
    ),
  }));
  return { createReactAgent: factory };
});

import { Test } from "@nestjs/testing";
import type { INestApplicationContext } from "@nestjs/common";
import { DataSource } from "typeorm";

import { AppModule } from "../../src/app.module";
import { EarGateway } from "../../src/ear/ear.gateway";
import { DeepgramClient } from "../../src/deepgram/deepgram.client";
import { DbService } from "../../src/db/db.module";
import { AgentRegistry } from "../../src/agents/agent-registry.service";
import { FlushHookRegistry } from "../../src/ear-sessions/flush-hook-registry.service";
import { ConversationService } from "../../src/conversation/conversation.service";
import { Memory } from "../../src/memory/memory.entity";
import { ConversationSessionRow } from "../../src/conversation/session.entity";

class StubGateway {
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}

class StubDeepgramSession {
  send(): void {}
  close(): void {}
}

class StubDeepgram {
  open(): StubDeepgramSession {
    return new StubDeepgramSession();
  }
}

class StubDb {
  private _ds: DataSource | null = null;

  async onModuleInit(): Promise<void> {
    this._ds = new DataSource({
      type: "better-sqlite3",
      database: dbPath,
      entities: [Memory, ConversationSessionRow],
      synchronize: true,
    });
    await this._ds.initialize();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this._ds?.isInitialized) await this._ds.destroy();
  }

  get dataSource(): DataSource {
    if (!this._ds) throw new Error("StubDb accessed before onModuleInit");
    return this._ds;
  }
}

describe("Contract E2E: AppModule bootstrap, registry contract, short-note turn", () => {
  let app: INestApplicationContext;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EarGateway)
      .useValue(new StubGateway())
      .overrideProvider(DeepgramClient)
      .useValue(new StubDeepgram())
      .overrideProvider(DbService)
      .useValue(new StubDb())
      .compile();
    app = await moduleRef.init();
  }, 30_000);

  afterAll(async () => {
    if (app) await app.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("AgentRegistry contains the notes domain after AppModule boot", () => {
    const registry = app.get(AgentRegistry);
    const names = registry.listAll().map((s) => s.name);
    expect(names).toContain("notes");
  });

  it("FlushHookRegistry has a hook registered for notes", () => {
    const flushHooks = app.get(FlushHookRegistry);
    const hook = flushHooks.get("notes-session");
    expect(hook).toBeTruthy();
  });

  it("AgentRegistry contains the memory domain before the memory refactor", () => {
    const registry = app.get(AgentRegistry);
    const names = registry.listAll().map((s) => s.name);
    expect(names).toContain("memory");
  });

  it("ConversationService.handleTurn returns outcome=acted for a short-note request", async () => {
    const conversation = app.get(ConversationService);
    const result = await conversation.handleTurn(
      "contract-e2e-session-1",
      "запиши заметку купить молоко",
    );
    expect(result.outcome).toBe("acted");
  });
});
