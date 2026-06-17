import { Injectable } from "@nestjs/common";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { RESERVED_AGENT_NAMES } from "./agent.tokens";
import type { AgentSpec, SupervisorDomainMeta } from "./agent.types";
import { assertToolSchemasValid } from "./tool-factory";

// NestJS does not natively support multi-injection tokens that aggregate
// arrays from multiple modules. Instead each domain module's OnModuleInit
// calls AgentRegistry.register(spec). The graph factory queries the
// registry lazily (on first turn) so order-of-init does not matter.
@Injectable()
export class AgentRegistry {
  private readonly specs: AgentSpec[] = [];

  constructor(
    @InjectPinoLogger(AgentRegistry.name) private readonly logger: PinoLogger,
  ) {}

  register(spec: AgentSpec): void {
    if (RESERVED_AGENT_NAMES.has(spec.name)) {
      throw new Error(
        `AgentSpec name "${spec.name}" is reserved by the orchestration runtime`,
      );
    }
    if (this.specs.some((s) => s.name === spec.name)) {
      throw new Error(`Duplicate AgentSpec name: "${spec.name}"`);
    }
    assertToolSchemasValid(
      spec.tools.map((t) => ({ name: t.name, schema: (t as { schema?: unknown }).schema })),
    );
    this.specs.push(spec);
    this.logger.info({ name: spec.name, tools: spec.tools.length }, "AgentSpec registered");
  }

  list(): AgentSpec[] {
    return this.specs.filter((s) => this.isEnabled(s));
  }

  listAll(): AgentSpec[] {
    return [...this.specs];
  }

  get(name: string): AgentSpec | undefined {
    return this.list().find((s) => s.name === name);
  }

  metaForSupervisor(): SupervisorDomainMeta[] {
    return this.list().map((s) => ({
      name: s.name,
      description: s.description,
      examples: s.examples,
    }));
  }

  private isEnabled(spec: AgentSpec): boolean {
    return typeof spec.enabled === "function" ? spec.enabled() : spec.enabled;
  }
}
