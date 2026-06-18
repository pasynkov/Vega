import { Injectable } from "@nestjs/common";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { GraphFactory } from "./kernel/graph.factory";
import { SessionRegistry } from "./session-registry.service";

const FALLBACK_REPLY = "";

export type TurnOutcome = "acted" | "unknown" | "error";

export interface TurnResult {
  reply: string;
  outcome: TurnOutcome;
}

@Injectable()
export class ConversationService {
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(
    @InjectPinoLogger(ConversationService.name) private readonly logger: PinoLogger,
    private readonly graphFactory: GraphFactory,
    private readonly sessions: SessionRegistry,
  ) {}

  async handleTurn(sessionId: string, userText: string): Promise<TurnResult> {
    // Chain onto the current tail so concurrent callers serialize against
    // the SAME promise. The prior inFlight-read-then-set pattern raced
    // when two callers read the same `prior` and then both started their
    // own `runTurn` after `prior` settled. The chain head IS the value
    // stored in inFlight, so every subsequent caller appends to the
    // latest tail in arrival order. A rejecting turn is swallowed by the
    // chain so it does not block the next queued turn (the caller still
    // sees the rejection via its own `current` promise below).
    const prior = this.inFlight.get(sessionId) ?? Promise.resolve();
    const current = prior
      .catch(() => undefined)
      .then(() => this.runTurn(sessionId, userText));
    this.inFlight.set(sessionId, current);
    try {
      return await current;
    } finally {
      if (this.inFlight.get(sessionId) === current) {
        this.inFlight.delete(sessionId);
      }
    }
  }

  private async runTurn(sessionId: string, userText: string): Promise<TurnResult> {
    await this.sessions.touch(sessionId);
    const graph = this.graphFactory.build();
    this.logger.info(
      { sessionId, userText: userText.slice(0, 160), userChars: userText.length },
      "→ graph.invoke",
    );
    const startedAt = Date.now();
    try {
      const result = (await graph.invoke(
        { messages: [new HumanMessage(userText)], sessionId },
        { configurable: { thread_id: sessionId }, recursionLimit: 8 },
      )) as { messages: BaseMessage[]; lastAgentResult?: unknown };
      const reply = extractSpokenReply(result.messages);
      const acted = wasActed(result);
      this.logger.info(
        { sessionId, replyChars: reply.length, acted, ms: Date.now() - startedAt },
        "← graph.invoke",
      );
      return { reply, outcome: acted ? "acted" : "unknown" };
    } catch (err) {
      this.logger.error(
        { err, sessionId, ms: Date.now() - startedAt },
        "Turn threw, returning fallback reply",
      );
      return { reply: FALLBACK_REPLY, outcome: "error" };
    }
  }
}

function wasActed(result: { messages: BaseMessage[]; lastAgentResult?: unknown }): boolean {
  if (result.lastAgentResult && typeof result.lastAgentResult === "object") {
    const lar = result.lastAgentResult as { status?: string };
    if (lar.status === "ok") return true;
  }
  // Fallback: any AIMessage with a name (i.e. a domain reply) in the trail.
  for (const m of result.messages) {
    const name = (m as { name?: string }).name;
    if (m instanceof AIMessage && typeof name === "string" && name && name !== "supervisor") {
      return true;
    }
  }
  return false;
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
