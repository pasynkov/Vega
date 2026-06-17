import { IsIn, IsOptional, IsString, ValidateIf } from "class-validator";

export const END_NODE = "__end__";

export class RouteSchema {
  @IsString()
  goto!: string;

  @IsOptional()
  @IsString()
  @ValidateIf((o: RouteSchema) => o.goto !== END_NODE)
  task?: string;

  @IsOptional()
  @IsString()
  @ValidateIf((o: RouteSchema) => o.goto === END_NODE)
  speakText?: string;
}

export function makeRouteValidator(activeDomainNames: string[]) {
  const allowed = new Set<string>([...activeDomainNames, END_NODE]);
  return (raw: unknown): string[] => {
    const errors: string[] = [];
    if (!raw || typeof raw !== "object") {
      errors.push("Route output is not an object");
      return errors;
    }
    const r = raw as Record<string, unknown>;
    if (typeof r.goto !== "string" || !allowed.has(r.goto)) {
      errors.push(`Invalid goto "${String(r.goto)}". Must be one of: ${[...allowed].join(", ")}`);
    }
    if (r.goto === END_NODE) {
      if (typeof r.speakText !== "string" || r.speakText.trim() === "") {
        errors.push('When goto is "__end__", speakText must be a non-empty string.');
      }
    } else if (typeof r.goto === "string" && allowed.has(r.goto)) {
      if (typeof r.task !== "string" || r.task.trim() === "") {
        errors.push("When goto is a domain name, task must be a non-empty string.");
      }
    }
    return errors;
  };
}
