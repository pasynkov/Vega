import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionWatcher } from "../../src/session-watcher/session-watcher.service";

class StubLogger {
  info() {}
  warn() {}
  error() {}
  debug() {}
}

interface Stubs {
  watcher: SessionWatcher;
  haiku: any;
  conv: any;
  sessions: any;
  feed: (sessionId: string, kind: "partial" | "final", text: string) => Promise<void>;
}

function makeWatcher(opts: { intentLongNote: boolean; stopAfter: number; sessionMode?: "regular" | "long_note" }): Stubs {
  let listener: any = null;
  const mode = opts.sessionMode ?? "regular";
  const sessions = {
    hasActiveSession: () => true,
    getSessionMode: () => mode,
    addTranscriptListener: (l: any) => {
      listener = l;
      return () => {};
    },
  };
  const conv = { handleTurn: vi.fn(async () => "ok") };
  let stopCalls = 0;
  const haiku = {
    classifyIntent: vi.fn(async () => ({ longNote: opts.intentLongNote, reason: "stub" })),
    classifyStop: vi.fn(async () => {
      stopCalls += 1;
      return { stop: stopCalls >= opts.stopAfter, cleanText: "clean", reason: "stub" };
    }),
  };
  const watcher = new SessionWatcher(new StubLogger() as any, sessions as any, conv as any, haiku as any);
  watcher.onApplicationBootstrap();
  const feed = async (sessionId: string, kind: "partial" | "final", text: string) => {
    listener(sessionId, kind, text);
    // Flush microtasks. The watcher dispatches via void this.onFinal(...);
    // we wait until the per-session inFlight chain settles before returning.
    for (let i = 0; i < 25; i++) {
      const state = (watcher as any).perSession.get(sessionId);
      if (state?.inFlight) {
        await state.inFlight.catch(() => undefined);
      } else {
        await Promise.resolve();
      }
    }
  };
  return { watcher, haiku, conv, sessions, feed };
}

describe("SessionWatcher", () => {
  it("intent check fires once per session on the first final", async () => {
    const { haiku, conv, feed } = makeWatcher({ intentLongNote: false, stopAfter: 99 });
    await feed("sid-1", "final", "запиши заметку");
    await feed("sid-1", "final", "ещё текст");
    expect(haiku.classifyIntent).toHaveBeenCalledTimes(1);
    // intent = not long → no graph dispatch
    expect(conv.handleTurn).not.toHaveBeenCalled();
  });

  it("on long-note intent, invokes graph with enable instruction", async () => {
    const { haiku, conv, feed } = makeWatcher({ intentLongNote: true, stopAfter: 99 });
    await feed("sid-2", "final", "запиши длинную заметку про идею");
    expect(haiku.classifyIntent).toHaveBeenCalledTimes(1);
    expect(conv.handleTurn).toHaveBeenCalledTimes(1);
    const arg = conv.handleTurn.mock.calls[0][1] as string;
    expect(arg).toMatch(/long-note режим|long.note/);
  });

  it("long_note session: skips intent, runs stop-check on every final, ends on stop=true", async () => {
    const { haiku, conv, feed } = makeWatcher({ intentLongNote: false, stopAfter: 3, sessionMode: "long_note" });
    await feed("sid-3", "final", "вот моя идея");
    await feed("sid-3", "final", "и ещё кое-что");
    await feed("sid-3", "final", "конец заметки");
    // Long-note sessions never invoke the intent classifier.
    expect(haiku.classifyIntent).not.toHaveBeenCalled();
    expect(haiku.classifyStop).toHaveBeenCalledTimes(3);
    // Only one graph dispatch — the stop one (at the 2nd stop call which returns stop:true).
    expect(conv.handleTurn).toHaveBeenCalledTimes(1);
    expect(conv.handleTurn.mock.calls[0][1] as string).toContain("Очищенный текст");
  });

  it("duplicate consecutive finals are deduped", async () => {
    const { haiku, feed } = makeWatcher({ intentLongNote: false, stopAfter: 99 });
    await feed("sid-4", "final", "то же самое");
    await feed("sid-4", "final", "то же самое");
    expect(haiku.classifyIntent).toHaveBeenCalledTimes(1);
  });
});
