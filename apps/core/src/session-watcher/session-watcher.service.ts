import { Injectable, OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { SessionService } from "../session/session.service";
import { ConversationService } from "../conversation/conversation.service";
import { HaikuClassifierService } from "./haiku-classifier.service";

// Per-session in-session state. We track the first-final intent dispatch
// flag, the last final text we acted on (for stop-check idempotency), and a
// promise serialising graph invocations for the session.
interface WatcherState {
  intentChecked: boolean;
  isLongNote: boolean;
  finalsSeen: string[];
  inFlight: Promise<unknown> | null;
  lastStopCheckedAt: number;
}

@Injectable()
export class SessionWatcher implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly perSession = new Map<string, WatcherState>();
  private unsubscribe: (() => void) | null = null;

  constructor(
    @InjectPinoLogger(SessionWatcher.name) private readonly logger: PinoLogger,
    private readonly sessions: SessionService,
    private readonly conversation: ConversationService,
    private readonly haiku: HaikuClassifierService,
  ) {}

  onApplicationBootstrap(): void {
    this.unsubscribe = this.sessions.addTranscriptListener((sessionId, kind, text) => {
      if (kind === "final") {
        void this.onFinal(sessionId, text);
      }
    });
    this.logger.info({}, "SessionWatcher subscribed to transcripts");
  }

  onApplicationShutdown(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private getState(sessionId: string): WatcherState {
    let s = this.perSession.get(sessionId);
    if (!s) {
      s = { intentChecked: false, isLongNote: false, finalsSeen: [], inFlight: null, lastStopCheckedAt: 0 };
      this.perSession.set(sessionId, s);
    }
    return s;
  }

  private async onFinal(sessionId: string, text: string): Promise<void> {
    if (!this.sessions.hasActiveSession(sessionId)) {
      this.perSession.delete(sessionId);
      return;
    }
    const state = this.getState(sessionId);
    if (state.finalsSeen.length > 0 && state.finalsSeen[state.finalsSeen.length - 1] === text) {
      return; // duplicate
    }
    state.finalsSeen.push(text);

    // Serialise per session.
    if (state.inFlight) {
      await state.inFlight.catch(() => undefined);
    }

    // If the session was started under long_note mode (Core armed it), skip
    // the intent check entirely and treat every final as a stop-check input.
    const mode = this.sessions.getSessionMode(sessionId);
    if (!state.intentChecked) {
      state.intentChecked = true;
      if (mode === "long_note") {
        state.isLongNote = true;
        state.inFlight = this.handleStopCheck(sessionId, state)
          .catch((err) => this.logger.warn({ err, sessionId }, "Stop dispatch failed"));
      } else {
        state.inFlight = this.handleIntentCheck(sessionId, text, state)
          .catch((err) => this.logger.warn({ err, sessionId }, "Intent dispatch failed"));
      }
      await state.inFlight;
      state.inFlight = null;
    } else if (state.isLongNote) {
      state.inFlight = this.handleStopCheck(sessionId, state)
        .catch((err) => this.logger.warn({ err, sessionId }, "Stop dispatch failed"));
      await state.inFlight;
      state.inFlight = null;
    }
  }

  private async handleIntentCheck(sessionId: string, firstFinal: string, _state: WatcherState): Promise<void> {
    const intent = await this.haiku.classifyIntent(firstFinal);
    if (!intent.longNote) {
      // Short-note path: defer to the post-endpoint flow. Nothing to do mid-session.
      return;
    }
    // Long-note intent detected on a regular session. The current session
    // will close normally via Ear VAD; the supervisor's notes domain will
    // arm a fresh long-note capture on the Ear so the user can keep talking.
    await this.invokeGraph(
      sessionId,
      `Пользователь явно собирается надиктовать ДЛИННУЮ заметку. Текущая короткая сессия уже завершается. Вызови notes domain → enable_long_note_mode, чтобы открыть новую долгую сессию.`,
    );
  }

  private async handleStopCheck(sessionId: string, state: WatcherState): Promise<void> {
    const rolling = state.finalsSeen.join(" ").trim();
    if (rolling.length === 0) return;
    const stop = await this.haiku.classifyStop(rolling);
    if (!stop.stop) return;
    const clean = stop.cleanText.trim().length > 0 ? stop.cleanText : rolling;
    await this.invokeGraph(
      sessionId,
      `Пользователь завершил длинную заметку. Сохрани её через notes domain. Очищенный текст:\n\n${clean}`,
    );
  }

  private async invokeGraph(sessionId: string, instruction: string): Promise<void> {
    if (!this.sessions.hasActiveSession(sessionId)) {
      this.logger.debug({ sessionId }, "Graph invocation skipped: session no longer active");
      return;
    }
    try {
      const reply = await this.conversation.handleTurn(sessionId, instruction);
      this.logger.info({ sessionId, replyChars: reply.length }, "In-session graph turn completed");
    } catch (err) {
      this.logger.warn({ err, sessionId }, "In-session graph turn threw");
    }
  }
}
