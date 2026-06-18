import { Injectable } from "@nestjs/common";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import {
  ListViewSchema,
  type ListView,
  type ListViewUpdateMessage,
} from "@vega/ear-protocol";
import { OverlayService } from "./overlay.service";

const AUTO_CLOSE_MS = 60_000;

type Sender = (message: ListViewUpdateMessage) => void;

interface DeviceBinding {
  send: Sender;
  seq: number;
  open: boolean;
  snapshot: ListView | null;
  timer: NodeJS.Timeout | null;
}

@Injectable()
export class ListViewService {
  private readonly byDevice = new Map<string, DeviceBinding>();

  constructor(
    @InjectPinoLogger(ListViewService.name) private readonly logger: PinoLogger,
    private readonly overlay: OverlayService,
  ) {}

  bindDevice(deviceId: string, send: Sender): void {
    this.unbindDevice(deviceId);
    this.byDevice.set(deviceId, {
      send,
      seq: 0,
      open: false,
      snapshot: null,
      timer: null,
    });
    this.logger.info({ deviceId }, "listView.bindDevice");
  }

  unbindDevice(deviceId: string): void {
    const binding = this.byDevice.get(deviceId);
    if (!binding) return;
    if (binding.timer) clearTimeout(binding.timer);
    this.byDevice.delete(deviceId);
    this.logger.info({ deviceId, lastSeq: binding.seq }, "listView.unbindDevice");
  }

  // Open or refresh the list view with a fresh snapshot. Resets the
  // 60-second auto-close timer. The snapshot SHALL carry `open: true` —
  // use `close()` to collapse the surface.
  refresh(deviceId: string, snapshot: ListView, origin?: string): boolean {
    const binding = this.byDevice.get(deviceId);
    if (!binding) {
      this.logger.warn({ deviceId, origin }, "listView.refresh: no active device, dropping");
      return false;
    }
    const validated = ListViewSchema.safeParse(snapshot);
    if (!validated.success) {
      this.logger.warn(
        { deviceId, issues: validated.error.flatten(), origin },
        "listView.refresh: invalid snapshot, rejecting",
      );
      return false;
    }
    if (validated.data.open !== true) {
      this.logger.warn({ deviceId, origin }, "listView.refresh: snapshot must have open=true");
      return false;
    }

    binding.seq += 1;
    binding.open = true;
    binding.snapshot = validated.data;
    const message: ListViewUpdateMessage = {
      type: "list_view_update",
      seq: binding.seq,
      view: validated.data,
    };
    try {
      binding.send(message);
    } catch (err) {
      this.logger.warn({ err, deviceId, origin }, "listView.refresh: sender threw");
      return false;
    }
    this.logger.info(
      {
        deviceId,
        seq: binding.seq,
        items: validated.data.items.length,
        title: validated.data.title,
        origin,
      },
      "listView.refresh",
    );

    this.armAutoCloseTimer(deviceId);
    return true;
  }

  // Immediately close the list view. Cancels the auto-close timer and
  // emits an `open: false` snapshot. By default also paints the orb
  // back to idle; pass `silentOverlay: true` when the caller is about
  // to set a different orb state (e.g. wake → listening) so we don't
  // flicker through idle.
  close(
    deviceId: string,
    reason: "tool" | "timer" | "disconnect" | "wake" = "tool",
    opts?: { silentOverlay?: boolean },
  ): boolean {
    const binding = this.byDevice.get(deviceId);
    if (!binding) {
      this.logger.debug({ deviceId, reason }, "listView.close: no active device");
      return false;
    }
    if (binding.timer) {
      clearTimeout(binding.timer);
      binding.timer = null;
    }
    if (!binding.open) {
      this.logger.debug({ deviceId, reason }, "listView.close: already closed, skipping");
      return false;
    }
    binding.seq += 1;
    binding.open = false;
    binding.snapshot = null;
    const message: ListViewUpdateMessage = {
      type: "list_view_update",
      seq: binding.seq,
      view: { items: [], open: false },
    };
    try {
      binding.send(message);
    } catch (err) {
      this.logger.warn({ err, deviceId }, "listView.close: sender threw");
      return false;
    }
    this.logger.info({ deviceId, seq: binding.seq, reason }, "listView.close");
    if (!opts?.silentOverlay) {
      this.overlay.set(deviceId, { kind: "idle" }, {}, `list_view_close:${reason}`);
    }
    return true;
  }

  isOpen(deviceId: string): boolean {
    return !!this.byDevice.get(deviceId)?.open;
  }

  hasTimer(deviceId: string): boolean {
    return !!this.byDevice.get(deviceId)?.timer;
  }

  getSeq(deviceId: string): number | undefined {
    return this.byDevice.get(deviceId)?.seq;
  }

  private armAutoCloseTimer(deviceId: string): void {
    const binding = this.byDevice.get(deviceId);
    if (!binding) return;
    if (binding.timer) clearTimeout(binding.timer);
    binding.timer = setTimeout(() => {
      const live = this.byDevice.get(deviceId);
      if (!live) return;
      live.timer = null;
      this.logger.info({ deviceId }, "listView.autoCloseTimer fired");
      this.close(deviceId, "timer");
    }, AUTO_CLOSE_MS);
  }
}
