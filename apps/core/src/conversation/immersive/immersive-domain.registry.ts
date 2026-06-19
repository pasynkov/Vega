import { Injectable, Logger } from "@nestjs/common";
import type { AgentSpec } from "../kernel/agent.types";

// Hook fired by EarSessionsModule when an immersive session is bound to
// this domain — the domain paints its entry state (e.g. shopping shows
// the live list-view) before any final reaches the runner.
export type ImmersiveSessionBegin = (deviceId: string) => Promise<void> | void;

export interface ImmersiveDomainRegistration {
  name: string;
  sessionSpec: AgentSpec;
  sessionBegin: ImmersiveSessionBegin;
}

@Injectable()
export class ImmersiveDomainRegistry {
  private readonly logger = new Logger("ImmersiveDomainRegistry");
  private readonly entries = new Map<string, ImmersiveDomainRegistration>();

  register(entry: ImmersiveDomainRegistration): void {
    if (!entry.name) {
      throw new Error("ImmersiveDomainRegistry.register: name is required");
    }
    if (this.entries.has(entry.name)) {
      throw new Error(`ImmersiveDomainRegistry: domain "${entry.name}" already registered`);
    }
    this.entries.set(entry.name, entry);
    this.logger.log(`Registered immersive domain "${entry.name}"`);
  }

  get(name: string): ImmersiveDomainRegistration | undefined {
    return this.entries.get(name);
  }

  list(): string[] {
    return Array.from(this.entries.keys()).sort();
  }
}
