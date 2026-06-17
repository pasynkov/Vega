import { Injectable } from "@nestjs/common";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import {
  CoreEndReason,
  CoreSessionEndMessage,
  Cue,
  EarSessionEndMessage,
  FinalTranscriptMessage,
  PartialTranscriptMessage,
  PlayCueMessage,
  SessionMode,
  SessionModeChangeMessage,
  SessionStartMessage,
  sessionShortIdFromUuid,
} from "@vega/ear-protocol";
import { EarConnection, EarRegistry } from "../ear/ear.registry";
import { DeepgramClient, DeepgramSession } from "../deepgram/deepgram.client";
import { EnvConfig } from "../config/env";
import { RecordingStore, SessionRecord } from "../recording/recording-store";
import { SilenceDetector } from "./silence-detector";

type TranscriptListener = (sessionId: string, kind: "partial" | "final", text: string) => void;

interface InFlightSession extends SessionRecord {
  shortId: bigint;
  deepgram: DeepgramSession | null;
  timeout: NodeJS.Timeout;
  silenceTimer: NodeJS.Timeout | null;
  silenceCapMs: number;
  vad: SilenceDetector;
  vadEndpointSuppressed: boolean;
  mode: SessionMode;
  closed: boolean;
}

const CORE_SILENCE_CAP_MS = 5_000;
export const LONG_NOTE_SILENCE_CAP_MS = 60_000;

@Injectable()
export class SessionService {
  private readonly bySessionId = new Map<string, InFlightSession>();
  private readonly transcriptListeners = new Set<TranscriptListener>();

  constructor(
    @InjectPinoLogger(SessionService.name) private readonly logger: PinoLogger,
    private readonly registry: EarRegistry,
    private readonly env: EnvConfig,
    private readonly deepgram: DeepgramClient,
    private readonly store: RecordingStore,
  ) {}

  // Subscribe to transcript events on every active session. Used by
  // SessionWatcher to drive in-session LLM checks.
  addTranscriptListener(listener: TranscriptListener): () => void {
    this.transcriptListeners.add(listener);
    return () => this.transcriptListeners.delete(listener);
  }

  // Surfacing API for tools that need to mutate session state from inside
  // the orchestration graph.
  setSilenceCap(sessionId: string, ms: number): boolean {
    const session = this.bySessionId.get(sessionId);
    if (!session || session.closed) return false;
    session.silenceCapMs = ms;
    this.armSilenceTimer(session);
    this.logger.info({ sessionId, capMs: ms }, "Silence cap mutated");
    return true;
  }

  setMode(sessionId: string, mode: SessionMode): boolean {
    const session = this.bySessionId.get(sessionId);
    if (!session || session.closed) return false;
    if (session.mode === mode) return true;
    session.mode = mode;
    if (mode === "long_note") {
      session.vadEndpointSuppressed = true;
      session.silenceCapMs = LONG_NOTE_SILENCE_CAP_MS;
      this.armSilenceTimer(session);
    } else {
      session.vadEndpointSuppressed = false;
      session.silenceCapMs = CORE_SILENCE_CAP_MS;
      this.armSilenceTimer(session);
    }
    const msg: SessionModeChangeMessage = {
      type: "session_mode",
      sessionId,
      mode,
    };
    this.sendToEar(session, msg);
    this.logger.info({ sessionId, mode }, "Session mode changed");
    return true;
  }

  emitCue(sessionId: string, cue: Cue): boolean {
    const session = this.bySessionId.get(sessionId);
    if (!session || session.closed) return false;
    const msg: PlayCueMessage = { type: "play_cue", cue };
    this.sendToEar(session, msg);
    this.logger.debug({ sessionId, cue }, "Cue emitted");
    return true;
  }

  // Tells the connected Ear to open a fresh capture session under the given
  // mode without requiring a wake-word. Used by the notes domain's
  // enable_long_note_mode tool to arm the long-note session after the
  // original short utterance closed.
  armEarCapture(mode: SessionMode): boolean {
    const conn = this.registry.list()[0];
    if (!conn) {
      this.logger.warn({ mode }, "armEarCapture: no Ear connected");
      return false;
    }
    const msg = { type: "arm_capture" as const, mode };
    try {
      conn.socket.send(JSON.stringify(msg));
      this.logger.info({ mode, deviceId: conn.deviceId }, "arm_capture sent to Ear");
      return true;
    } catch (err) {
      this.logger.warn({ err, mode }, "armEarCapture: send failed");
      return false;
    }
  }

  async terminateExternal(
    sessionId: string,
    reason: CoreEndReason,
    initiator: string,
    detail?: string,
  ): Promise<boolean> {
    const session = this.bySessionId.get(sessionId);
    if (!session || session.closed) return false;
    await this.terminate(session, reason, initiator, detail);
    return true;
  }

  hasActiveSession(sessionId: string): boolean {
    const s = this.bySessionId.get(sessionId);
    return !!s && !s.closed;
  }

  getSessionMode(sessionId: string): SessionMode | undefined {
    return this.bySessionId.get(sessionId)?.mode;
  }

  getAccumulatedFinals(sessionId: string): string[] {
    return this.bySessionId.get(sessionId)?.finals.slice() ?? [];
  }

  start(connection: EarConnection, message: SessionStartMessage): void {
    const shortId = sessionShortIdFromUuid(message.sessionId);
    const startedAt = new Date().toISOString();
    const initialMode: SessionMode = message.mode ?? "regular";
    const initialCap = initialMode === "long_note" ? LONG_NOTE_SILENCE_CAP_MS : CORE_SILENCE_CAP_MS;

    const session: InFlightSession = {
      sessionId: message.sessionId,
      deviceId: connection.deviceId,
      deviceName: connection.deviceName,
      userId: message.userId,
      startedAt,
      endedAt: "",
      endReason: "endpoint",
      language: this.env.deepgramLanguage,
      transcriptConfidence: null,
      wakeScore: null,
      partials: [],
      finals: [],
      audioBuffers: [],
      sampleRate: message.sampleRate,
      shortId,
      deepgram: null,
      timeout: setTimeout(() => this.handleTimeout(message.sessionId), this.env.sessionTimeoutMs),
      silenceTimer: null,
      silenceCapMs: initialCap,
      vad: new SilenceDetector(undefined, (msg, meta) => {
        // Drop the silence-started / silence-broken flap entirely — they are
        // dozens-per-second and only useful when debugging the detector
        // itself. Keep calibration / speech-detected / endpoint at info.
        if (msg.includes("silence started") || msg.includes("silence broken")) return;
        this.logger.info({ sessionId: message.sessionId, ...meta }, msg);
      }),
      vadEndpointSuppressed: initialMode === "long_note",
      mode: initialMode,
      closed: false,
    };
    this.armSilenceTimer(session);

    const deepgram = this.deepgram.open(
      {
        onPartial: (text) => this.onPartial(session, text),
        onFinal: (text, confidence) => this.onFinal(session, text, confidence),
        onUtteranceEnd: () => this.onUtteranceEnd(session),
        onError: (detail) => this.onSttError(session, detail),
        onClose: () => {
          // Deepgram socket closed; SessionService is responsible for end-of-session,
          // not Deepgram's lifecycle event. No-op here.
        },
      },
      message.sampleRate,
    );
    session.deepgram = deepgram;

    this.bySessionId.set(session.sessionId, session);
    this.registry.setActiveSession(connection.deviceId, message.sessionId);

    this.logger.info(
      {
        sessionId: session.sessionId,
        deviceId: session.deviceId,
        sampleRate: message.sampleRate,
        codec: message.codec,
        timeoutMs: this.env.sessionTimeoutMs,
      },
      "Session started",
    );
  }

  forwardAudio(_connection: EarConnection, sessionShortId: bigint, payload: Uint8Array): void {
    let target: InFlightSession | undefined;
    for (const candidate of this.bySessionId.values()) {
      if (candidate.shortId === sessionShortId) {
        target = candidate;
        break;
      }
    }
    if (!target) {
      this.logger.debug({ sessionShortId: sessionShortId.toString() }, "Audio frame for unknown session, dropping");
      return;
    }
    target.audioBuffers.push(Buffer.from(payload));
    target.deepgram?.send(payload);

    const decision = target.vad.feed(payload);
    if (decision === "endpoint" && !target.vadEndpointSuppressed) {
      void this.terminate(target, "endpoint", "core:vad");
    }
  }

  async endFromEar(connection: EarConnection, message: EarSessionEndMessage): Promise<void> {
    const session = this.bySessionId.get(message.sessionId);
    if (!session) return;
    const reason: CoreEndReason = message.reason === "user" ? "user" : "timeout";
    await this.terminate(session, reason, `ear:${message.reason}`);
  }

  async handleDisconnect(connection: EarConnection): Promise<void> {
    for (const session of this.bySessionId.values()) {
      if (session.deviceId === connection.deviceId && !session.closed) {
        await this.terminate(session, "user", "core:ear_disconnect");
      }
    }
  }

  async shutdownAll(): Promise<void> {
    const live = Array.from(this.bySessionId.values()).filter((s) => !s.closed);
    if (live.length === 0) return;
    this.logger.info({ count: live.length }, "Terminating all in-flight sessions on shutdown");
    await Promise.all(live.map((s) => this.terminate(s, "user", "core:shutdown")));
  }

  private onPartial(session: InFlightSession, text: string): void {
    if (session.closed) return;
    session.partials.push(text);
    this.armSilenceTimer(session);
    const msg: PartialTranscriptMessage = {
      type: "partial_transcript",
      sessionId: session.sessionId,
      text,
      isFinal: false,
    };
    this.sendToEar(session, msg);
    this.notifyTranscriptListeners(session.sessionId, "partial", text);
  }

  private onFinal(session: InFlightSession, text: string, confidence: number | null): void {
    if (session.closed) return;
    session.finals.push(text);
    if (confidence !== null) session.transcriptConfidence = confidence;
    this.armSilenceTimer(session);
    this.notifyTranscriptListeners(session.sessionId, "final", text);
  }

  private notifyTranscriptListeners(sessionId: string, kind: "partial" | "final", text: string): void {
    for (const listener of this.transcriptListeners) {
      try {
        listener(sessionId, kind, text);
      } catch (err) {
        this.logger.warn({ err, kind }, "Transcript listener threw, continuing");
      }
    }
  }

  // Backend silence cap: if Deepgram has not produced any non-empty transcript
  // for `silenceCapMs`, Core considers the utterance finished and terminates
  // the session with reason=endpoint. This both stops the recording and tells
  // the Ear (via play_cue endpoint + session_end) to play Pop and idle.
  private armSilenceTimer(session: InFlightSession): void {
    if (session.silenceTimer) clearTimeout(session.silenceTimer);
    session.silenceTimer = setTimeout(() => {
      if (session.closed) return;
      this.logger.info(
        { sessionId: session.sessionId, capMs: session.silenceCapMs },
        "Core silence cap reached, ending session",
      );
      void this.terminate(session, "endpoint", "core:silence_cap");
    }, session.silenceCapMs);
  }

  private onUtteranceEnd(session: InFlightSession): void {
    if (session.closed) return;
    // Informational only: Deepgram thinks the utterance ended, but the Ear's
    // local VAD is the authoritative endpoint signal so the user can pace
    // dictation with pauses. We just record the event.
    this.logger.info({ sessionId: session.sessionId }, "Deepgram suggested utterance end, ignoring (Ear owns endpoint)");
  }

  private onSttError(session: InFlightSession, detail: string): void {
    if (session.closed) return;
    void this.terminate(session, "stt_error", "core:deepgram_error", detail);
  }

  private handleTimeout(sessionId: string): void {
    const session = this.bySessionId.get(sessionId);
    if (!session || session.closed) return;
    this.logger.warn({ sessionId }, "Session safety timeout, terminating");
    void this.terminate(session, "timeout", "core:safety_timeout");
  }

  private async terminate(
    session: InFlightSession,
    reason: CoreEndReason,
    initiator: string,
    detail?: string,
  ): Promise<void> {
    if (session.closed) return;
    session.closed = true;
    clearTimeout(session.timeout);
    if (session.silenceTimer) {
      clearTimeout(session.silenceTimer);
      session.silenceTimer = null;
    }
    this.logger.info(
      {
        sessionId: session.sessionId,
        initiator,
        reason,
        detail,
        audioChunks: session.audioBuffers.length,
        finals: session.finals.length,
        partials: session.partials.length,
      },
      `Session ended by ${initiator} (reason=${reason})`,
    );
    session.deepgram?.close();

    if (reason === "endpoint") {
      const cue: PlayCueMessage = { type: "play_cue", cue: "endpoint" };
      this.sendToEar(session, cue);
      const finalText = session.finals.join(" ").trim() || session.partials.join(" ").trim();
      const finalMsg: FinalTranscriptMessage = {
        type: "final_transcript",
        sessionId: session.sessionId,
        text: finalText,
      };
      this.sendToEar(session, finalMsg);
    }

    session.endedAt = new Date().toISOString();
    session.endReason = reason;

    const endMsg: CoreSessionEndMessage = {
      type: "session_end",
      sessionId: session.sessionId,
      reason,
      ...(detail ? { detail } : {}),
    };
    this.sendToEar(session, endMsg);

    this.registry.setActiveSession(session.deviceId, null);
    this.bySessionId.delete(session.sessionId);

    try {
      await this.store.persist(session);
    } catch (err) {
      this.logger.error({ err, sessionId: session.sessionId }, "Failed to persist recording");
    }
  }

  private sendToEar(session: InFlightSession, message: unknown): void {
    const conn = this.findConnection(session.deviceId);
    if (!conn) return;
    try {
      conn.socket.send(JSON.stringify(message));
    } catch (err) {
      this.logger.warn({ err }, "Failed to send to Ear");
    }
  }

  private findConnection(deviceId: string): EarConnection | undefined {
    return this.registry.list().find((c) => c.deviceId === deviceId);
  }
}
