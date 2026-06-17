import { Inject, Injectable } from "@nestjs/common";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { StateGraph, START, END } from "@langchain/langgraph";
import type { CompiledStateGraph } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { AgentRegistry } from "./agent-registry.service";
import { RESERVED_AGENT_NAMES } from "./agent.tokens";
import { LlmService } from "../llm/llm.module";
import { VegaState, type VegaStateType } from "./supervisor/state";
import { PreSupervisorNode } from "./supervisor/pre-supervisor.node";
import { SupervisorNode } from "./supervisor/supervisor.node";
import { makeSubAgentNode } from "./sub-agent.factory";

export const COMPILED_GRAPH = Symbol("VEGA_COMPILED_GRAPH");
export const CHECKPOINTER = Symbol("VEGA_CHECKPOINTER");

@Injectable()
export class GraphFactory {
  private _compiled: CompiledStateGraph<VegaStateType, Partial<VegaStateType>> | null = null;

  constructor(
    @InjectPinoLogger(GraphFactory.name) private readonly logger: PinoLogger,
    private readonly registry: AgentRegistry,
    private readonly llm: LlmService,
    private readonly preSupervisor: PreSupervisorNode,
    private readonly supervisor: SupervisorNode,
    @Inject(CHECKPOINTER) private readonly checkpointer: SqliteSaver,
  ) {}

  build(): CompiledStateGraph<VegaStateType, Partial<VegaStateType>> {
    if (this._compiled) return this._compiled;

    const seen = new Set<string>();
    for (const spec of this.registry.listAll()) {
      if (RESERVED_AGENT_NAMES.has(spec.name)) {
        throw new Error(`AgentSpec name "${spec.name}" is reserved by the orchestration runtime`);
      }
      if (seen.has(spec.name)) {
        throw new Error(`Duplicate AgentSpec name: "${spec.name}"`);
      }
      seen.add(spec.name);
    }

    const graph = new StateGraph(VegaState);
    graph.addNode("pre-supervisor", this.preSupervisor.asNode() as any);
    graph.addNode("supervisor", this.supervisor.asNode() as any, {
      ends: [...this.registry.listAll().map((s) => s.name as any), END as any],
    } as any);
    for (const spec of this.registry.listAll()) {
      const node = makeSubAgentNode({ spec, llm: this.llm });
      graph.addNode(spec.name as any, node as any, {
        ends: ["supervisor" as any],
      } as any);
    }

    graph.addEdge(START as any, "pre-supervisor" as any);
    graph.addEdge("pre-supervisor" as any, "supervisor" as any);

    const compiled = graph.compile({ checkpointer: this.checkpointer }) as unknown as
      CompiledStateGraph<VegaStateType, Partial<VegaStateType>>;
    this._compiled = compiled;
    this.logger.info(
      { domains: this.registry.listAll().map((s) => s.name) },
      "Orchestration graph compiled",
    );
    return compiled;
  }
}
