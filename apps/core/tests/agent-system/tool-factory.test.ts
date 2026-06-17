import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { IsString, MinLength } from "class-validator";
import { makeTool, buildJsonSchema, assertToolSchemasValid, ToolValidationError } from "../../src/agents/tool-factory";

class EchoDto {
  @IsString()
  @MinLength(1)
  text!: string;
}

class EmptyDto {}

describe("tool-factory", () => {
  it("buildJsonSchema produces an object schema with properties for a valid DTO", () => {
    const schema = buildJsonSchema(EchoDto);
    expect(schema.type).toBe("object");
    expect((schema as any).properties).toBeDefined();
    expect((schema as any).properties.text).toBeDefined();
  });

  it("assertToolSchemasValid passes for a valid tool and fails for an empty DTO tool", () => {
    const goodTool = makeTool({
      dto: EchoDto,
      name: "echo",
      description: "Echo the text back",
      handler: (dto: EchoDto) => `echo:${dto.text}`,
    });
    expect(() => assertToolSchemasValid([{ name: goodTool.name, schema: (goodTool as any).schema }])).not.toThrow();

    const badTool = makeTool({
      dto: EmptyDto,
      name: "empty",
      description: "empty",
      handler: () => "no-op",
    });
    expect(() => assertToolSchemasValid([{ name: badTool.name, schema: (badTool as any).schema }])).toThrow(/no properties/);
  });

  it("makeTool handler is called with a validated DTO when args are valid", async () => {
    const t = makeTool({
      dto: EchoDto,
      name: "echo",
      description: "Echo",
      handler: async (dto: EchoDto) => `seen:${dto.text}`,
    });
    const out = await (t as any).invoke({ text: "hello" });
    expect(out).toBe("seen:hello");
  });

  it("makeTool rejects invalid input before the handler runs", async () => {
    let handlerCalls = 0;
    const t = makeTool({
      dto: EchoDto,
      name: "echo",
      description: "Echo",
      handler: async (dto: EchoDto) => {
        handlerCalls += 1;
        return `seen:${dto.text}`;
      },
    });
    // The LangChain tool layer also runs a JSON Schema check before our
    // wrapper. Either layer (schema or class-validator) rejecting is fine;
    // what matters is that the handler is never called with bad input.
    await expect((t as any).invoke({ text: "" })).rejects.toThrow();
    expect(handlerCalls).toBe(0);
    void ToolValidationError; // retained as the public error type our wrapper throws when class-validator fails post-schema.
  });
});
