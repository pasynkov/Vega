import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { buildNotesTools } from "../../src/domains/notes/notes.tools";
import { ToolUsedOutsideSessionError } from "../../src/conversation/sessions/ear-session.errors";
import type { AgentSpec, AgentTool } from "../../src/conversation/kernel/agent.types";

function makeStubs() {
  const storage = {
    startNamed: vi.fn(() => ({ path: "/tmp/in-progress.md" })),
    appendChunk: vi.fn(() => ({ path: "/tmp/in-progress.md" })),
    finalizeInProgress: vi.fn(() => ({ path: "/tmp/done.md" })),
    discardInProgress: vi.fn(() => ({ path: null })),
    hasInProgress: vi.fn(() => false),
  };
  const sessions = { getDeviceIdForSession: vi.fn(() => undefined) } as any;
  const overlay = { set: vi.fn(() => true), cancelTtl: vi.fn() } as any;
  const router = {
    arm: vi.fn(() => ({ ok: true, mode: "continuous" as const })),
    openAskSession: vi.fn(async () => ({ kind: "answer" as const, text: "имя" })),
  } as any;
  const earRegistry = { list: () => [{ deviceId: "dev-1" }] } as any;
  const sessionSpecRef: { spec: AgentSpec | null } = { spec: { name: "notes-session" } as AgentSpec };
  const { supervisorTools, sessionTools } = buildNotesTools(
    storage as any,
    sessions,
    router,
    overlay,
    earRegistry,
    sessionSpecRef,
  );
  return { supervisorTools, sessionTools, storage, overlay, router };
}

function findTool(tools: AgentTool[], name: string): AgentTool {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not found`);
  return tool;
}

async function invokeWithoutEarSession(tool: AgentTool, input: unknown): Promise<unknown> {
  // Calling invoke with only the input means `configurable.ear_session` is
  // absent, which is the supervisor / post-endpoint flow.
  return (tool as unknown as { invoke: (input: unknown) => Promise<unknown> }).invoke(input);
}

describe("Session-bound notes tools require ear session ctx", () => {
  it("finalize_note throws ToolUsedOutsideSessionError when ctx lacks earSession", async () => {
    const { sessionTools } = makeStubs();
    const tool = findTool(sessionTools, "finalize_note");
    await expect(invokeWithoutEarSession(tool, { cleanText: "done" })).rejects.toBeInstanceOf(
      ToolUsedOutsideSessionError,
    );
  });

  it("discard_note throws ToolUsedOutsideSessionError when ctx lacks earSession", async () => {
    const { sessionTools } = makeStubs();
    const tool = findTool(sessionTools, "discard_note");
    await expect(invokeWithoutEarSession(tool, { reason: "user" })).rejects.toBeInstanceOf(
      ToolUsedOutsideSessionError,
    );
  });

  it("open_continuous_session works without ear session ctx and forwards name", async () => {
    const { supervisorTools, router } = makeStubs();
    const tool = findTool(supervisorTools, "open_continuous_session");
    const out = await invokeWithoutEarSession(tool, { name: "идея проекта", intent: "дневник" });
    expect(typeof out === "string").toBe(true);
    expect(router.arm).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "continuous",
        artifactName: "идея проекта",
        intent: "дневник",
      }),
    );
  });

  it("supervisor bundle exposes ask_user as a global tool", () => {
    const { supervisorTools } = makeStubs();
    expect(supervisorTools.find((t) => t.name === "ask_user")).toBeTruthy();
  });
});
