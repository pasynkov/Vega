import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import { Server, Socket } from "socket.io";
import { Injectable } from "@nestjs/common";
import { PinoLogger, InjectPinoLogger } from "nestjs-pino";
import {
  AckMessage,
  EarSessionEndMessage,
  EarSessionEndMessageSchema,
  RegisterMessage,
  RegisterMessageSchema,
  SessionStartMessage,
  SessionStartMessageSchema,
  WakeAckMessage,
  WakeDetectedMessage,
  WakeDetectedMessageSchema,
} from "@vega/ear-protocol";
import { EnvConfig } from "../../config/env";
import { EarRegistry, EarConnection } from "./ear.registry";
import { WakeCoordinator } from "./wake/wake-coordinator";
import { SessionService } from "./session/session.service";
import { OverlayService } from "../overlay/overlay.service";
import { ListViewService } from "../overlay/list-view.service";

const REGISTER_TIMEOUT_MS = 2_000;

@Injectable()
@WebSocketGateway({
  namespace: "/ear",
  transports: ["websocket"],
  cors: false,
})
export class EarGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer() server!: Server;

  // Per-socket state we'd otherwise stash on `socket.data` — kept here
  // because socket.io's `socket.data` typing pulls in extra generics.
  private readonly registerTimers = new Map<string, NodeJS.Timeout>();
  private readonly connections = new Map<string, EarConnection>();
  private readonly throughputState = new Map<string, { frames: number; bytes: number; lastAt: number }>();

  constructor(
    @InjectPinoLogger(EarGateway.name) private readonly logger: PinoLogger,
    private readonly env: EnvConfig,
    private readonly registry: EarRegistry,
    private readonly wake: WakeCoordinator,
    private readonly sessions: SessionService,
    private readonly overlay: OverlayService,
    private readonly listView: ListViewService,
  ) {}

  afterInit(server: Server): void {
    this.logger.info(
      `EarGateway listening on ws://${this.env.earWsHost}:${this.env.earWsPort}/ear`,
    );
    void server; // referenced for nestjs lifecycle
  }

  handleConnection(socket: Socket): void {
    const remote = socket.handshake.address ?? "unknown";
    this.logger.info({ remote, socketId: socket.id }, "Ear connecting");
    const timer = setTimeout(() => {
      this.logger.warn({ remote, socketId: socket.id }, "Ear did not register in time, closing");
      socket.disconnect(true);
    }, REGISTER_TIMEOUT_MS);
    this.registerTimers.set(socket.id, timer);
  }

  handleDisconnect(socket: Socket): void {
    const timer = this.registerTimers.get(socket.id);
    if (timer) {
      clearTimeout(timer);
      this.registerTimers.delete(socket.id);
    }
    const connection = this.connections.get(socket.id);
    if (connection) {
      this.connections.delete(socket.id);
      void this.sessions.handleDisconnect(connection);
      this.listView.unbindDevice(connection.deviceId);
      this.overlay.unbindDevice(connection.deviceId);
      this.registry.unregister(connection.deviceId);
    }
    this.throughputState.delete(socket.id);
    this.logger.info({ socketId: socket.id }, "Ear disconnected");
  }

  @SubscribeMessage("register")
  onRegister(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown): void {
    const parsed = RegisterMessageSchema.safeParse(body);
    if (!parsed.success) {
      this.logger.warn({ socketId: socket.id, issues: parsed.error.flatten() }, "register: invalid");
      return;
    }
    const message: RegisterMessage = parsed.data;
    const timer = this.registerTimers.get(socket.id);
    if (timer) {
      clearTimeout(timer);
      this.registerTimers.delete(socket.id);
    }
    const connection = this.registry.register(socket, message);
    this.connections.set(socket.id, connection);
    const ack: AckMessage = { deviceId: message.deviceId };
    socket.emit("ack", ack);
    this.listView.bindDevice(message.deviceId, (event, payload) => {
      try { socket.emit(event, payload); } catch (err) {
        this.logger.warn({ err, deviceId: message.deviceId, event }, "listView emit failed");
      }
    });
    this.overlay.bindDevice(
      message.deviceId,
      (event, payload) => {
        try { socket.emit(event, payload); } catch (err) {
          this.logger.warn({ err, deviceId: message.deviceId, event }, "overlay emit failed");
        }
      },
      async () => {
        // ttl from update_overlay must drive overlay-only lifecycle.
        // It MUST NOT terminate the active capture session — that
        // would cut the user mid-utterance whenever a domain paints
        // a quick success/ttl (e.g. shopping add_item emits
        // success ttl=1500 while the user keeps dictating more items).
        // The session closes through its own VAD / safety paths.
        this.overlay.set(message.deviceId, { kind: "idle" }, {}, "overlay_ttl_idle");
      },
    );
    this.logger.info(
      { deviceId: message.deviceId, deviceName: message.deviceName, socketId: socket.id },
      "Ear registered",
    );
  }

  @SubscribeMessage("wake_detected")
  onWakeDetected(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown): void {
    const connection = this.connections.get(socket.id);
    if (!connection) return this.warnUnregistered(socket, "wake_detected");
    const parsed = WakeDetectedMessageSchema.safeParse(body);
    if (!parsed.success) {
      this.logger.warn({ socketId: socket.id, issues: parsed.error.flatten() }, "wake_detected: invalid");
      return;
    }
    const message: WakeDetectedMessage = parsed.data;
    const action = this.wake.evaluate(connection, message);
    const ack: WakeAckMessage = { action };
    socket.emit("wake_ack", ack);
    if (action === "proceed") {
      // New command → collapse any open list view so the overlay shows
      // only "listening". Pass silentOverlay so the close path doesn't
      // flicker through idle before the listening paint below.
      this.listView.close(connection.deviceId, "wake", { silentOverlay: true });
      this.overlay.set(connection.deviceId, { kind: "listening" }, {}, "wake_ack_proceed");
    }
    this.logger.info(
      {
        deviceId: connection.deviceId,
        score: message.score,
        timestamp: message.timestamp,
        action,
      },
      "wake_detected",
    );
  }

  @SubscribeMessage("session_start")
  onSessionStart(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown): void {
    const connection = this.connections.get(socket.id);
    if (!connection) return this.warnUnregistered(socket, "session_start");
    const parsed = SessionStartMessageSchema.safeParse(body);
    if (!parsed.success) {
      this.logger.warn({ socketId: socket.id, issues: parsed.error.flatten() }, "session_start: invalid");
      return;
    }
    const message: SessionStartMessage = parsed.data;
    this.sessions.start(connection, message);
  }

  @SubscribeMessage("session_end")
  onSessionEnd(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown): void {
    const connection = this.connections.get(socket.id);
    if (!connection) return this.warnUnregistered(socket, "session_end");
    const parsed = EarSessionEndMessageSchema.safeParse(body);
    if (!parsed.success) {
      this.logger.warn({ socketId: socket.id, issues: parsed.error.flatten() }, "session_end: invalid");
      return;
    }
    const message: EarSessionEndMessage = parsed.data;
    void this.sessions.endFromEar(connection, message);
  }

  @SubscribeMessage("audio_frame")
  onAudioFrame(
    @ConnectedSocket() socket: Socket,
    @MessageBody() args: [string, Buffer] | unknown,
  ): void {
    const connection = this.connections.get(socket.id);
    if (!connection) return;
    if (!Array.isArray(args) || args.length < 2) return;
    const [sessionId, buffer] = args as [string, Buffer];
    if (typeof sessionId !== "string" || !Buffer.isBuffer(buffer)) return;
    this.reportThroughput(connection.deviceId, socket.id, buffer.byteLength);
    this.sessions.forwardAudio(connection, sessionId, new Uint8Array(buffer));
  }

  // Rate-limited summary so the operator can see audio is flowing
  // without a log line per ~21 ms frame.
  private reportThroughput(deviceId: string, socketId: string, bytes: number): void {
    let state = this.throughputState.get(socketId);
    if (!state) {
      state = { frames: 0, bytes: 0, lastAt: Date.now() };
      this.throughputState.set(socketId, state);
    }
    state.frames += 1;
    state.bytes += bytes;
    const now = Date.now();
    const elapsed = now - state.lastAt;
    if (elapsed >= 1_000) {
      this.logger.debug(
        {
          deviceId,
          frames: state.frames,
          bytes: state.bytes,
          kBperSec: ((state.bytes / (elapsed / 1000)) / 1024).toFixed(1),
        },
        "WS binary throughput",
      );
      state.frames = 0;
      state.bytes = 0;
      state.lastAt = now;
    }
  }

  private warnUnregistered(socket: Socket, event: string): void {
    this.logger.warn({ event, socketId: socket.id }, "Event received before register");
    socket.disconnect(true);
  }
}
