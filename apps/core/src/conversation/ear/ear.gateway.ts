import { Injectable } from "@nestjs/common";
import { PinoLogger, InjectPinoLogger } from "nestjs-pino";
import { WebSocketServer, WebSocket } from "ws";
import { IncomingMessage } from "node:http";
import {
  AckMessage,
  CoreToEarMessage,
  EarToCoreMessageSchema,
  decodeAudioFrame,
} from "@vega/ear-protocol";
import { EnvConfig } from "../../config/env";
import { EarRegistry, EarConnection } from "./ear.registry";
import { WakeCoordinator } from "./wake/wake-coordinator";
import { SessionService } from "./session/session.service";
import { OverlayService } from "../overlay/overlay.service";
import { ListViewService } from "../overlay/list-view.service";

const REGISTER_TIMEOUT_MS = 2_000;

@Injectable()
export class EarGateway {
  private server?: WebSocketServer;

  constructor(
    @InjectPinoLogger(EarGateway.name) private readonly logger: PinoLogger,
    private readonly env: EnvConfig,
    private readonly registry: EarRegistry,
    private readonly wake: WakeCoordinator,
    private readonly sessions: SessionService,
    private readonly overlay: OverlayService,
    private readonly listView: ListViewService,
  ) {}

  async start(): Promise<void> {
    const server = new WebSocketServer({
      host: this.env.earWsHost,
      port: this.env.earWsPort,
      path: "/ear",
    });
    this.server = server;
    server.on("connection", (socket, req) => this.onConnection(socket, req));
    server.on("listening", () => {
      this.logger.info(
        `EarGateway listening on ws://${this.env.earWsHost}:${this.env.earWsPort}/ear`,
      );
    });
    server.on("error", (err) => this.logger.error({ err }, "EarGateway server error"));
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.logger.info({ clients: server.clients.size }, "Closing EarGateway");
    // Terminate active client sockets so server.close() doesn't hang waiting
    // for them to close themselves.
    for (const client of server.clients) {
      try { client.terminate(); } catch { /* ignore */ }
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.server = undefined;
    this.logger.info("EarGateway closed");
  }

  private onConnection(socket: WebSocket, req: IncomingMessage): void {
    const remote = req.socket.remoteAddress ?? "unknown";
    this.logger.info({ remote }, "Ear connecting");
    let binaryFrameCount = 0;
    let binaryByteCount = 0;
    let binaryReportAt = Date.now();

    const registerTimer = setTimeout(() => {
      this.logger.warn({ remote }, "Ear did not register in time, closing");
      socket.close(4001, "register-timeout");
    }, REGISTER_TIMEOUT_MS);

    let connection: EarConnection | undefined;

    const binFrames = { value: 0 };
    const binBytes = { value: 0 };
    const binLastAt = { value: Date.now() };

    socket.on("message", (data, isBinary) => {
      try {
        if (isBinary) {
          const buf = data as Buffer;
          if (connection) {
            this.reportBinaryThroughput(connection.deviceId, binFrames, binBytes, binLastAt, buf.byteLength);
          }
          this.handleBinary(connection, buf);
          return;
        }
        const text = (data as Buffer).toString("utf-8");
        const json = JSON.parse(text) as unknown;
        const parsed = EarToCoreMessageSchema.safeParse(json);
        if (!parsed.success) {
          this.logger.warn(
            { remote, issues: parsed.error.flatten() },
            "Invalid Ear message, dropping",
          );
          return;
        }
        const message = parsed.data;
        switch (message.type) {
          case "register": {
            clearTimeout(registerTimer);
            connection = this.registry.register(socket, message);
            const ack: AckMessage = { type: "ack", deviceId: message.deviceId };
            this.sendJson(socket, ack);
            this.listView.bindDevice(message.deviceId, (msg) => {
              try { socket.send(JSON.stringify(msg)); } catch (err) {
                this.logger.warn({ err, deviceId: message.deviceId }, "listView send failed");
              }
            });
            this.overlay.bindDevice(
              message.deviceId,
              (msg) => {
                try { socket.send(JSON.stringify(msg)); } catch (err) {
                  this.logger.warn({ err, deviceId: message.deviceId }, "overlay send failed");
                }
              },
              async () => {
                if (!connection) return;
                const sid = this.sessions.getActiveSessionIdForDevice(connection.deviceId);
                if (sid) {
                  // Domain already painted a finishing overlay (success/error)
                  // before requesting ttl; pass silentOverlay so terminate
                  // does not overwrite it with thinking/error.
                  await this.sessions.terminateExternal(
                    sid,
                    "endpoint",
                    "core:overlay_ttl",
                    undefined,
                    { silentOverlay: true },
                  );
                }
                // Hide the overlay on the Ear by sending a final idle state.
                this.overlay.set(connection.deviceId, { kind: "idle" }, {}, "overlay_ttl_idle");
              },
            );
            this.logger.info(
              { deviceId: message.deviceId, deviceName: message.deviceName },
              "Ear registered",
            );
            break;
          }
          case "wake_detected": {
            if (!connection) return this.warnUnregistered(socket, message.type);
            const action = this.wake.evaluate(connection, message);
            this.sendJson(socket, { type: "wake_ack", action });
            if (action === "proceed") {
              // New command → collapse any open list view so the
              // overlay shows only "listening". Pass silentOverlay so
              // the close path doesn't flicker through idle before the
              // listening paint below. If the user's new command is
              // also list-related, show_list will reopen it.
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
            break;
          }
          case "session_start": {
            if (!connection) return this.warnUnregistered(socket, message.type);
            this.sessions.start(connection, message);
            break;
          }
          case "session_end": {
            if (!connection) return this.warnUnregistered(socket, message.type);
            void this.sessions.endFromEar(connection, message);
            break;
          }
        }
      } catch (err) {
        this.logger.warn({ err }, "Failed to process message");
      }
    });

    socket.on("close", (code, reason) => {
      clearTimeout(registerTimer);
      if (connection) {
        void this.sessions.handleDisconnect(connection);
        this.listView.unbindDevice(connection.deviceId);
        this.overlay.unbindDevice(connection.deviceId);
        this.registry.unregister(connection.deviceId);
      }
      this.logger.info({ remote, code, reason: reason.toString() }, "Ear disconnected");
    });

    socket.on("error", (err) => {
      this.logger.warn({ remote, err }, "Ear socket error");
    });
  }

  private handleBinary(connection: EarConnection | undefined, buf: Buffer): void {
    if (!connection) return;
    try {
      const view = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      const { sessionShortId, payload } = decodeAudioFrame(view);
      this.sessions.forwardAudio(connection, sessionShortId, payload);
    } catch (err) {
      this.logger.warn({ err }, "Bad binary frame");
    }
  }

  // Rate-limited summary so the operator can see audio is flowing without
  // a log line per ~21 ms frame.
  private reportBinaryThroughput(
    deviceId: string,
    frameCount: { value: number },
    byteCount: { value: number },
    lastAt: { value: number },
    bytes: number,
  ): void {
    frameCount.value += 1;
    byteCount.value += bytes;
    const now = Date.now();
    const elapsed = now - lastAt.value;
    if (elapsed >= 1_000) {
      this.logger.debug(
        {
          deviceId,
          frames: frameCount.value,
          bytes: byteCount.value,
          kBperSec: ((byteCount.value / (elapsed / 1000)) / 1024).toFixed(1),
        },
        "WS binary throughput",
      );
      frameCount.value = 0;
      byteCount.value = 0;
      lastAt.value = now;
    }
  }

  private warnUnregistered(socket: WebSocket, type: string): void {
    this.logger.warn({ type }, "Message received before register");
    socket.close(4002, "not-registered");
  }

  sendJson(socket: WebSocket, message: CoreToEarMessage): void {
    socket.send(JSON.stringify(message));
  }
}
