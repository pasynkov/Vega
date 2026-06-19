import { Injectable } from "@nestjs/common";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import type { ArmCaptureMessage, SessionMode, SessionStartMessage } from "@vega/ear-protocol";
import { EarRegistry } from "../ear/ear.registry";
import { SessionService } from "../ear/session/session.service";
import type { AgentSpec } from "../kernel/agent.types";
import { OverlayService } from "../overlay/overlay.service";
import { EarSessionReservationConflictError } from "./ear-session.errors";

const RESERVATION_TTL_MS = 10_000;
const ARM_TORNDOWN_TTL_MS = 5_000;
const ASK_DEFAULT_CAPTURE_MS = 8_000;
const ASK_SAFETY_PADDING_MS = 2_000;

export type AskSessionOutcome =
  | { kind: "answer"; text: string }
  | { kind: "timeout" }
  | { kind: "cancelled" };

interface OwnerReservation {
  kind: "owner";
  deviceId: string;
  ownerSpec: AgentSpec;
  mode: SessionMode;
  initialPrompt: string | undefined;
  artifactName: string | undefined;
  intent: string | undefined;
  createdAt: number;
  expiresAt: number;
}

interface AskReservation {
  kind: "ask";
  deviceId: string;
  mode: "ask";
  captureMs: number;
  createdAt: number;
  expiresAt: number;
}

type Reservation = OwnerReservation | AskReservation;

interface OwnerActiveOwnership {
  kind: "owner";
  sessionId: string;
  deviceId: string;
  ownerSpec: AgentSpec;
  mode: SessionMode;
  initialPrompt: string | undefined;
  artifactName: string | undefined;
  intent: string | undefined;
}

interface AskActiveOwnership {
  kind: "ask";
  sessionId: string;
  deviceId: string;
  mode: "ask";
  captureMs: number;
}

export type ActiveOwnership = OwnerActiveOwnership | AskActiveOwnership;

export interface ArmOptions {
  ownerSpec: AgentSpec;
  mode: SessionMode;
  deviceId?: string;
  initialPrompt?: string;
  artifactName?: string;
  intent?: string;
}

export interface ArmResult {
  ok: boolean;
  reason?: string;
  deviceId?: string;
  mode?: SessionMode;
  artifactName?: string;
}

interface AskHandle {
  deviceId: string;
  captureMs: number;
  safetyTimer: NodeJS.Timeout;
  resolve: (outcome: AskSessionOutcome) => void;
  settled: boolean;
}

@Injectable()
export class EarSessionRouter {
  private readonly reservations = new Map<string, Reservation>();
  private readonly owned = new Map<string, ActiveOwnership>();
  // sessionId -> expiresAt. Populated by arm() when it terminates a
  // device's active short session before dispatching arm_capture. The
  // EarSessionsModule per-final listener consults this set to drop finals
  // that were enqueued on the about-to-be-torn-down session in the
  // narrow window between the LLM's arm decision and the actual close.
  private readonly armTornDown = new Map<string, number>();
  // deviceId -> in-flight ask handle (one per device; the device has only
  // one mic). Keyed by deviceId until session_start binds it to a sessionId.
  private readonly askByDevice = new Map<string, AskHandle>();
  private readonly askBySession = new Map<string, AskHandle>();

  constructor(
    @InjectPinoLogger(EarSessionRouter.name) private readonly logger: PinoLogger,
    private readonly registry: EarRegistry,
    private readonly sessions: SessionService,
    private readonly overlay: OverlayService,
  ) {}

  arm(opts: ArmOptions): ArmResult {
    const conn = opts.deviceId
      ? this.registry.list().find((c) => c.deviceId === opts.deviceId)
      : this.registry.list()[0];
    if (!conn) {
      this.logger.warn({ mode: opts.mode }, "arm: no Ear connected");
      return { ok: false, reason: "no-ear-connection" };
    }
    this.purgeExpired();
    const existing = this.reservations.get(conn.deviceId);
    if (existing) {
      throw new EarSessionReservationConflictError(conn.deviceId);
    }

    // Bug-2 fix. If the device already has an active short session in
    // flight (the wake-driven session that captured the original
    // utterance), the Ear will silently ignore arm_capture. Terminate
    // first so the Ear sees `session_end` → idle → `arm_capture`.
    const activeSessionId = this.sessions.getActiveSessionIdForDevice(conn.deviceId);
    if (activeSessionId) {
      this.armTornDown.set(activeSessionId, Date.now() + ARM_TORNDOWN_TTL_MS);
      // Pass silentOverlay so terminate does not paint thinking-with-Pop
      // over the soon-to-arrive arm_capture flow; the next overlay update
      // below is the canonical bridge state.
      void this.sessions
        .terminateExternal(
          activeSessionId,
          "endpoint",
          "core:tool_release",
          undefined,
          { silentOverlay: true },
        )
        .catch((err) =>
          this.logger.warn(
            { err, sessionId: activeSessionId },
            "arm: terminating active session before arm_capture failed",
          ),
        );
      this.logger.info(
        { deviceId: conn.deviceId, terminatedSessionId: activeSessionId, newMode: opts.mode },
        "Arm terminated active session before dispatch",
      );
    }

    const now = Date.now();
    this.reservations.set(conn.deviceId, {
      kind: "owner",
      deviceId: conn.deviceId,
      ownerSpec: opts.ownerSpec,
      mode: opts.mode,
      initialPrompt: opts.initialPrompt,
      artifactName: opts.artifactName,
      intent: opts.intent,
      createdAt: now,
      expiresAt: now + RESERVATION_TTL_MS,
    });
    const msg: ArmCaptureMessage = { mode: opts.mode };
    const dispatched = this.registry.emitTo(conn.deviceId, "arm_capture", msg);
    if (!dispatched) {
      this.reservations.delete(conn.deviceId);
      this.logger.warn({ mode: opts.mode }, "arm: socket emit failed");
      return { ok: false, reason: "send-failed" };
    }
    // Bridge overlay between the closed short session and the upcoming
    // session. For `continuous` mode the user is about to dictate a long
    // payload — paint `capturing` so the orb icon (waveform) reads as
    // "записываю длинно" rather than the wake-listening `mic`. For
    // continuous notes the caption shows the artifact (note) name so the
    // user sees which note is being written. For `immersive` mode flip
    // straight to the `immersive` visual so the kind switches before
    // sessionBegin paints the dynamic list-view content.
    const bridgeKind =
      opts.mode === "immersive"
        ? "immersive"
        : opts.mode === "continuous"
          ? "capturing"
          : "listening";
    this.overlay.set(
      conn.deviceId,
      opts.mode === "continuous" && opts.artifactName
        ? { kind: bridgeKind, caption: opts.artifactName.slice(0, 240) }
        : { kind: bridgeKind },
      {},
      `arm_bridge:${opts.ownerSpec.name}:${opts.mode}`,
    );
    this.logger.info(
      {
        deviceId: conn.deviceId,
        mode: opts.mode,
        owner: opts.ownerSpec.name,
        artifactName: opts.artifactName,
      },
      "Ear session reserved via arm_capture",
    );
    return {
      ok: true,
      deviceId: conn.deviceId,
      mode: opts.mode,
      artifactName: opts.artifactName,
    };
  }

  // Open an ask-mode capture session. Returns a Promise that resolves when
  // the user answers, times out, or cancels. The caller (ask_user tool)
  // is the single consumer; the handle map is keyed by deviceId until
  // session_start binds the sessionId.
  openAskSession(args: {
    deviceId?: string;
    captureMs?: number;
  }): Promise<AskSessionOutcome> {
    const captureMs = Math.max(1, args.captureMs ?? ASK_DEFAULT_CAPTURE_MS);
    const conn = args.deviceId
      ? this.registry.list().find((c) => c.deviceId === args.deviceId)
      : this.registry.list()[0];
    if (!conn) {
      this.logger.warn({}, "openAskSession: no Ear connected");
      return Promise.resolve({ kind: "cancelled" });
    }
    this.purgeExpired();
    if (this.reservations.has(conn.deviceId)) {
      throw new EarSessionReservationConflictError(conn.deviceId);
    }
    const activeSessionId = this.sessions.getActiveSessionIdForDevice(conn.deviceId);
    if (activeSessionId) {
      this.armTornDown.set(activeSessionId, Date.now() + ARM_TORNDOWN_TTL_MS);
      void this.sessions
        .terminateExternal(
          activeSessionId,
          "endpoint",
          "core:tool_release",
          undefined,
          { silentOverlay: true },
        )
        .catch((err) =>
          this.logger.warn(
            { err, sessionId: activeSessionId },
            "openAskSession: terminating active session before arm_capture failed",
          ),
        );
    }
    const now = Date.now();
    this.reservations.set(conn.deviceId, {
      kind: "ask",
      deviceId: conn.deviceId,
      mode: "ask",
      captureMs,
      createdAt: now,
      expiresAt: now + RESERVATION_TTL_MS,
    });

    return new Promise<AskSessionOutcome>((resolve) => {
      const handle: AskHandle = {
        deviceId: conn.deviceId,
        captureMs,
        settled: false,
        resolve: (outcome) => {
          if (handle.settled) return;
          handle.settled = true;
          clearTimeout(handle.safetyTimer);
          this.askByDevice.delete(handle.deviceId);
          resolve(outcome);
        },
        // Backup deferred resolver — if Ear never reports session_end and
        // Core never receives a final, this fires so the awaiting tool
        // does not hang forever.
        safetyTimer: setTimeout(() => {
          if (handle.settled) return;
          this.logger.warn(
            { deviceId: handle.deviceId, captureMs },
            "openAskSession: backup safety timer fired",
          );
          handle.settled = true;
          this.askByDevice.delete(handle.deviceId);
          this.reservations.delete(handle.deviceId);
          resolve({ kind: "timeout" });
        }, captureMs + ASK_SAFETY_PADDING_MS),
      };
      this.askByDevice.set(conn.deviceId, handle);

      const msg: ArmCaptureMessage = { mode: "ask", captureMs };
      const dispatched = this.registry.emitTo(conn.deviceId, "arm_capture", msg);
      if (!dispatched) {
        this.reservations.delete(conn.deviceId);
        this.logger.warn({}, "openAskSession: socket emit failed");
        handle.resolve({ kind: "cancelled" });
        return;
      }
      this.logger.info(
        { deviceId: conn.deviceId, captureMs },
        "Ask session reserved via arm_capture",
      );
    });
  }

  // Bug-4 helper. True if `sessionId` was just torn down as part of an
  // arm() transition; per-final listeners use this to skip dispatching
  // those finals into the orchestrator.
  wasTornDownByArm(sessionId: string): boolean {
    const expiresAt = this.armTornDown.get(sessionId);
    if (!expiresAt) return false;
    if (expiresAt <= Date.now()) {
      this.armTornDown.delete(sessionId);
      return false;
    }
    return true;
  }

  bindOnSessionStart(message: SessionStartMessage, deviceId: string): ActiveOwnership | undefined {
    this.purgeExpired();
    const reservation = this.reservations.get(deviceId);
    if (!reservation) return undefined;
    const incomingMode: SessionMode = message.mode ?? "regular";
    if (incomingMode !== reservation.mode) return undefined;
    this.reservations.delete(deviceId);
    if (reservation.kind === "ask") {
      const ownership: AskActiveOwnership = {
        kind: "ask",
        sessionId: message.sessionId,
        deviceId,
        mode: "ask",
        captureMs: reservation.captureMs,
      };
      this.owned.set(message.sessionId, ownership);
      const handle = this.askByDevice.get(deviceId);
      if (handle) {
        this.askBySession.set(message.sessionId, handle);
      }
      this.logger.info(
        { sessionId: message.sessionId, deviceId, mode: "ask" },
        "Ask session bound",
      );
      return ownership;
    }
    const ownership: OwnerActiveOwnership = {
      kind: "owner",
      sessionId: message.sessionId,
      deviceId,
      ownerSpec: reservation.ownerSpec,
      mode: reservation.mode,
      initialPrompt: reservation.initialPrompt,
      artifactName: reservation.artifactName,
      intent: reservation.intent,
    };
    this.owned.set(message.sessionId, ownership);
    this.logger.info(
      {
        sessionId: message.sessionId,
        deviceId,
        owner: reservation.ownerSpec.name,
        artifactName: reservation.artifactName,
      },
      "Session bound to owner",
    );
    return ownership;
  }

  ownerOf(sessionId: string): AgentSpec | undefined {
    const o = this.owned.get(sessionId);
    if (o && o.kind === "owner") return o.ownerSpec;
    return undefined;
  }

  ownershipOf(sessionId: string): ActiveOwnership | undefined {
    return this.owned.get(sessionId);
  }

  isAskSession(sessionId: string): boolean {
    return this.owned.get(sessionId)?.kind === "ask";
  }

  resolveAskAnswer(sessionId: string, text: string): boolean {
    const handle = this.askBySession.get(sessionId);
    if (!handle) return false;
    this.askBySession.delete(sessionId);
    handle.resolve({ kind: "answer", text });
    return true;
  }

  resolveAskOutcome(sessionId: string, outcome: AskSessionOutcome): boolean {
    const handle = this.askBySession.get(sessionId);
    if (!handle) return false;
    this.askBySession.delete(sessionId);
    handle.resolve(outcome);
    return true;
  }

  release(sessionId: string): void {
    if (this.owned.delete(sessionId)) {
      this.logger.info({ sessionId }, "Session ownership released");
    }
    const handle = this.askBySession.get(sessionId);
    if (handle) {
      this.askBySession.delete(sessionId);
      // If the ask-handle is still in flight when the session is released
      // (e.g. Core terminated the session for an external reason), resolve
      // it as cancelled so the awaiting tool does not hang.
      if (!handle.settled) handle.resolve({ kind: "cancelled" });
    }
  }

  private purgeExpired(): void {
    const now = Date.now();
    for (const [deviceId, r] of this.reservations) {
      if (r.expiresAt <= now) {
        this.reservations.delete(deviceId);
        this.logger.warn({ deviceId, mode: r.mode }, "Reservation expired without matching session_start");
        if (r.kind === "ask") {
          const handle = this.askByDevice.get(deviceId);
          if (handle) handle.resolve({ kind: "timeout" });
        }
      }
    }
    for (const [sessionId, expiresAt] of this.armTornDown) {
      if (expiresAt <= now) this.armTornDown.delete(sessionId);
    }
  }
}
