import { Injectable } from "@nestjs/common";
import type { Socket } from "socket.io";
import {
  Capability,
  RegisterMessage,
} from "@vega/ear-protocol";

export interface EarConnection {
  readonly socket: Socket;
  readonly deviceId: string;
  readonly deviceName: string;
  readonly capabilities: Capability[];
  activeSessionId: string | null;
}

@Injectable()
export class EarRegistry {
  private readonly byDeviceId = new Map<string, EarConnection>();

  register(socket: Socket, message: RegisterMessage): EarConnection {
    const existing = this.byDeviceId.get(message.deviceId);
    if (existing && existing.socket !== socket) {
      try { existing.socket.disconnect(true); } catch { /* ignore */ }
    }
    const connection: EarConnection = {
      socket,
      deviceId: message.deviceId,
      deviceName: message.deviceName,
      capabilities: message.capabilities,
      activeSessionId: null,
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
  }

  list(): EarConnection[] {
    return Array.from(this.byDeviceId.values());
  }

  // Convenience emit helper — service code calls this rather than
  // resolving the socket itself.
  emitTo(deviceId: string, event: string, ...args: unknown[]): boolean {
    const conn = this.byDeviceId.get(deviceId);
    if (!conn) return false;
    try {
      conn.socket.emit(event, ...args);
      return true;
    } catch {
      return false;
    }
  }
}
