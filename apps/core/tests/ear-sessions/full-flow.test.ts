import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// We mock createReactAgent at the prebuilt entry point. Each "sub-agent
// invocation" of notes dispatches based on the task text into ONE tool from
// the bundle, then returns a synthesized ToolMessage + AIMessage carrying
// the JSON status the supervisor expects.
const mocks = vi.hoisted(() => {
  const tracker: { tools: any[] | null } = { tools: null };
  const factory = vi.fn(({ tools }: { tools: any[] }) => {
    tracker.tools = tools;
    return {
      invoke: vi.fn(
        async (
          state: { messages: BaseMessage[] },
          config?: { configurable?: Record<string, unknown> },
        ) => {
          const last = state.messages[state.messages.length - 1];
          const text = last instanceof HumanMessage && typeof last.content === "string" ? last.content : "";
          const findTool = (n: string) => tools.find((t) => t.name === n);
          let toolName: string | null = null;
          let args: any = null;

          const hasFinalize = tools.some((t) => t.name === "finalize_note");
          if (hasFinalize) {
            // Session-bound notes sub-agent. Framework auto-appends each
            // final, so the sub-agent only decides finalize / discard /
            // continue. We only finalize on explicit user trigger phrases
            // or terminal prompts.
            if (/конец заметки|это всё|готово|стоп|вот и всё|прервал сессию тапом/i.test(text)) {
              toolName = "finalize_note";
              args = { cleanText: text };
            } else if (/шум|сессия прерывается/i.test(text)) {
              toolName = "discard_note";
              args = { reason: "user" };
            } else {
              return { messages: [...state.messages, new AIMessage("")] };
            }
          } else if (
            /open_continuous_session|большую заметку|длинную заметку|continuous/i.test(text)
          ) {
            toolName = "open_continuous_session";
            args = { intent: "long note" };
          } else if (/save_short_note|short note|купить молоко/i.test(text)) {
            toolName = "save_short_note";
            args = { text: "купить молоко" };
          } else {
            return {
              messages: [...state.messages, new AIMessage("noop")],
            };
          }
          const tool = findTool(toolName);
          if (!tool) {
            return {
              messages: [
                ...state.messages,
                new AIMessage(JSON.stringify({ status: "error", summary: `tool ${toolName} not found` })),
              ],
            };
          }
          let toolResult: string;
          try {
            toolResult = (await tool.invoke(args, config)) as string;
          } catch (err) {
            return {
              messages: [
                ...state.messages,
                new AIMessage(
                  JSON.stringify({ status: "error", summary: err instanceof Error ? err.message : String(err) }),
                ),
              ],
            };
          }
          return {
            messages: [
              ...state.messages,
              new ToolMessage({
                name: toolName,
                tool_call_id: `tc-${state.messages.length}`,
                content: toolResult,
              }),
              new AIMessage(JSON.stringify({ status: "ok", summary: `${toolName} done` })),
            ],
          };
        },
      ),
    };
  });
  return { factory, tracker };
});

vi.mock("@langchain/langgraph/prebuilt", () => ({
  createReactAgent: mocks.factory,
}));

import { GraphFactory } from "../../src/conversation/kernel/graph.factory";
import { AgentRegistry } from "../../src/conversation/kernel/agent-registry.service";
import { PreSupervisorNode } from "../../src/conversation/kernel/supervisor/pre-supervisor.node";
import { SupervisorNode } from "../../src/conversation/kernel/supervisor/supervisor.node";
import { EarSessionRouter } from "../../src/conversation/sessions/ear-session-router.service";
import { SessionAgentRunner } from "../../src/conversation/sessions/session-agent-runner.service";
import { FlushHookRegistry } from "../../src/conversation/sessions/flush-hook-registry.service";
import { NotesStorageService } from "../../src/domains/notes/notes-storage.service";
import { buildNotesTools } from "../../src/domains/notes/notes.tools";
import { buildNotesSupervisorSpec, buildNotesSessionSpec } from "../../src/domains/notes/notes.agent";
import type { AgentSpec } from "../../src/conversation/kernel/agent.types";
import { SessionService } from "../../src/conversation/ear/session/session.service";
import type { EarSessionHandle } from "../../src/conversation/sessions/ear-session-handle";

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

const DEVICE_ID = "11111111-1111-1111-1111-111111111111";
const SESSION_ID = "22222222-2222-2222-2222-222222222222";

function setupHarness(opts: {
  routeReply: { goto: string; task?: string; speakText?: string };
  notesDir: string;
}) {
  const sentToEar: any[] = [];
  const emit = vi.fn((event: string, payload: unknown) => {
    sentToEar.push({ type: event, ...(payload as object) });
  });
  const conn = {
    socket: { emit } as any,
    deviceId: DEVICE_ID,
    deviceName: "stub",
    capabilities: [],
    activeSessionId: null,
  };
  const earRegistry = {
    list: () => [conn],
    setActiveSession: vi.fn(),
    emitTo: vi.fn((_deviceId: string, event: string, payload: unknown) => {
      emit(event, payload);
      return true;
    }),
  } as any;

  const env = {
    deepgramLanguage: "ru",
    sessionTimeoutMs: 60_000,
    earSessionOwnerCapMs: 90_000,
  } as any;

  const overlayStub = { set: () => true, cancelTtl: () => {}, bindDevice: () => {}, unbindDevice: () => {} } as any;
  const sessions = new SessionService(
    new StubLogger() as any,
    earRegistry,
    env,
    new StubDeepgram() as any,
    new StubStore() as any,
    overlayStub,
  );

  // Build the route tool reply as the AIMessage with tool_calls. The
  // supervisor reads tool_calls[0].args, parses goto/task, and routes.
  const routeReplyMessage = new AIMessage({
    content: "",
    tool_calls: [{ id: "route-1", name: "route", args: opts.routeReply as any }],
  } as any);
  // Subsequent supervisor turn (after notes returns) must end the turn so we
  // don't loop. Provide a second reply with goto=__end__.
  const endReplyMessage = new AIMessage({
    content: "",
    tool_calls: [{ id: "route-2", name: "route", args: { goto: "__end__", speakText: "" } as any }],
  } as any);

  let supervisorCallIdx = 0;
  const supervisorInvoke = vi.fn(async () => {
    supervisorCallIdx += 1;
    if (supervisorCallIdx === 1) return routeReplyMessage;
    return endReplyMessage;
  });
  const llm = {
    getModel: () => ({
      bindTools: () => ({ invoke: supervisorInvoke }),
    }),
  } as any;

  const registry = new AgentRegistry(new StubLogger() as any);

  process.env.VEGA_NOTES_DIR = opts.notesDir;
  const storage = new NotesStorageService(new StubLogger() as any);
  const sessionSpecRef: { spec: AgentSpec | null } = { spec: null };
  const router = new EarSessionRouter(new StubLogger() as any, earRegistry, sessions, overlayStub);
  const runner = new SessionAgentRunner(new StubLogger() as any, llm, env);
  const flushHooks = new FlushHookRegistry();

  const { supervisorTools, sessionTools } = buildNotesTools(storage, sessions, router, overlayStub, sessionSpecRef);
  const notesSupervisorSpec = buildNotesSupervisorSpec(supervisorTools);
  const notesSessionSpec = buildNotesSessionSpec(sessionTools);
  sessionSpecRef.spec = notesSessionSpec;
  registry.register(notesSupervisorSpec);

  // Wire the router and owner-starter into the session pipeline.
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
        onFlush: hook ? async (sid, initiator) => { await hook(sid, initiator); } : undefined,
        onFinalAppend: finalAppend,
      },
    });
  });
  flushHooks.registerFinalAppend(notesSessionSpec.name, (sid, text) => {
    storage.appendChunk(sid, text);
  });

  const preSupervisor = new PreSupervisorNode(new StubLogger() as any);
  const supervisor = new SupervisorNode(new StubLogger() as any, registry, llm);
  const checkpointer = SqliteSaver.fromConnString(":memory:");
  const graphFactory = new GraphFactory(
    new StubLogger() as any,
    registry,
    llm,
    preSupervisor,
    supervisor,
    checkpointer as any,
  );

  return { graphFactory, sessions, router, runner, storage, sentToEar, notesSessionSpec, conn };
}

describe("End-to-end orchestrator → notes → arm_capture", () => {
  let tmpDir = "";

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "vega-e2e-"));
    mocks.factory.mockClear();
  });
  afterEach(() => {
    delete process.env.VEGA_NOTES_DIR;
  });

  it("\"запиши большую заметку\" → supervisor routes to notes → open_continuous_session → arm_capture sent", async () => {
    const { graphFactory, router, sentToEar } = setupHarness({
      routeReply: { goto: "notes", task: "Открой новую continuous сессию для дикта large note" },
      notesDir: tmpDir,
    });

    const graph = graphFactory.build();
    const result = (await graph.invoke(
      { messages: [new HumanMessage("запиши большую заметку")], sessionId: "thread-1" },
      { configurable: { thread_id: "thread-1" }, recursionLimit: 8 },
    )) as { messages: BaseMessage[] };

    expect(result.messages.length).toBeGreaterThan(1);

    const armCapture = sentToEar.find((m) => m?.type === "arm_capture");
    expect(armCapture).toBeTruthy();
    expect(armCapture.mode).toBe("continuous");

    // Once arm fires, router holds a reservation keyed by deviceId. The
    // next session_start with mode=continuous binds the reservation to the
    // notes-session spec.
    const ownership = router.bindOnSessionStart(
      {
        type: "session_start",
        deviceId: "11111111-1111-1111-1111-111111111111",
        sessionId: "33333333-3333-3333-3333-333333333333",
        userId: null,
        sampleRate: 16000,
        codec: "linear16",
        mode: "continuous",
      } as any,
      "11111111-1111-1111-1111-111111111111",
    );
    expect(ownership).toBeDefined();
    expect(ownership!.ownerSpec.name).toBe("notes-session");
  });

  it("\"запиши заметку купить молоко\" → save_short_note path writes a file (no arm)", async () => {
    const { graphFactory, sentToEar } = setupHarness({
      routeReply: { goto: "notes", task: "save short note купить молоко" },
      notesDir: tmpDir,
    });

    const graph = graphFactory.build();
    await graph.invoke(
      { messages: [new HumanMessage("запиши заметку купить молоко")], sessionId: "thread-2" },
      { configurable: { thread_id: "thread-2" }, recursionLimit: 8 },
    );

    // No arm should have fired on a short-note path.
    expect(sentToEar.find((m) => m?.type === "arm_capture")).toBeUndefined();

    const files = require("node:fs").readdirSync(tmpDir).filter((n: string) => n.endsWith(".md"));
    expect(files.length).toBe(1);
    const content = readFileSync(join(tmpDir, files[0]), "utf8");
    expect(content).toMatch(/купить молоко/);
  });

  it("after open_continuous_session, simulated session_start binds ownership and finals route to the runner", async () => {
    const { graphFactory, router, sessions, conn } = setupHarness({
      routeReply: { goto: "notes", task: "open continuous session for open_continuous_session" },
      notesDir: tmpDir,
    });

    const graph = graphFactory.build();
    await graph.invoke(
      { messages: [new HumanMessage("запиши большую заметку про что-то")], sessionId: "thread-3" },
      { configurable: { thread_id: "thread-3" }, recursionLimit: 8 },
    );

    // Now the Ear opens a new continuous session in response to arm_capture.
    sessions.start(conn as any, {
      type: "session_start",
      deviceId: DEVICE_ID,
      sessionId: SESSION_ID,
      userId: null,
      sampleRate: 16000,
      codec: "linear16",
      mode: "continuous",
    } as any);

    expect(sessions.isOwnedSession(SESSION_ID)).toBe(true);
    expect(router.ownerOf(SESSION_ID)?.name).toBe("notes-session");

    // Push a final and confirm the in-progress note file grew.
    const internal: any = (sessions as any).bySessionId.get(SESSION_ID);
    (sessions as any).onFinal(internal, "первый абзац идеи", 0.9);
    for (let i = 0; i < 20; i++) await Promise.resolve();

    const files = require("node:fs").readdirSync(tmpDir).filter((n: string) => n.endsWith(".md"));
    expect(files.length).toBe(1);
    const content = readFileSync(join(tmpDir, files[0]), "utf8");
    expect(content).toMatch(/первый абзац идеи/);
  });
});
