import { tool } from "@langchain/core/tools";
import type { DynamicStructuredTool } from "@langchain/core/tools";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { validationMetadatasToSchemas } from "class-validator-jsonschema";
import type { ClassConstructor } from "class-transformer";

export class ToolValidationError extends Error {
  constructor(
    public readonly toolName: string,
    public readonly errors: string[],
  ) {
    super(`Tool ${toolName} input validation failed: ${errors.join("; ")}`);
    this.name = "ToolValidationError";
  }
}

import type { EarSessionHandle } from "../sessions/ear-session-handle";

export interface ToolHandlerContext {
  sessionId?: string;
  earSession?: EarSessionHandle;
}

export interface MakeToolParams<DtoT extends object, ResultT> {
  dto: ClassConstructor<DtoT>;
  name: string;
  description: string;
  handler: (dto: DtoT, ctx: ToolHandlerContext) => Promise<ResultT> | ResultT;
}

// Generates a JSON Schema from the DTO class via class-validator-jsonschema,
// hands the schema to LangGraph's tool() wrapper, and on every invocation
// pipes raw LLM arguments through class-transformer + class-validator before
// the handler runs. One DTO declaration drives both the LLM-facing schema
// and runtime validation. The handler also receives a minimal context whose
// `sessionId` is sourced from `RunnableConfig.configurable.thread_id`, so
// in-session tools can act on the right session without putting sessionId
// in the LLM-facing schema.
export function makeTool<DtoT extends object, ResultT = unknown>(
  params: MakeToolParams<DtoT, ResultT>,
): DynamicStructuredTool {
  const schema = buildJsonSchema(params.dto);

  return tool(
    async (raw: unknown, runtime: unknown): Promise<string> => {
      const dto = plainToInstance(params.dto, raw ?? {});
      const errors = await validate(dto as object);
      if (errors.length > 0) {
        const messages = errors.flatMap((e) =>
          Object.values(e.constraints ?? {}),
        );
        throw new ToolValidationError(params.name, messages);
      }
      const ctx = extractToolContext(runtime);
      const result = await params.handler(dto, ctx);
      return typeof result === "string" ? result : JSON.stringify(result);
    },
    {
      name: params.name,
      description: params.description,
      schema,
    },
  ) as DynamicStructuredTool;
}

function extractToolContext(runtime: unknown): ToolHandlerContext {
  if (!runtime || typeof runtime !== "object") return {};
  const r = runtime as Record<string, unknown>;
  const configurable = ((r.configurable as Record<string, unknown>) ?? (r.config as { configurable?: Record<string, unknown> })?.configurable) ?? undefined;
  const threadId = configurable && typeof configurable.thread_id === "string" ? (configurable.thread_id as string) : undefined;
  const earSession = configurable && typeof configurable.ear_session === "object" && configurable.ear_session !== null
    ? (configurable.ear_session as EarSessionHandle)
    : undefined;
  const sessionId = earSession?.sessionId ?? threadId;
  return { sessionId, earSession };
}

// Exposed so the boot-time smoke test can validate every DTO before any
// graph compilation happens.
export function buildJsonSchema(dto: ClassConstructor<object>): Record<string, unknown> {
  const all = validationMetadatasToSchemas({ refPointerPrefix: "#/definitions/" });
  const name = dto.name;
  const schema = (all as Record<string, unknown>)[name];
  if (!schema || typeof schema !== "object") {
    return { type: "object", properties: {}, additionalProperties: false };
  }
  return schema as Record<string, unknown>;
}

// Boot-time check. Throws if any tool's input schema isn't a non-empty
// object type, surfacing broken DTO decorator combinations the day they
// are added rather than the day a user first invokes the tool.
export function assertToolSchemasValid(
  tools: { name: string; schema?: unknown }[],
): void {
  for (const t of tools) {
    const schema = t.schema as { type?: unknown; properties?: unknown } | undefined;
    if (!schema || typeof schema !== "object") {
      throw new Error(`Tool ${t.name} has no input schema`);
    }
    if (schema.type !== "object") {
      throw new Error(`Tool ${t.name} input schema is missing type: "object" root`);
    }
    if (!schema.properties || typeof schema.properties !== "object" ||
        Object.keys(schema.properties as Record<string, unknown>).length === 0) {
      throw new Error(`Tool ${t.name} input schema has no properties`);
    }
  }
}
