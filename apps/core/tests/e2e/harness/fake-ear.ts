import { io as ioClient, type Socket } from "socket.io-client";
import type {
  AckMessage,
  ArmCaptureMessage,
  CoreSessionEndMessage,
  Capability,
  Codec,
  FinalTranscriptMessage,
  ListViewUpdateMessage,
  OverlayUpdateMessage,
  PartialTranscriptMessage,
  RegisterMessage,
  SessionModeChangeMessage,
  SessionMode,
  SessionStartMessage,
  WakeAckMessage,
  WakeDetectedMessage,
  EarSessionEndMessage,
} from "@vega/ear-protocol";
import { waitFor, type WaitForOpts } from "./waiters";

interface FakeEarOpts {
  port: number;
  host?: string;
  deviceId?: string;
  deviceName?: string;
  capabilities?: Capability[];
}

interface Inbox {
  ack: AckMessage[];
  wakeAck: WakeAckMessage[];
  partial: PartialTranscriptMessage[];
  final: FinalTranscriptMessage[];
  overlay: OverlayUpdateMessage[];
  listView: ListViewUpdateMessage[];
  armCapture: ArmCaptureMessage[];
  sessionEnd: CoreSessionEndMessage[];
  sessionMode: SessionModeChangeMessage[];
  exception: unknown[];
}

function uuid(): string {
  // Test-only UUIDv4-shaped random. socket.io-client doesn't care, but
  // the gateway zod-validates `deviceId`/`sessionId` as uuid format.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export class FakeEar {
  readonly socket: Socket;
  readonly deviceId: string;
  readonly deviceName: string;
  readonly capabilities: Capability[];
  readonly inbox: Inbox = {
    ack: [],
    wakeAck: [],
    partial: [],
    final: [],
    overlay: [],
    listView: [],
    armCapture: [],
    sessionEnd: [],
    sessionMode: [],
    exception: [],
  };
  // Tracks the active sessionId for convenience helpers.
  private _activeSessionId: string | null = null;

  constructor(opts: FakeEarOpts) {
    this.deviceId = opts.deviceId ?? uuid();
    this.deviceName = opts.deviceName ?? "fake-ear";
    this.capabilities = opts.capabilities ?? ["mic", "wake"];
    const host = opts.host ?? "127.0.0.1";
    const url = `ws://${host}:${opts.port}/ear`;
    this.socket = ioClient(url, {
      transports: ["websocket"],
      forceNew: true,
      reconnection: false,
    });
    this.bindInbox();
  }

  private bindInbox(): void {
    this.socket.on("ack", (p: AckMessage) => this.inbox.ack.push(p));
    this.socket.on("wake_ack", (p: WakeAckMessage) => this.inbox.wakeAck.push(p));
    this.socket.on("partial_transcript", (p: PartialTranscriptMessage) => this.inbox.partial.push(p));
    this.socket.on("final_transcript", (p: FinalTranscriptMessage) => this.inbox.final.push(p));
    this.socket.on("overlay_update", (p: OverlayUpdateMessage) => this.inbox.overlay.push(p));
    this.socket.on("list_view_update", (p: ListViewUpdateMessage) => this.inbox.listView.push(p));
    this.socket.on("arm_capture", (p: ArmCaptureMessage) => this.inbox.armCapture.push(p));
    this.socket.on("session_end", (p: CoreSessionEndMessage) => this.inbox.sessionEnd.push(p));
    this.socket.on("session_mode", (p: SessionModeChangeMessage) => this.inbox.sessionMode.push(p));
    this.socket.on("exception", (p: unknown) => this.inbox.exception.push(p));
  }

  async connected(timeoutMs = 1_000): Promise<void> {
    if (this.socket.connected) return;
    await new Promise<void>((resolve, reject) => {
      const onConnect = () => {
        this.socket.off("connect_error", onError);
        resolve();
      };
      const onError = (err: Error) => {
        this.socket.off("connect", onConnect);
        reject(err);
      };
      this.socket.once("connect", onConnect);
      this.socket.once("connect_error", onError);
      setTimeout(() => reject(new Error(`socket connect timeout ${timeoutMs}ms`)), timeoutMs);
    });
  }

  // ───────── Ear → Core emitters ─────────

  async register(): Promise<AckMessage> {
    await this.connected();
    const msg: RegisterMessage = {
      deviceId: this.deviceId,
      deviceName: this.deviceName,
      capabilities: this.capabilities,
    };
    this.socket.emit("register", msg);
    return this.waitAck();
  }

  async wake(opts: { score?: number; timestamp?: string } = {}): Promise<WakeAckMessage> {
    const msg: WakeDetectedMessage = {
      deviceId: this.deviceId,
      score: opts.score ?? 0.9,
      timestamp: opts.timestamp ?? new Date(0).toISOString().replace("1970", "2026"),
    };
    const before = this.inbox.wakeAck.length;
    this.socket.emit("wake_detected", msg);
    return this.waitFor(() => this.inbox.wakeAck[before], { onTimeout: () => "no wake_ack received" });
  }

  async sessionStart(opts: {
    mode?: SessionMode;
    sessionId?: string;
    sampleRate?: number;
    codec?: Codec;
    userId?: string | null;
  } = {}): Promise<string> {
    const sessionId = opts.sessionId ?? uuid();
    this._activeSessionId = sessionId;
    const msg: SessionStartMessage = {
      deviceId: this.deviceId,
      sessionId,
      userId: opts.userId ?? null,
      sampleRate: opts.sampleRate ?? 16_000,
      codec: opts.codec ?? "linear16",
      mode: opts.mode,
    };
    this.socket.emit("session_start", msg);
    return sessionId;
  }

  sendAudio(frame: Buffer | Uint8Array, sessionId?: string): void {
    const id = sessionId ?? this._activeSessionId;
    if (!id) throw new Error("FakeEar.sendAudio: no active session — call sessionStart first");
    const buf = Buffer.isBuffer(frame) ? frame : Buffer.from(frame);
    // The gateway expects `args: [sessionId, Buffer]` from socket.io's
    // emit-with-multiple-args shape.
    this.socket.emit("audio_frame", id, buf);
  }

  sessionEnd(opts: { reason?: "user" | "timeout" | "vad"; sessionId?: string } = {}): void {
    const id = opts.sessionId ?? this._activeSessionId;
    if (!id) throw new Error("FakeEar.sessionEnd: no active session");
    const msg: EarSessionEndMessage = {
      sessionId: id,
      reason: opts.reason ?? "user",
    };
    this.socket.emit("session_end", msg);
    this._activeSessionId = null;
  }

  emitRaw(event: string, ...payload: unknown[]): void {
    this.socket.emit(event, ...payload);
  }

  disconnect(): void {
    if (this.socket.connected) this.socket.disconnect();
  }

  // ───────── waiters ─────────

  waitAck(opts?: Pick<WaitForOpts<AckMessage>, "timeoutMs">): Promise<AckMessage> {
    return this.waitFor(() => this.inbox.ack[0], {
      ...opts,
      onTimeout: () => `inbox.ack=${JSON.stringify(this.inbox.ack)}`,
    });
  }

  waitOverlay(
    pred: (m: OverlayUpdateMessage) => boolean,
    opts?: Pick<WaitForOpts<OverlayUpdateMessage>, "timeoutMs">,
  ): Promise<OverlayUpdateMessage> {
    return this.waitFor(() => this.inbox.overlay.find(pred), {
      ...opts,
      onTimeout: () =>
        `inbox.overlay=${JSON.stringify(this.inbox.overlay.map((o) => o.state.kind))}`,
    });
  }

  waitListView(
    pred: (m: ListViewUpdateMessage) => boolean,
    opts?: Pick<WaitForOpts<ListViewUpdateMessage>, "timeoutMs">,
  ): Promise<ListViewUpdateMessage> {
    return this.waitFor(() => this.inbox.listView.find(pred), {
      ...opts,
      onTimeout: () => `inbox.listView count=${this.inbox.listView.length}`,
    });
  }

  waitFinal(
    pred: string | ((m: FinalTranscriptMessage) => boolean),
    opts?: Pick<WaitForOpts<FinalTranscriptMessage>, "timeoutMs">,
  ): Promise<FinalTranscriptMessage> {
    const fn = typeof pred === "string" ? (m: FinalTranscriptMessage) => m.text === pred : pred;
    return this.waitFor(() => this.inbox.final.find(fn), {
      ...opts,
      onTimeout: () =>
        `inbox.final=${JSON.stringify(this.inbox.final.map((m) => m.text))}`,
    });
  }

  waitPartial(
    pred: (m: PartialTranscriptMessage) => boolean,
    opts?: Pick<WaitForOpts<PartialTranscriptMessage>, "timeoutMs">,
  ): Promise<PartialTranscriptMessage> {
    return this.waitFor(() => this.inbox.partial.find(pred), {
      ...opts,
      onTimeout: () =>
        `inbox.partial=${JSON.stringify(this.inbox.partial.map((m) => m.text))}`,
    });
  }

  waitArmCapture(
    mode?: SessionMode,
    opts?: Pick<WaitForOpts<ArmCaptureMessage>, "timeoutMs">,
  ): Promise<ArmCaptureMessage> {
    const pred = mode
      ? (m: ArmCaptureMessage) => m.mode === mode
      : () => true;
    return this.waitFor(() => this.inbox.armCapture.find(pred), {
      ...opts,
      onTimeout: () =>
        `inbox.armCapture=${JSON.stringify(this.inbox.armCapture.map((m) => m.mode))}`,
    });
  }

  waitSessionEnd(
    reason?: CoreSessionEndMessage["reason"],
    opts?: Pick<WaitForOpts<CoreSessionEndMessage>, "timeoutMs">,
  ): Promise<CoreSessionEndMessage> {
    const pred = reason ? (m: CoreSessionEndMessage) => m.reason === reason : () => true;
    return this.waitFor(() => this.inbox.sessionEnd.find(pred), {
      ...opts,
      onTimeout: () =>
        `inbox.sessionEnd=${JSON.stringify(this.inbox.sessionEnd.map((m) => m.reason))}`,
    });
  }

  waitSessionMode(
    mode?: SessionMode,
    opts?: Pick<WaitForOpts<SessionModeChangeMessage>, "timeoutMs">,
  ): Promise<SessionModeChangeMessage> {
    const pred = mode ? (m: SessionModeChangeMessage) => m.mode === mode : () => true;
    return this.waitFor(() => this.inbox.sessionMode.find(pred), {
      ...opts,
      onTimeout: () =>
        `inbox.sessionMode=${JSON.stringify(this.inbox.sessionMode.map((m) => m.mode))}`,
    });
  }

  waitDisconnect(opts: { timeoutMs?: number } = {}): Promise<void> {
    const timeoutMs = opts.timeoutMs ?? 2_500;
    return new Promise((resolve, reject) => {
      if (this.socket.disconnected) return resolve();
      const onDisconnect = () => resolve();
      this.socket.once("disconnect", onDisconnect);
      setTimeout(() => {
        this.socket.off("disconnect", onDisconnect);
        reject(new Error(`socket did not disconnect within ${timeoutMs}ms`));
      }, timeoutMs);
    });
  }

  get activeSessionId(): string | null {
    return this._activeSessionId;
  }

  private waitFor<T>(
    pred: () => T | undefined,
    opts: WaitForOpts<T> = {},
  ): Promise<T> {
    return waitFor<T>(() => pred(), opts);
  }
}
