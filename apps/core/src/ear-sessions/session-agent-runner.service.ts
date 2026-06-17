import { Injectable } from "@nestjs/common";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import type { AgentSpec } from "../agents/agent.types";
import { LlmService } from "../llm/llm.module";
import { EnvConfig } from "../config/env";
import {
  EarSessionHandle,
  isSessionReleaseResult,
  SessionToolResult,
} from "./ear-session-handle";

type ReleaseReason = SessionToolResult["reason"];

export interface RunnerSessionCallbacks {
  onRelease: (
    sessionId: string,
    reason: ReleaseReason,
    initiator: string,
  ) => Promise<void> | void;
  onFlush?: (sessionId: string, initiator: string) => Promise<void> | void;
  onFinalAppend?: (sessionId: string, text: string) => void | Promise<void>;
}

export interface SessionRunnerController {
  pushFinal(text: string): void;
  signalEnd(reason: "user" | "endpoint" | "timeout" | "stt_error"): void;
  forceTimeout(): void;
  dispose(): void;
}

interface RunnerState {
  handle: EarSessionHandle;
  spec: AgentSpec;
  callbacks: RunnerSessionCallbacks;
  agent: ReturnType<typeof createReactAgent>;
  rolling: string[];
  pauseTimer: NodeJS.Timeout | null;
  safetyTimer: NodeJS.Timeout | null;
  currentAbort: AbortController | null;
  inflight: Promise<void> | null;
  released: boolean;
  pauseMs: number;
  terminalQueued: { reason: "user" | "endpoint" | "timeout" | "stt_error"; note: string } | null;
}

@Injectable()
export class SessionAgentRunner {
  constructor(
    @InjectPinoLogger(SessionAgentRunner.name) private readonly logger: PinoLogger,
    private readonly llm: LlmService,
    private readonly env: EnvConfig,
  ) {}

  start(args: {
    handle: EarSessionHandle;
    spec: AgentSpec;
    initialPrompt: string;
    callbacks: RunnerSessionCallbacks;
  }): SessionRunnerController {
    const agent = createReactAgent({
      llm: this.llm.getModel({ model: args.spec.model }),
      tools: args.spec.tools as any,
      prompt: args.spec.systemPrompt,
    });

    const state: RunnerState = {
      handle: args.handle,
      spec: args.spec,
      callbacks: args.callbacks,
      agent,
      rolling: [],
      pauseTimer: null,
      safetyTimer: null,
      currentAbort: null,
      inflight: null,
      released: false,
      pauseMs: this.env.earSessionPauseMs,
      terminalQueued: null,
    };

    state.safetyTimer = setTimeout(() => this.onSafetyCap(state), this.env.earSessionOwnerCapMs);

    this.logger.info(
      {
        sessionId: state.handle.sessionId,
        owner: args.spec.name,
        ownerCapMs: this.env.earSessionOwnerCapMs,
        pauseMs: state.pauseMs,
      },
      "Session agent runner started",
    );

    return {
      pushFinal: (text) => this.onPushFinal(state, text),
      signalEnd: (reason) => this.onSignalEnd(state, reason),
      forceTimeout: () => this.onSafetyCap(state),
      dispose: () => this.dispose(state),
    };
  }

  private onPushFinal(state: RunnerState, text: string): void {
    if (state.released) return;
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    state.rolling.push(trimmed);
    if (state.callbacks.onFinalAppend) {
      try {
        const r = state.callbacks.onFinalAppend(state.handle.sessionId, trimmed);
        if (r && typeof (r as Promise<void>).then === "function") {
          (r as Promise<void>).catch((err) =>
            this.logger.warn({ err, sessionId: state.handle.sessionId }, "onFinalAppend threw"),
          );
        }
      } catch (err) {
        this.logger.warn({ err, sessionId: state.handle.sessionId }, "onFinalAppend threw sync");
      }
    }
    this.cancelInflight(state);
    this.schedulePauseCheck(state);
  }

  private cancelInflight(state: RunnerState): void {
    if (state.currentAbort) {
      this.logger.debug(
        { sessionId: state.handle.sessionId },
        "Cancelling in-flight finalize check (new final arrived)",
      );
      state.currentAbort.abort();
      state.currentAbort = null;
    }
    if (state.pauseTimer) {
      clearTimeout(state.pauseTimer);
      state.pauseTimer = null;
    }
  }

  private schedulePauseCheck(state: RunnerState): void {
    if (state.pauseTimer) clearTimeout(state.pauseTimer);
    state.pauseTimer = setTimeout(() => {
      state.pauseTimer = null;
      void this.runFinalizeCheck(state, this.buildPausePrompt(state));
    }, state.pauseMs);
  }

  private buildPausePrompt(state: RunnerState): string {
    const rolling = state.rolling.join(" ").trim();
    return [
      `Накопленный текст заметки (свежий final последний):`,
      rolling,
      ``,
      `Прошло ${state.pauseMs}мс тишины. Реши: пользователь закончил?`,
      `- Если ДА (явная фраза-триггер или мысль завершена) → вызови finalize_note(cleanText) с очищенным текстом БЕЗ триггерных фраз.`,
      `- Если НЕТ (продолжает диктовать, незаконченная мысль) → ничего не делай, верни пустой ход без tool-вызовов.`,
    ].join("\n");
  }

  private buildTerminalPrompt(reason: "user" | "endpoint" | "timeout" | "stt_error", rolling: string): string {
    if (reason === "user") {
      return [
        `Пользователь оборвал сессию тапом. Это твой ПОСЛЕДНИЙ ход.`,
        `Накопленный текст:`,
        rolling,
        ``,
        `Вызови finalize_note(cleanText) или discard_note(reason="user"). Без текста.`,
      ].join("\n");
    }
    return [
      `Сессия прерывается (reason=${reason}). Это твой последний ход.`,
      `Накопленный текст:`,
      rolling,
      ``,
      `Вызови finalize_note(cleanText) если есть что сохранить, иначе discard_note(reason).`,
    ].join("\n");
  }

  private async runFinalizeCheck(state: RunnerState, prompt: string): Promise<void> {
    if (state.released) return;
    const abort = new AbortController();
    state.currentAbort = abort;
    const turn = (async () => {
      try {
        const result = (await state.agent.invoke(
          { messages: [new HumanMessage(prompt)] },
          {
            configurable: {
              thread_id: `ear-session:${state.handle.sessionId}`,
              ear_session: state.handle,
            },
            signal: abort.signal,
          },
        )) as { messages: BaseMessage[] };
        if (abort.signal.aborted || state.released) return;
        const release = findReleaseInLastMessages(result.messages);
        if (release) {
          await this.releaseFromTool(state, release.reason);
        }
      } catch (err) {
        if (abort.signal.aborted) {
          this.logger.debug(
            { sessionId: state.handle.sessionId },
            "Finalize check aborted by new final",
          );
          return;
        }
        this.logger.error(
          { err, sessionId: state.handle.sessionId, owner: state.spec.name },
          "Session sub-agent invocation threw",
        );
        await this.releaseWithError(state);
      } finally {
        if (state.currentAbort === abort) state.currentAbort = null;
      }
    })();
    state.inflight = turn;
    await turn;
    if (state.inflight === turn) state.inflight = null;
  }

  private async releaseFromTool(state: RunnerState, reason: ReleaseReason): Promise<void> {
    if (state.released) return;
    state.released = true;
    this.clearTimers(state);
    await safeFireRelease(state, reason, "core:tool_release", this.logger);
  }

  private async releaseWithError(state: RunnerState): Promise<void> {
    if (state.released) return;
    state.released = true;
    this.clearTimers(state);
    await safeFireFlush(state, "core:tool_error", this.logger);
    await safeFireRelease(state, "stt_error", "core:tool_error", this.logger);
  }

  private onSafetyCap(state: RunnerState): void {
    if (state.released) return;
    state.released = true;
    this.clearTimers(state);
    this.logger.warn(
      { sessionId: state.handle.sessionId, owner: state.spec.name },
      "Owner safety cap fired",
    );
    void (async () => {
      await safeFireFlush(state, "core:owner_safety_cap", this.logger);
      await safeFireRelease(state, "timeout", "core:owner_safety_cap", this.logger);
    })();
  }

  private onSignalEnd(state: RunnerState, reason: "user" | "endpoint" | "timeout" | "stt_error"): void {
    if (state.released) return;
    this.cancelInflight(state);
    const rolling = state.rolling.join(" ").trim();
    void this.runTerminalCheck(state, reason, rolling);
  }

  private async runTerminalCheck(
    state: RunnerState,
    reason: "user" | "endpoint" | "timeout" | "stt_error",
    rolling: string,
  ): Promise<void> {
    if (state.released) return;
    try {
      const abort = new AbortController();
      state.currentAbort = abort;
      const result = (await state.agent.invoke(
        { messages: [new HumanMessage(this.buildTerminalPrompt(reason, rolling))] },
        {
          configurable: {
            thread_id: `ear-session:${state.handle.sessionId}`,
            ear_session: state.handle,
          },
          signal: abort.signal,
        },
      )) as { messages: BaseMessage[] };
      if (state.released) return;
      const release = findReleaseInLastMessages(result.messages);
      if (release) {
        await this.releaseFromTool(state, release.reason);
        return;
      }
      // Sub-agent did not call a release tool on the terminal turn — force release.
      if (state.released) return;
      state.released = true;
      this.clearTimers(state);
      await safeFireFlush(state, `core:forced_${reason}`, this.logger);
      await safeFireRelease(state, reason, `core:forced_${reason}`, this.logger);
    } catch (err) {
      this.logger.warn(
        { err, sessionId: state.handle.sessionId, reason },
        "Terminal check threw, force-releasing",
      );
      if (!state.released) {
        state.released = true;
        this.clearTimers(state);
        await safeFireFlush(state, `core:forced_${reason}`, this.logger);
        await safeFireRelease(state, reason, `core:forced_${reason}`, this.logger);
      }
    } finally {
      state.currentAbort = null;
    }
  }

  private dispose(state: RunnerState): void {
    state.released = true;
    this.clearTimers(state);
    if (state.currentAbort) {
      state.currentAbort.abort();
      state.currentAbort = null;
    }
  }

  private clearTimers(state: RunnerState): void {
    if (state.safetyTimer) {
      clearTimeout(state.safetyTimer);
      state.safetyTimer = null;
    }
    if (state.pauseTimer) {
      clearTimeout(state.pauseTimer);
      state.pauseTimer = null;
    }
  }
}

function findReleaseInLastMessages(messages: BaseMessage[]): SessionToolResult | null {
  for (let i = messages.length - 1; i >= Math.max(0, messages.length - 8); i--) {
    const m = messages[i] as BaseMessage & { name?: string };
    const c = (m as any).content;
    if (m instanceof AIMessage) continue;
    if (typeof c === "string") {
      const parsed = tryParseRelease(c);
      if (parsed) return parsed;
    } else if (Array.isArray(c)) {
      for (const part of c) {
        const text = typeof part === "string" ? part : ((part as { text?: string }).text ?? "");
        const parsed = tryParseRelease(text);
        if (parsed) return parsed;
      }
    }
  }
  return null;
}

function tryParseRelease(raw: string): SessionToolResult | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (isSessionReleaseResult(parsed)) return parsed;
  } catch {
    // ignore
  }
  return null;
}

async function safeFireFlush(state: RunnerState, initiator: string, logger: PinoLogger): Promise<void> {
  if (!state.callbacks.onFlush) return;
  try {
    await state.callbacks.onFlush(state.handle.sessionId, initiator);
  } catch (err) {
    logger.warn({ err, sessionId: state.handle.sessionId, initiator }, "Flush hook threw");
  }
}

async function safeFireRelease(
  state: RunnerState,
  reason: ReleaseReason,
  initiator: string,
  logger: PinoLogger,
): Promise<void> {
  try {
    await state.callbacks.onRelease(state.handle.sessionId, reason, initiator);
  } catch (err) {
    logger.warn({ err, sessionId: state.handle.sessionId, initiator }, "Release hook threw");
  }
}
