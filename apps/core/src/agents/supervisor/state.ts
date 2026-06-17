import { Annotation, MessagesAnnotation } from "@langchain/langgraph";
import type { AgentOutput } from "../agent.types";

export interface ActiveContext {
  lastDomain?: string;
  lastEntityIds: Record<string, string>;
}

export const VegaState = Annotation.Root({
  messages: MessagesAnnotation.spec.messages,
  sessionId: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => "default",
  }),
  activeContext: Annotation<ActiveContext>({
    reducer: (prev, next) => ({ ...prev, ...next }),
    default: () => ({ lastEntityIds: {} }),
  }),
  memoryHints: Annotation<string[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  lastAgentResult: Annotation<AgentOutput | undefined>({
    reducer: (_prev, next) => next,
    default: () => undefined,
  }),
});

export type VegaStateType = typeof VegaState.State;
