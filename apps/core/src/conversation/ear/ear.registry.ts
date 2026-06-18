import { Injectable } from "@nestjs/common";
import { WebSocket } from "ws";
import { Capability, RegisterMessage, sessionShortIdFromUuid } from "@vega/ear-protocol";

export interface EarConnection {
  readonly socket: WebSocket;
  readonly deviceId: string;
  readonly deviceName: string;
  readonly capabilities: Capability[];
  activeSessionId: string | null;
  activeSessionShortId: bigint | null;
}

@Injectable()
export class EarRegistry {
  private readonly byDeviceId = new Map<string, EarConnection>();

  register(socket: WebSocket, message: RegisterMessage): EarConnection {
    const existing = this.byDeviceId.get(message.deviceId);
    if (existing && existing.socket !== socket) {
      existing.socket.close(4003, "superseded");
    }
    const connection: EarConnection = {
      socket,
      deviceId: message.deviceId,
      deviceName: message.deviceName,
      capabilities: message.capabilities,
      activeSessionId: null,
      activeSessionShortId: null,
    };
    this.byDeviceId.set(message.deviceId, connection);
    return connection;
  }

  unregister(deviceId: string): void {
    this.byDeviceId.delete(deviceId);
  }

  setActiveSession(deviceId: string, sessionId: string | null): void {
    const conn = this.byDeviceId.get(deviceId);
    if (!conn) return;
    conn.activeSessionId = sessionId;
    conn.activeSessionShortId = sessionId === null ? null : sessionShortIdFromUuid(sessionId);
  }

  list(): EarConnection[] {
    return Array.from(this.byDeviceId.values());
  }
}
