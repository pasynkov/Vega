import { Injectable } from "@nestjs/common";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import type { ArmCaptureMessage, SessionMode, SessionStartMessage } from "@vega/ear-protocol";
import { EarRegistry } from "../ear/ear.registry";
import { SessionService } from "../ear/session/session.service";
import type { AgentSpec } from "../kernel/agent.types";
import { EarSessionReservationConflictError } from "./ear-session.errors";

const RESERVATION_TTL_MS = 10_000;
const ARM_TORNDOWN_TTL_MS = 5_000;

interface Reservation {
  deviceId: string;
  ownerSpec: AgentSpec;
  mode: SessionMode;
  initialPrompt: string | undefined;
  createdAt: number;
  expiresAt: number;
}

interface ActiveOwnership {
  sessionId: string;
  deviceId: string;
  ownerSpec: AgentSpec;
  mode: SessionMode;
  initialPrompt: string | undefined;
}

export interface ArmOptions {
  ownerSpec: AgentSpec;
  mode: SessionMode;
  deviceId?: string;
  initialPrompt?: string;
}

export interface ArmResult {
  ok: boolean;
  reason?: string;
  deviceId?: string;
  mode?: SessionMode;
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

  constructor(
    @InjectPinoLogger(EarSessionRouter.name) private readonly logger: PinoLogger,
    private readonly registry: EarRegistry,
    private readonly sessions: SessionService,
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
      void this.sessions
        .terminateExternal(activeSessionId, "endpoint", "core:tool_release")
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
      deviceId: conn.deviceId,
      ownerSpec: opts.ownerSpec,
      mode: opts.mode,
      initialPrompt: opts.initialPrompt,
      createdAt: now,
      expiresAt: now + RESERVATION_TTL_MS,
    });
    const msg: ArmCaptureMessage = { type: "arm_capture", mode: opts.mode };
    try {
      conn.socket.send(JSON.stringify(msg));
    } catch (err) {
      this.reservations.delete(conn.deviceId);
      this.logger.warn({ err, mode: opts.mode }, "arm: socket send failed");
      return { ok: false, reason: "send-failed" };
    }
    this.logger.info(
      { deviceId: conn.deviceId, mode: opts.mode, owner: opts.ownerSpec.name },
      "Ear session reserved via arm_capture",
    );
    return { ok: true, deviceId: conn.deviceId, mode: opts.mode };
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
    if ((message.mode ?? "regular") !== reservation.mode) return undefined;
    this.reservations.delete(deviceId);
    const ownership: ActiveOwnership = {
      sessionId: message.sessionId,
      deviceId,
      ownerSpec: reservation.ownerSpec,
      mode: reservation.mode,
      initialPrompt: reservation.initialPrompt,
    };
    this.owned.set(message.sessionId, ownership);
    this.logger.info(
      { sessionId: message.sessionId, deviceId, owner: reservation.ownerSpec.name },
      "Session bound to owner",
    );
    return ownership;
  }

  ownerOf(sessionId: string): AgentSpec | undefined {
    return this.owned.get(sessionId)?.ownerSpec;
  }

  ownershipOf(sessionId: string): ActiveOwnership | undefined {
    return this.owned.get(sessionId);
  }

  release(sessionId: string): void {
    if (this.owned.delete(sessionId)) {
      this.logger.info({ sessionId }, "Session ownership released");
    }
  }

  private purgeExpired(): void {
    const now = Date.now();
    for (const [deviceId, r] of this.reservations) {
      if (r.expiresAt <= now) {
        this.reservations.delete(deviceId);
        this.logger.warn({ deviceId, mode: r.mode }, "Reservation expired without matching session_start");
      }
    }
    for (const [sessionId, expiresAt] of this.armTornDown) {
      if (expiresAt <= now) this.armTornDown.delete(sessionId);
    }
  }
}
