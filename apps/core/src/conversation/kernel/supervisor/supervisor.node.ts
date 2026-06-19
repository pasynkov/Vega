import { Injectable } from "@nestjs/common";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { Command, END } from "@langchain/langgraph";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { AgentRegistry } from "../agent-registry.service";
import { LlmService } from "../../../integrations/llm/llm.module";
import { END_NODE, IMMERSIVE_OPEN_NODE, RouteSchema, makeRouteValidator } from "./route.schema";
import { buildSupervisorPrompt } from "./supervisor.prompt";
import { buildJsonSchema } from "../tool-factory";
import type { VegaStateType } from "./state";
import { ImmersiveDomainRegistry } from "../../immersive/immersive-domain.registry";
import { EarSessionRouter } from "../../sessions/ear-session-router.service";

interface RouteOutput {
  goto: string;
  task?: string;
  speakText?: string;
}

const FALLBACK_REPLY = "";

@Injectable()
export class SupervisorNode {
  constructor(
    @InjectPinoLogger(SupervisorNode.name) private readonly logger: PinoLogger,
    private readonly registry: AgentRegistry,
    private readonly llm: LlmService,
    private readonly immersiveRegistry: ImmersiveDomainRegistry,
    private readonly earSessionRouter: EarSessionRouter,
  ) {}

  asNode(): (state: VegaStateType) => Promise<Command> {
    return (state) => this.run(state);
  }

  async run(state: VegaStateType): Promise<Command> {
    const domains = this.registry.metaForSupervisor();
    const activeNames = domains.map((d) => d.name);
    const immersiveDomains = this.immersiveRegistry.list();
    const systemPrompt = buildSupervisorPrompt({
      domains,
      memoryHints: state.memoryHints,
      immersiveDomains,
    });
    const validator = makeRouteValidator(activeNames, immersiveDomains);

    const baseMessages: BaseMessage[] = [
      new SystemMessage(systemPrompt),
      ...state.messages,
    ];
    ensureEndsWithHuman(baseMessages);

    const route = await this.callRouter(baseMessages, activeNames, immersiveDomains, validator);
    if (!route) {
      this.logger.warn({}, "Supervisor falling back to clarification reply");
      return new Command({
        goto: END,
        update: { messages: [new AIMessage(FALLBACK_REPLY)] },
      });
    }

    if (route.goto === END_NODE) {
      const text = route.speakText ?? "";
      this.logger.info({ goto: END_NODE, speakText: text.slice(0, 80) }, "Supervisor end-of-turn");
      return new Command({
        goto: END,
        update: { messages: [new AIMessage(text)] },
      });
    }

    if (route.goto === IMMERSIVE_OPEN_NODE) {
      const domain = (route.task ?? "").trim();
      const reg = this.immersiveRegistry.get(domain);
      if (!reg) {
        this.logger.warn(
          { domain, available: immersiveDomains },
          "Supervisor picked immersive_open with unknown domain",
        );
        // Name the AIMessage so ConversationService.wasActed returns true
        // (otherwise the unknown-outcome overlay flashes red).
        return new Command({
          goto: END,
          update: { messages: [new AIMessage({ content: "", name: "immersive_open" })] },
        });
      }
      const armResult = this.earSessionRouter.arm({
        ownerSpec: reg.sessionSpec,
        mode: "immersive",
        intent: `immersive:${domain}`,
        domainName: domain,
      });
      this.logger.info(
        { domain, armResult },
        "Supervisor opened immersive session",
      );
      // Same naming reason — supervisor DID act (opened the session).
      return new Command({
        goto: END,
        update: { messages: [new AIMessage({ content: "", name: "immersive_open" })] },
      });
    }

    const task = route.task ?? "";
    this.logger.info(
      { goto: route.goto, taskLen: task.length, task: task.slice(0, 160) },
      "Supervisor routing to domain",
    );
    return new Command({
      goto: route.goto,
      update: {
        messages: [new HumanMessage({ content: `task: ${task}`, name: "supervisor" })],
        activeContext: { lastDomain: route.goto, lastEntityIds: state.activeContext.lastEntityIds },
      },
    });
  }

  // Use Anthropic's native tool-use to force a single `route` tool call.
  // Two reasons over withStructuredOutput: (a) we can pass tool_choice to
  // force the model to call route exactly once, (b) tool-call args bypass
  // the JSON-mode assistant-prefill paths that broke on Sonnet 4.5+.
  private async callRouter(
    messages: BaseMessage[],
    activeDomains: string[],
    immersiveDomains: string[],
    validator: (raw: unknown) => string[],
  ): Promise<RouteOutput | null> {
    // Supervisor routing is a cheap "pick a domain" decision — haiku is
    // 2-3× faster than sonnet and accurate enough for this prompt shape.
    const model = this.llm.getModel({ model: "claude-haiku-4-5-20251001" });
    const schema = buildJsonSchema(RouteSchema);
    // Patch dynamic enum: active domain names + __end__. The DTO can't
    // declare a static @IsIn because the domain list is built at runtime
    // from the AgentRegistry, but we still want the LLM-facing schema to
    // constrain `goto` to the actual choices.
    const props = (schema as any).properties as Record<string, any>;
    if (props?.goto) {
      const gotoEnum: string[] = [...activeDomains, END_NODE];
      if (immersiveDomains.length > 0) gotoEnum.push(IMMERSIVE_OPEN_NODE);
      props.goto.enum = gotoEnum;
      props.goto.description = immersiveDomains.length > 0
        ? 'Domain name, "__end__", or "__immersive_open__".'
        : 'Domain name or "__end__".';
    }
    if (props?.task) {
      props.task.description =
        immersiveDomains.length > 0
          ? "Natural-language task description (required when goto is a domain); immersive-domain name when goto is __immersive_open__."
          : "Natural-language task description (required when goto is a domain).";
    }
    if (props?.speakText) {
      props.speakText.description = 'Always "" — TTS is not wired yet.';
    }
    (schema as any).required = ["goto"];
    (schema as any).additionalProperties = false;
    const routeTool = {
      name: "route",
      description: "Route the turn to a domain or end it.",
      input_schema: schema,
    };
    const bound = (model as any).bindTools([routeTool], {
      tool_choice: { type: "tool", name: "route" },
    });

    const modelId = "claude-haiku-4-5-20251001";
    for (let attempt = 0; attempt < 2; attempt++) {
      let reply: AIMessage;
      const startedAt = Date.now();
      this.logger.info(
        { model: modelId, attempt, messages: messages.length, domains: activeDomains },
        "LLM → supervisor.route",
      );
      try {
        reply = (await bound.invoke(messages)) as AIMessage;
      } catch (err) {
        this.logger.warn({ attempt, err, ms: Date.now() - startedAt }, "Supervisor tool-call invoke threw");
        continue;
      }
      const usage = (reply as any).usage_metadata
        ?? (reply as any).response_metadata?.usage
        ?? undefined;
      this.logger.info(
        {
          model: modelId,
          attempt,
          ms: Date.now() - startedAt,
          inputTokens: usage?.input_tokens,
          outputTokens: usage?.output_tokens,
          toolCalls: (reply.tool_calls ?? []).map((c) => c.name),
        },
        "LLM ← supervisor.route",
      );
      const call = extractRouteCall(reply);
      if (!call) {
        this.logger.warn({ attempt }, "Supervisor reply contained no tool call");
        messages = [
          ...messages,
          reply,
          new HumanMessage("Tool call missing — call the `route` tool now."),
        ];
        continue;
      }
      const errors = validator(call);
      if (errors.length === 0) {
        return call as unknown as RouteOutput;
      }
      this.logger.warn({ attempt, errors, call }, "Supervisor route validation failed");
      messages = [
        ...messages,
        reply,
        new HumanMessage(
          `Previous route call was invalid: ${errors.join("; ")}. Call \`route\` again with valid args.`,
        ),
      ];
    }
    return null;
  }
}

function extractRouteCall(message: AIMessage): Record<string, unknown> | null {
  const calls = (message as any).tool_calls as Array<{ name: string; args?: unknown }> | undefined;
  if (calls && calls.length > 0) {
    const call = calls.find((c) => c.name === "route") ?? calls[0];
    if (call && typeof call.args === "object" && call.args !== null) {
      return call.args as Record<string, unknown>;
    }
  }
  return null;
}

function ensureEndsWithHuman(messages: BaseMessage[]): void {
  const last = messages[messages.length - 1];
  if (last instanceof HumanMessage) return;
  if (last instanceof AIMessage && typeof (last as any).name === "string" && (last as any).name) {
    const name = (last as any).name as string;
    const raw = typeof last.content === "string" ? last.content : "";
    let summary = "";
    let status = "";
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        if (typeof parsed.summary === "string") summary = parsed.summary;
        if (typeof parsed.status === "string") status = parsed.status;
      }
    } catch { /* not JSON */ }
    const detail = [status && `status=${status}`, summary && `summary="${summary}"`]
      .filter(Boolean)
      .join(", ");
    messages.push(
      new HumanMessage(
        `Домен "${name}" завершил ход${detail ? ` (${detail})` : ""}. Вызови route с goto="__end__" и speakText="" если задача решена. Иначе — маршрутизируй в ДРУГОЙ домен.`,
      ),
    );
    return;
  }
  messages.push(new HumanMessage("Call the `route` tool to choose the next domain or __end__."));
}
