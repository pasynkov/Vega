import { IoAdapter } from "@nestjs/platform-socket.io";
import { INestApplicationContext } from "@nestjs/common";
import type { ServerOptions } from "socket.io";
import { Server } from "socket.io";
import { ulid } from "ulid";

// Custom socket.io adapter for the Ear gateway. Mirrors the pattern
// used in balancy's ApplicationAdapter:
//   • set server-level options (long ping window so mac sleep/wake
//     doesn't generate false disconnects)
//   • generate per-socket ids via ulid so log correlation across
//     reconnects stays stable
//   • keep the default memory adapter (single-process MVP)
export class EarIoAdapter extends IoAdapter {
  constructor(app: INestApplicationContext) {
    super(app);
  }

  public createIOServer(port: number, options?: ServerOptions): Server {
    const server: Server = super.createIOServer(port, {
      ...(options ?? {}),
      // Long ping window — mac sleep/wake can produce 30+ second
      // gaps in event-loop progression and we don't want the lib to
      // hang up the socket prematurely. The Ear's wake/disconnect
      // logic is the source of truth.
      pingInterval: 25_000,
      pingTimeout: 60_000,
    });
    server.use((socket, next) => {
      // socket.io's default id is a 20-char random string; ulid gives
      // us monotonic-ish, sortable ids that are nicer in logs.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (socket as any).id = ulid();
      next();
    });
    return server;
  }
}
