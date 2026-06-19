import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { buildNotesTools } from "../../src/domains/notes/notes.tools";
import type { AgentSpec, AgentTool } from "../../src/conversation/kernel/agent.types";

function makeStubs(opts: {
  askOutcome:
    | { kind: "answer"; text: string }
    | { kind: "timeout" }
    | { kind: "cancelled" };
}) {
  const storage = {
    startNamed: vi.fn(() => ({ path: "/tmp/in-progress.md" })),
    appendChunk: vi.fn(() => ({ path: "/tmp/in-progress.md" })),
    finalizeInProgress: vi.fn(() => ({ path: "/tmp/done.md" })),
    discardInProgress: vi.fn(() => ({ path: null })),
    hasInProgress: vi.fn(() => false),
  };
  const sessions = { getDeviceIdForSession: vi.fn(() => "dev-1") } as any;
  const overlay = { set: vi.fn(() => true), cancelTtl: vi.fn() } as any;
  const router = {
    arm: vi.fn(() => ({ ok: true, mode: "continuous" as const, artifactName: undefined })),
    openAskSession: vi.fn(async () => opts.askOutcome),
  } as any;
  const earRegistry = { list: () => [{ deviceId: "dev-1" }] } as any;
  const sessionSpecRef: { spec: AgentSpec | null } = { spec: { name: "notes-session" } as AgentSpec };
  const { supervisorTools } = buildNotesTools(
    storage as any,
    sessions,
    router,
    overlay,
    earRegistry,
    sessionSpecRef,
  );
  return { supervisorTools, storage, overlay, router };
}

function findTool(tools: AgentTool[], name: string): AgentTool {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} missing`);
  return t;
}

async function invoke(tool: AgentTool, input: unknown): Promise<unknown> {
  return (tool as unknown as { invoke: (input: unknown, cfg?: unknown) => Promise<unknown> }).invoke(
    input,
    { configurable: { thread_id: "thread-1" } },
  );
}

describe("notes flow integration (via tools)", () => {
  it("ask_user returns an answer → open_continuous_session can carry it", async () => {
    const { supervisorTools, router } = makeStubs({
      askOutcome: { kind: "answer", text: "идея проекта" },
    });
    const askUser = findTool(supervisorTools, "ask_user");
    const askRaw = (await invoke(askUser, { question: "Как назвать заметку?" })) as string;
    const ask = JSON.parse(askRaw) as { ok: boolean; answer?: string };
    expect(ask.ok).toBe(true);
    expect(ask.answer).toBe("идея проекта");

    const open = findTool(supervisorTools, "open_continuous_session");
    const openRaw = (await invoke(open, { name: ask.answer })) as string;
    const openOut = JSON.parse(openRaw) as { artifactName?: string };
    expect(openOut.artifactName).toBe("идея проекта");
    expect(router.arm).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "continuous", artifactName: "идея проекта" }),
    );
  });

  it("ask_user timeout → caller can avoid opening continuous", async () => {
    const { supervisorTools, router } = makeStubs({ askOutcome: { kind: "timeout" } });
    const askUser = findTool(supervisorTools, "ask_user");
    const raw = (await invoke(askUser, { question: "Как назвать заметку?" })) as string;
    const out = JSON.parse(raw) as { ok: boolean; reason?: string };
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("timeout");
    expect(router.arm).not.toHaveBeenCalled();
  });

  it("ask_user cancelled → caller can avoid opening continuous", async () => {
    const { supervisorTools, router } = makeStubs({ askOutcome: { kind: "cancelled" } });
    const askUser = findTool(supervisorTools, "ask_user");
    const raw = (await invoke(askUser, { question: "Как назвать заметку?" })) as string;
    const out = JSON.parse(raw) as { ok: boolean; reason?: string };
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("cancelled");
    expect(router.arm).not.toHaveBeenCalled();
  });
});
