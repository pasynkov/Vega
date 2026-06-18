import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { buildNotesTools } from "../../src/domains/notes/notes.tools";
import { ToolUsedOutsideSessionError } from "../../src/conversation/sessions/ear-session.errors";
import type { AgentSpec, AgentTool } from "../../src/conversation/kernel/agent.types";

function makeStubs() {
  const storage = {
    saveNote: vi.fn(() => ({ path: "/tmp/short.md" })),
    appendChunk: vi.fn(() => ({ path: "/tmp/in-progress.md" })),
    finalizeInProgress: vi.fn(() => ({ path: "/tmp/done.md" })),
    discardInProgress: vi.fn(() => ({ path: null })),
    hasInProgress: vi.fn(() => false),
  };
  const sessions = { emitCue: vi.fn() } as any;
  const router = { arm: vi.fn(() => ({ ok: true, mode: "long_note" as const })) } as any;
  const sessionSpecRef: { spec: AgentSpec | null } = { spec: { name: "notes-session" } as AgentSpec };
  const { supervisorTools, sessionTools } = buildNotesTools(storage as any, sessions, router, sessionSpecRef);
  return { supervisorTools, sessionTools, storage };
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

  it("save_short_note works without ear session ctx (supervisor-callable)", async () => {
    const { supervisorTools, storage } = makeStubs();
    const tool = findTool(supervisorTools, "save_short_note");
    await invokeWithoutEarSession(tool, { text: "milk and bread" });
    expect(storage.saveNote).toHaveBeenCalledWith("milk and bread");
  });

  it("begin_dictation works without ear session ctx (it OPENS one)", async () => {
    const { supervisorTools } = makeStubs();
    const tool = findTool(supervisorTools, "begin_dictation");
    const out = await invokeWithoutEarSession(tool, { intent: "long note" });
    expect(typeof out === "string").toBe(true);
  });
});
