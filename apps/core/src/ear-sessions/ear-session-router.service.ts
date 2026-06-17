import { Injectable } from "@nestjs/common";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import type { ArmCaptureMessage, SessionMode, SessionStartMessage } from "@vega/ear-protocol";
import { EarRegistry } from "../ear/ear.registry";
import type { AgentSpec } from "../agents/agent.types";
import { EarSessionReservationConflictError } from "./ear-session.errors";

const RESERVATION_TTL_MS = 10_000;

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

  constructor(
    @InjectPinoLogger(EarSessionRouter.name) private readonly logger: PinoLogger,
    private readonly registry: EarRegistry,
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
  }
}
