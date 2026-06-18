import { Injectable } from "@nestjs/common";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import {
  OverlayStateSchema,
  type OverlayState,
  type OverlayUpdateMessage,
} from "@vega/ear-protocol";

export interface OverlaySetOptions {
  ttl?: number;
}

type Sender = (event: string, payload: OverlayUpdateMessage) => void;
type SessionTerminator = () => void | Promise<void>;

interface DeviceBinding {
  send: Sender;
  terminateSession: SessionTerminator;
  seq: number;
  ttlTimer: NodeJS.Timeout | null;
}

@Injectable()
export class OverlayService {
  private readonly byDevice = new Map<string, DeviceBinding>();

  constructor(
    @InjectPinoLogger(OverlayService.name) private readonly logger: PinoLogger,
  ) {}

  // Called by the Ear gateway when a device registers. Wires the per-device
  // sender (WebSocket send) and the session-termination callback used by ttl.
  bindDevice(deviceId: string, send: Sender, terminateSession: SessionTerminator): void {
    this.unbindDevice(deviceId);
    this.byDevice.set(deviceId, {
      send,
      terminateSession,
      seq: 0,
      ttlTimer: null,
    });
    this.logger.info({ deviceId }, "overlay.bindDevice");
  }

  unbindDevice(deviceId: string): void {
    const binding = this.byDevice.get(deviceId);
    if (!binding) return;
    if (binding.ttlTimer) clearTimeout(binding.ttlTimer);
    this.byDevice.delete(deviceId);
    this.logger.info({ deviceId, lastSeq: binding.seq }, "overlay.unbindDevice");
  }

  // Cancel any pending ttl timer for the device without dropping the binding.
  // Called from session-end paths so a session that ended for any other reason
  // does not trigger the ttl-driven terminator.
  cancelTtl(deviceId: string): void {
    const binding = this.byDevice.get(deviceId);
    if (!binding || !binding.ttlTimer) return;
    clearTimeout(binding.ttlTimer);
    binding.ttlTimer = null;
    this.logger.info({ deviceId }, "overlay.cancelTtl");
  }

  set(
    deviceId: string,
    state: OverlayState,
    options: OverlaySetOptions = {},
    origin?: string,
  ): boolean {
    const binding = this.byDevice.get(deviceId);
    if (!binding) {
      this.logger.warn(
        { deviceId, kind: state.kind, origin },
        "overlay.set: no active device, dropping",
      );
      return false;
    }
    const validated = OverlayStateSchema.safeParse(state);
    if (!validated.success) {
      this.logger.warn(
        { deviceId, issues: validated.error.flatten(), origin },
        "overlay.set: invalid state, rejecting",
      );
      return false;
    }

    binding.seq += 1;
    const message: OverlayUpdateMessage = {
      seq: binding.seq,
      state: validated.data,
    };
    try {
      binding.send("overlay_update", message);
    } catch (err) {
      this.logger.warn({ err, deviceId, origin }, "overlay.set: sender threw");
      return false;
    }

    this.logger.info(
      {
        deviceId,
        seq: binding.seq,
        kind: validated.data.kind,
        sound: validated.data.sound,
        hint: validated.data.hint,
        caption: validated.data.caption,
        ttl: options.ttl,
        origin,
      },
      "overlay.set",
    );

    if (binding.ttlTimer) {
      clearTimeout(binding.ttlTimer);
      binding.ttlTimer = null;
    }
    if (typeof options.ttl === "number" && options.ttl > 0) {
      const ms = options.ttl;
      binding.ttlTimer = setTimeout(() => {
        const live = this.byDevice.get(deviceId);
        if (!live) return;
        live.ttlTimer = null;
        this.logger.info({ deviceId, ttlMs: ms }, "overlay.ttl fired");
        try {
          const r = live.terminateSession();
          if (r && typeof (r as Promise<void>).then === "function") {
            (r as Promise<void>).catch((err) =>
              this.logger.warn({ err, deviceId }, "ttl terminator promise rejected"),
            );
          }
        } catch (err) {
          this.logger.warn({ err, deviceId }, "ttl terminator threw");
        }
      }, ms);
    }
    return true;
  }

  // Test/diagnostic helpers
  getSeq(deviceId: string): number | undefined {
    return this.byDevice.get(deviceId)?.seq;
  }

  hasTtlTimer(deviceId: string): boolean {
    return !!this.byDevice.get(deviceId)?.ttlTimer;
  }
}
