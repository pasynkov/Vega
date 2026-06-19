import { Global, Module, OnApplicationBootstrap } from "@nestjs/common";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { EarModule } from "../ear/ear.module";
import { EarRegistry } from "../ear/ear.registry";
import { ConversationService } from "../conversation.service";
import type { TurnOutcome } from "../conversation.service";
import { SessionService } from "../ear/session/session.service";
import type { CoreEndReason, OverlaySound } from "@vega/ear-protocol";
import type { OwnedSessionController } from "../ear/session/session.service";
import { EarSessionRouter } from "./ear-session-router.service";
import { SessionAgentRunner } from "./session-agent-runner.service";
import { FlushHookRegistry } from "./flush-hook-registry.service";
import type { EarSessionHandle } from "./ear-session-handle";
import { isWakeWordFinal } from "../ear/wake/wake-vocabulary";
import { OverlayService } from "../overlay/overlay.service";

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
    private readonly overlay: OverlayService,
  ) {}

  // Paint the outcome of an orchestrator turn on the overlay of the
  // device that owns the session. ack_unknown / ack_error map to an
  // error overlay with the matching cue sound and a short ttl so the
  // overlay fades back to idle; ack/acted is a no-op (a domain handler
  // will paint its own success state via update_overlay).
  private paintOutcome(sessionId: string, outcome: TurnOutcome): void {
    const deviceId = this.deviceIdForSession(sessionId) ?? this.fallbackDeviceId();
    if (!deviceId) return;
    if (outcome === "acted") {
      // Domain may have already painted a finishing success/error with
      // ttl through update_overlay. Only fire the safety paint when the
      // overlay is STILL stuck on `thinking` from terminate(endpoint)
      // — i.e. the domain emitted no finishing state of its own. Don't
      // flash success again over an already-completed domain ttl→idle.
      if (this.overlay.hasTtlTimer?.(deviceId)) return;
      const currentKind = this.overlay.getKind?.(deviceId);
      if (currentKind !== "thinking") return;
      this.overlay.set(
        deviceId,
        { kind: "success", sound: "ack_done" },
        { ttl: 1200 },
        "outcome_acted_safety",
      );
      return;
    }
    const sound = this.soundForOutcome(outcome);
    if (!sound) return;
    const hint = outcome === "unknown" ? "Не понял запрос" : "Что-то пошло не так";
    const ttl = outcome === "unknown" ? 1500 : 2500;
    this.overlay.set(deviceId, { kind: "error", hint, sound }, { ttl }, `outcome_${outcome}`);
  }

  private fallbackDeviceId(): string | undefined {
    return this.earRegistry.list()[0]?.deviceId;
  }

  private soundForOutcome(outcome: TurnOutcome): OverlaySound | null {
    if (outcome === "acted") return null;
    if (outcome === "unknown") return "ack_unknown";
    return "ack_error";
  }

  private deviceIdForSession(sessionId: string): string | undefined {
    const direct = this.sessions.getDeviceIdForSession(sessionId);
    if (direct) return direct;
    return this.earRegistry.list().find((c) => c.activeSessionId === sessionId)?.deviceId;
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
          this.paintOutcome(sessionId, res.outcome);
        } catch (err) {
          this.logger.warn({ err, sessionId }, "Per-final handleTurn threw");
          const deviceId = this.deviceIdForSession(sessionId) ?? this.fallbackDeviceId();
          if (deviceId) this.overlay.set(deviceId, { kind: "error", hint: "Сбой", sound: "ack_error" }, { ttl: 2500 }, "outcome_caught_error");
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
        this.paintOutcome(sessionId, res.outcome);
      } catch (err) {
        this.logger.warn({ err, sessionId }, "Endpoint fallback handleTurn threw");
        const deviceId = this.deviceIdForSession(sessionId);
        if (deviceId) this.overlay.set(deviceId, { kind: "error", sound: "ack_error" });
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
    // Domain handlers (finalize_note / discard_note) already painted a
    // finishing overlay (success/error with ttl) before requesting the
    // runner to release. Pass silentOverlay so terminate does not
    // overwrite it with thinking-on-endpoint.
    await this.sessions.terminateExternal(
      sessionId,
      coreReason,
      initiator,
      undefined,
      { silentOverlay: true },
    );
  }
}
