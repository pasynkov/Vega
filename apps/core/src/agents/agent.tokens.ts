export const AGENT_SPEC = Symbol("AGENT_SPEC");

export const RESERVED_AGENT_NAMES = new Set<string>([
  "__end__",
  "supervisor",
  "pre-supervisor",
]);
