import { Global, Module, OnApplicationBootstrap } from "@nestjs/common";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { EarModule } from "../ear/ear.module";
import { EarRegistry } from "../ear/ear.registry";
import { ConversationService } from "../conversation.service";
import type { TurnOutcome } from "../conversation.service";
import { SessionService } from "../ear/session/session.service";
import type { CoreEndReason, Cue, PlayCueMessage } from "@vega/ear-protocol";
import type { OwnedSessionController } from "../ear/session/session.service";
import { EarSessionRouter } from "./ear-session-router.service";
import { SessionAgentRunner } from "./session-agent-runner.service";
import { FlushHookRegistry } from "./flush-hook-registry.service";
import type { EarSessionHandle } from "./ear-session-handle";
import { isWakeWordFinal } from "../ear/wake/wake-vocabulary";

@Global()
@Module({
  imports: [EarModule],
  providers: [EarSessionRouter, SessionAgentRunner, FlushHookRegistry],
  exports: [EarSessionRouter, SessionAgentRunner, FlushHookRegistry],
})
export class EarSessionsModule implements OnApplicationBootstrap {
  constructor(
    @InjectPinoLogger(EarSessionsModule.name) private readonly logger: PinoLogger,
    private readonly router: EarSessionRouter,
    private readonly runner: SessionAgentRunner,
    private readonly sessions: SessionService,
    private readonly conversation: ConversationService,
    private readonly flushHooks: FlushHookRegistry,
    private readonly earRegistry: EarRegistry,
  ) {}

  private broadcastCue(cue: Cue): void {
    const msg: PlayCueMessage = { type: "play_cue", cue };
    for (const conn of this.earRegistry.list()) {
      try {
        conn.socket.send(JSON.stringify(msg));
      } catch (err) {
        this.logger.warn({ err, deviceId: conn.deviceId, cue }, "broadcastCue send failed");
      }
    }
  }

  private cueForOutcome(outcome: TurnOutcome): Cue | null {
    if (outcome === "acted") return null;
    if (outcome === "unknown") return "ack_unknown";
    return "ack_error";
  }

  onApplicationBootstrap(): void {
    this.sessions.attachRouter({
      ownerOf: (sid) => this.router.ownerOf(sid),
      bindOnSessionStart: (msg, deviceId) => this.router.bindOnSessionStart(msg, deviceId),
      release: (sid) => this.router.release(sid),
    });
    this.sessions.attachOwnerStarter((sessionId, ownerSpec): OwnedSessionController => {
      const ownership = this.router.ownershipOf(sessionId)!;
      const handle: EarSessionHandle = {
        sessionId,
        deviceId: ownership.deviceId,
        mode: ownership.mode,
        arrivedAt: Date.now(),
      };
      const initialPrompt = ownership.initialPrompt
        ?? `Открыта сессия захвата под доменом ${ownerSpec.name} (mode=${ownership.mode}). Жди финальные транскрипты и реагируй своими session-bound тулами.`;
      const hook = this.flushHooks.get(ownerSpec.name);
      const finalAppend = this.flushHooks.getFinalAppend(ownerSpec.name);
      const ctrl = this.runner.start({
        handle,
        spec: ownerSpec,
        initialPrompt,
        callbacks: {
          onRelease: (sid, reason, initiator) => this.onRunnerRelease(sid, reason, initiator),
          onFlush: hook
            ? async (sid, initiator) => { await hook(sid, initiator); }
            : undefined,
          onFinalAppend: finalAppend,
        },
      });
      return ctrl;
    });
    const firedFinals = new Map<string, Set<string>>();
    this.sessions.addTranscriptListener((sessionId, kind, text) => {
      if (kind !== "final") return;
      if (this.router.ownerOf(sessionId)) return;
      // Bug-4. Drop any final that arrived on a session the router just
      // tore down as part of an arm() transition. Those finals (e.g.
      // "Так,", "это у нас" landing between the LLM's open_continuous_session
      // decision and the actual session close) would otherwise fan out as
      // fresh orchestrator turns and the supervisor would route them to
      // notes again.
      if (this.router.wasTornDownByArm(sessionId)) {
        this.logger.info(
          { sessionId, finalText: text.slice(0, 80) },
          "dropped-in-transition",
        );
        return;
      }
      const trimmed = text.trim();
      if (trimmed.length === 0) return;
      let seen = firedFinals.get(sessionId);
      const isFirstFinalForSession = !seen;
      if (!seen) {
        seen = new Set();
        firedFinals.set(sessionId, seen);
      }
      if (seen.has(trimmed)) return;
      seen.add(trimmed);
      // Bug-1. The Ear keeps streaming audio after wake, so the wake
      // word itself (e.g. "Этна.") shows up as the very first final.
      // Drop it before it reaches the orchestrator.
      if (isFirstFinalForSession && isWakeWordFinal(trimmed)) {
        this.logger.info(
          { sessionId, finalText: trimmed },
          "Dropping wake-only first final",
        );
        return;
      }
      this.logger.info(
        { sessionId, finalText: trimmed.slice(0, 160) },
        "Per-final → orchestrator",
      );
      void (async () => {
        try {
          const res = await this.conversation.handleTurn(sessionId, trimmed);
          const cue = this.cueForOutcome(res.outcome);
          if (cue) this.broadcastCue(cue);
        } catch (err) {
          this.logger.warn({ err, sessionId }, "Per-final handleTurn threw");
          this.broadcastCue("ack_error");
        }
      })();
    });
    this.sessions.attachEndpointListener(async (sessionId, finalText) => {
      if (this.router.ownerOf(sessionId)) return;
      if (finalText.trim().length === 0) return;
      const seen = firedFinals.get(sessionId);
      firedFinals.delete(sessionId);
      // Per-final listener already fired everything we saw; only invoke as
      // a fallback if no final was ever processed for this session.
      if (seen && seen.size > 0) return;
      try {
        const res = await this.conversation.handleTurn(sessionId, finalText);
        const cue = this.cueForOutcome(res.outcome);
        if (cue) this.broadcastCue(cue);
      } catch (err) {
        this.logger.warn({ err, sessionId }, "Endpoint fallback handleTurn threw");
        this.broadcastCue("ack_error");
      }
    });
    this.logger.info({}, "EarSessionsModule wired router into session pipeline");
  }

  private async onRunnerRelease(
    sessionId: string,
    reason: "endpoint" | "timeout" | "stt_error" | "user",
    initiator: string,
  ): Promise<void> {
    const coreReason: CoreEndReason = reason;
    await this.sessions.terminateExternal(sessionId, coreReason, initiator);
  }
}
