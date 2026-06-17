import { Injectable } from "@nestjs/common";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { Command, END } from "@langchain/langgraph";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { AgentRegistry } from "../agent-registry.service";
import { LlmService } from "../../llm/llm.module";
import { END_NODE, makeRouteValidator } from "./route.schema";
import { buildSupervisorPrompt } from "./supervisor.prompt";
import type { VegaStateType } from "./state";

interface RouteOutput {
  goto: string;
  task?: string;
  speakText?: string;
}

const FALLBACK_REPLY = "Я не понял, повтори?";

@Injectable()
export class SupervisorNode {
  constructor(
    @InjectPinoLogger(SupervisorNode.name) private readonly logger: PinoLogger,
    private readonly registry: AgentRegistry,
    private readonly llm: LlmService,
  ) {}

  // Bind to a graph node — returns the node function.
  asNode(): (state: VegaStateType) => Promise<Command> {
    return (state) => this.run(state);
  }

  async run(state: VegaStateType): Promise<Command> {
    const domains = this.registry.metaForSupervisor();
    const activeNames = domains.map((d) => d.name);
    const systemPrompt = buildSupervisorPrompt({ domains, memoryHints: state.memoryHints });
    const validator = makeRouteValidator(activeNames);

    const baseMessages: BaseMessage[] = [
      new SystemMessage(systemPrompt),
      ...state.messages,
    ];

    const route = await this.callRouter(baseMessages, validator);
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

    const task = route.task ?? "";
    this.logger.info({ goto: route.goto, task: task.slice(0, 80) }, "Supervisor routing to domain");
    return new Command({
      goto: route.goto,
      update: {
        messages: [new HumanMessage({ content: `task: ${task}`, name: "supervisor" })],
        activeContext: { lastDomain: route.goto, lastEntityIds: state.activeContext.lastEntityIds },
      },
    });
  }

  private async callRouter(
    messages: BaseMessage[],
    validator: (raw: unknown) => string[],
  ): Promise<RouteOutput | null> {
    // Use a JSON-mode structured-output schema since the spec instructs
    // the supervisor to call withStructuredOutput. class-validator does
    // the post-hoc enum/required check because LangChain's schema cannot
    // know the dynamic domain list.
    const model = this.llm.getModel();
    const schema = this.routerJsonSchema();
    // Sonnet 4.5+ rejects the default function-calling prefill ("conversation
    // must end with a user message"). Use the native jsonSchema method which
    // does not prefill an assistant turn.
    const structured = model.withStructuredOutput(schema, {
      name: "RouteSchema",
      method: "jsonSchema",
    } as any);

    for (let attempt = 0; attempt < 2; attempt++) {
      let raw: unknown;
      try {
        raw = await structured.invoke(messages);
      } catch (err) {
        this.logger.warn({ attempt, err }, "Supervisor structured output threw");
        continue;
      }
      const errors = validator(raw);
      if (errors.length === 0) {
        return raw as RouteOutput;
      }
      this.logger.warn({ attempt, errors, raw }, "Supervisor route validation failed");
      messages = [
        ...messages,
        new SystemMessage(
          `Previous routing decision was invalid: ${errors.join("; ")}. Return a valid RouteSchema.`,
        ),
      ];
    }
    return null;
  }

  private routerJsonSchema(): Record<string, unknown> {
    return {
      type: "object",
      title: "RouteSchema",
      properties: {
        goto: {
          type: "string",
          description: 'One of the active domain names or the literal "__end__".',
        },
        task: {
          type: "string",
          description: "Natural-language description of the work for the chosen domain (required when goto is a domain).",
        },
        speakText: {
          type: "string",
          description: "Literal reply to surface to the user (required when goto is __end__).",
        },
      },
      required: ["goto"],
      additionalProperties: false,
    };
  }
}
