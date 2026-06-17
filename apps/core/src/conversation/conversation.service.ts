import { Injectable } from "@nestjs/common";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { GraphFactory } from "../agents/graph.factory";
import { SessionRegistry } from "./session-registry.service";

const FALLBACK_REPLY = "Сейчас не могу ответить, попробуй ещё раз.";

@Injectable()
export class ConversationService {
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(
    @InjectPinoLogger(ConversationService.name) private readonly logger: PinoLogger,
    private readonly graphFactory: GraphFactory,
    private readonly sessions: SessionRegistry,
  ) {}

  async handleTurn(sessionId: string, userText: string): Promise<string> {
    const prior = this.inFlight.get(sessionId);
    if (prior) {
      await prior.catch(() => undefined);
    }
    const current = this.runTurn(sessionId, userText);
    this.inFlight.set(sessionId, current);
    try {
      return await current;
    } finally {
      if (this.inFlight.get(sessionId) === current) {
        this.inFlight.delete(sessionId);
      }
    }
  }

  private async runTurn(sessionId: string, userText: string): Promise<string> {
    await this.sessions.touch(sessionId);
    const graph = this.graphFactory.build();
    try {
      const result = (await graph.invoke(
        { messages: [new HumanMessage(userText)], sessionId },
        { configurable: { thread_id: sessionId } },
      )) as { messages: BaseMessage[] };
      const reply = extractSpokenReply(result.messages);
      this.logger.info({ sessionId, replyChars: reply.length }, "Turn finished");
      return reply;
    } catch (err) {
      this.logger.error({ err, sessionId }, "Turn threw, returning fallback reply");
      return FALLBACK_REPLY;
    }
  }
}

function extractSpokenReply(messages: BaseMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m instanceof AIMessage) {
      const c = m.content;
      if (typeof c === "string") return c;
      if (Array.isArray(c)) {
        return c
          .map((part) => (typeof part === "string" ? part : (part as { text?: string }).text ?? ""))
          .join("");
      }
    }
  }
  return "";
}
