import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";

// Mock the react-agent BEFORE importing the runner. The mock receives the
// real tools array from the runner and dispatches to them based on the
// incoming user text, simulating what a real LLM would do.
const mocks = vi.hoisted(() => {
  const lastUserText = (state: { messages: BaseMessage[] }): string => {
    for (let i = state.messages.length - 1; i >= 0; i--) {
      const m = state.messages[i];
      if (m instanceof HumanMessage && typeof m.content === "string") return m.content;
    }
    return "";
  };
  const factory = vi.fn(({ tools }: { tools: any[] }) => ({
    invoke: vi.fn(
      async (state: { messages: BaseMessage[] }, config?: { configurable?: Record<string, unknown> }) => {
        const text = lastUserText(state);
        const findTool = (name: string) => tools.find((t) => t.name === name);
        let toolName: string | null = null;
        let args: any = null;
        // Match only on user-spoken trigger phrases, NOT on the literal tool
        // name (which appears in the pause prompt as instruction).
        if (/конец заметки|это всё|готово|стоп|вот и всё|хватит/i.test(text)) {
          toolName = "finalize_note";
          args = { cleanText: state.messages.filter((m) => m instanceof HumanMessage).map((m) => (m as HumanMessage).content).join(" ") };
        } else if (/прервал сессию тапом/i.test(text)) {
          toolName = "finalize_note";
          args = { cleanText: "auto-finalized on tap" };
        } else if (/сессия прерывается/i.test(text)) {
          toolName = "discard_note";
          args = { reason: "user" };
        } else {
          // No trigger — return empty turn. Framework auto-appends each
          // final; the sub-agent only acts on triggers.
          return { messages: [...state.messages, new AIMessage("")] };
        }
        const tool = findTool(toolName!);
        if (!tool) throw new Error(`mock: tool ${toolName} not found`);
        const toolResult = await tool.invoke(args, config);
        return {
          messages: [
            ...state.messages,
            new ToolMessage({
              name: toolName!,
              tool_call_id: `tc-${state.messages.length}`,
              content: typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult),
            }),
            new AIMessage(`acted: ${toolName}`),
          ],
        };
      },
    ),
  }));
  return { factory };
});

vi.mock("@langchain/langgraph/prebuilt", () => ({
  createReactAgent: mocks.factory,
}));

import { EarSessionRouter } from "../../src/conversation/sessions/ear-session-router.service";
import { SessionAgentRunner } from "../../src/conversation/sessions/session-agent-runner.service";
import { FlushHookRegistry } from "../../src/conversation/sessions/flush-hook-registry.service";
import type { EarSessionHandle } from "../../src/conversation/sessions/ear-session-handle";
import { NotesStorageService } from "../../src/domains/notes/notes-storage.service";
import { buildNotesTools } from "../../src/domains/notes/notes.tools";
import { buildNotesSessionSpec } from "../../src/domains/notes/notes.agent";
import { SessionService } from "../../src/conversation/ear/session/session.service";
import type { AgentSpec } from "../../src/conversation/kernel/agent.types";

class StubLogger {
  info() {}
  warn() {}
  error() {}
  debug() {}
}

class StubDeepgramSession {
  send() {}
  close() {}
}

class StubDeepgram {
  open() { return new StubDeepgramSession(); }
}

class StubStore {
  async persist() {}
}

interface CapturedFrame {
  type: "json" | "session_end_msg" | "play_cue";
  raw: string;
  parsed: any;
}

function setupHarness(opts: { capMs: number; notesDir: string }) {
  const sentToEar: CapturedFrame[] = [];
  const send = vi.fn((raw: any) => {
    const str = typeof raw === "string" ? raw : raw.toString();
    try {
      const parsed = JSON.parse(str);
      sentToEar.push({ type: "json", raw: str, parsed });
    } catch {
      sentToEar.push({ type: "json", raw: str, parsed: null });
    }
  });
  const socket = { send } as any;
  const deviceId = "11111111-1111-1111-1111-111111111111";
  const conn = {
    socket,
    deviceId,
    deviceName: "stub",
    capabilities: [],
    activeSessionId: null,
    activeSessionShortId: null,
  };
  const registry = {
    list: () => [conn],
    setActiveSession: vi.fn(),
  } as any;

  const env = {
    deepgramLanguage: "ru",
    sessionTimeoutMs: 60_000,
    earSessionOwnerCapMs: opts.capMs,
    earSessionPauseMs: 50,
  } as any;

  const sessions = new SessionService(
    new StubLogger() as any,
    registry,
    env,
    new StubDeepgram() as any,
    new StubStore() as any,
  );

  const router = new EarSessionRouter(new StubLogger() as any, registry, sessions);
  const llm = { getModel: () => ({} as any) } as any;
  const runner = new SessionAgentRunner(new StubLogger() as any, llm, env);
  const flushHooks = new FlushHookRegistry();

  process.env.VEGA_NOTES_DIR = opts.notesDir;
  const storage = new NotesStorageService(new StubLogger() as any);
  const sessionSpecRef: { spec: AgentSpec | null } = { spec: null };
  const { sessionTools } = buildNotesTools(storage, sessions, router, sessionSpecRef);
  const sessionSpec = buildNotesSessionSpec(sessionTools);
  sessionSpecRef.spec = sessionSpec;

  // Wire the router and owner-starter into the session pipeline (mirrors EarSessionsModule.onApplicationBootstrap).
  sessions.attachRouter({
    ownerOf: (sid) => router.ownerOf(sid),
    bindOnSessionStart: (msg, did) => router.bindOnSessionStart(msg, did),
    release: (sid) => router.release(sid),
  });
  sessions.attachOwnerStarter((sessionId, ownerSpec) => {
    const ownership = router.ownershipOf(sessionId)!;
    const handle: EarSessionHandle = {
      sessionId,
      deviceId: ownership.deviceId,
      mode: ownership.mode,
      arrivedAt: Date.now(),
    };
    const hook = flushHooks.get(ownerSpec.name);
    const finalAppend = flushHooks.getFinalAppend(ownerSpec.name);
    return runner.start({
      handle,
      spec: ownerSpec,
      initialPrompt: "boot",
      callbacks: {
        onRelease: async (sid, reason, initiator) => {
          await sessions.terminateExternal(sid, reason as any, initiator);
        },
        onFlush: hook
          ? async (sid, initiator) => { await hook(sid, initiator); }
          : undefined,
        onFinalAppend: finalAppend,
      },
    });
  });
  flushHooks.registerFinalAppend(sessionSpec.name, (sid, text) => {
    storage.appendChunk(sid, text);
  });

  return { sessions, router, runner, storage, sessionSpec, conn, sentToEar };
}

const SESSION_ID = "22222222-2222-2222-2222-222222222222";

function startSession(sessions: SessionService, conn: any, mode: "regular" | "continuous" = "continuous") {
  sessions.start(conn as any, {
    type: "session_start",
    deviceId: conn.deviceId,
    sessionId: SESSION_ID,
    userId: null,
    sampleRate: 16000,
    codec: "linear16",
    mode,
  } as any);
}

async function flushAsync(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

describe("Tool-driven Ear session integration", () => {
  let tmpDir = "";

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "vega-notes-it-"));
    mocks.factory.mockClear();
  });
  afterEach(() => {
    delete process.env.VEGA_NOTES_DIR;
  });

  it("arm_capture → session_start → three finals → pause → finalize_note: writes note, ends with core:tool_release", async () => {
    vi.useFakeTimers();
    try {
      const { sessions, router, storage, sessionSpec, conn, sentToEar } = setupHarness({
        capMs: 60_000,
        notesDir: tmpDir,
      });

      const armRes = router.arm({ ownerSpec: sessionSpec, mode: "continuous" });
      expect(armRes.ok).toBe(true);
      expect(sentToEar.find((f) => f.parsed?.type === "arm_capture")).toBeTruthy();

      startSession(sessions, conn, "continuous");
      expect(sessions.isOwnedSession(SESSION_ID)).toBe(true);

      const internal: any = (sessions as any).bySessionId.get(SESSION_ID);
      (sessions as any).onFinal(internal, "первый абзац", 0.9);
      await vi.advanceTimersByTimeAsync(10);
      (sessions as any).onFinal(internal, "второй абзац", 0.9);
      await vi.advanceTimersByTimeAsync(10);
      expect(storage.hasInProgress(SESSION_ID)).toBe(true);

      // Trigger-phrase final — pause timer fires the sub-agent (mocked react-agent)
      // which the mock dispatcher rewrites into finalize_note → release.
      (sessions as any).onFinal(internal, "конец заметки", 0.9);
      await vi.advanceTimersByTimeAsync(120);
      for (let i = 0; i < 20; i++) await Promise.resolve();
      // microtasks may unblock more state; one more tick to settle
      await vi.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 20; i++) await Promise.resolve();

      const endMsg = sentToEar.find((f) => f.parsed?.type === "session_end");
      expect(endMsg).toBeTruthy();
      expect(endMsg!.parsed.reason).toBe("endpoint");

      expect(sessions.hasActiveSession(SESSION_ID)).toBe(false);
      expect(router.ownerOf(SESSION_ID)).toBeUndefined();

      const files = require("node:fs").readdirSync(tmpDir).filter((n: string) => n.endsWith(".md"));
      expect(files.length).toBeGreaterThan(0);
      const content = readFileSync(join(tmpDir, files[0]), "utf8");
      expect(content).toMatch(/первый абзац/);
      expect(content).toMatch(/второй абзац/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("no finalize_note: owner safety cap fires with core:owner_safety_cap and persists in-progress file", async () => {
    vi.useFakeTimers();
    try {
      const { sessions, router, storage, sessionSpec, conn, sentToEar } = setupHarness({
        capMs: 200,
        notesDir: tmpDir,
      });
      router.arm({ ownerSpec: sessionSpec, mode: "continuous" });
      startSession(sessions, conn, "continuous");

      const internal: any = (sessions as any).bySessionId.get(SESSION_ID);
      (sessions as any).onFinal(internal, "идея один", 0.9);
      await vi.advanceTimersByTimeAsync(0);
      await flushAsync();
      (sessions as any).onFinal(internal, "идея два", 0.9);
      await vi.advanceTimersByTimeAsync(0);
      await flushAsync();

      // Both finals appended; file exists on disk
      expect(storage.hasInProgress(SESSION_ID)).toBe(true);
      const filesMid = require("node:fs").readdirSync(tmpDir).filter((n: string) => n.endsWith(".md"));
      expect(filesMid.length).toBe(1);
      const contentMid = readFileSync(join(tmpDir, filesMid[0]), "utf8");
      expect(contentMid).toMatch(/идея один/);
      expect(contentMid).toMatch(/идея два/);

      // Drive past the safety cap
      await vi.advanceTimersByTimeAsync(250);
      await flushAsync(40);

      const endMsg = sentToEar.find((f) => f.parsed?.type === "session_end");
      expect(endMsg).toBeTruthy();
      expect(endMsg!.parsed.reason).toBe("timeout");

      expect(router.ownerOf(SESSION_ID)).toBeUndefined();
      // The in-progress file should still be on disk (flush hook leaves it).
      const filesAfter = require("node:fs").readdirSync(tmpDir).filter((n: string) => n.endsWith(".md"));
      expect(filesAfter.length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
