import { IsOptional, IsString, ValidateIf } from "class-validator";

export const END_NODE = "__end__";
// Pseudo-goto value: instructs the supervisor to open an immersive Ear
// session for the immersive domain named in `task`. Implemented as a
// goto-encoded action (rather than a second tool) so the supervisor's
// "single route tool" mental model stays intact.
export const IMMERSIVE_OPEN_NODE = "__immersive_open__";

export class RouteSchema {
  @IsString()
  goto!: string;

  @IsOptional()
  @IsString()
  @ValidateIf((o: RouteSchema) => o.goto !== END_NODE)
  task?: string;

  @IsOptional()
  @IsString()
  speakText?: string;
}

export function makeRouteValidator(activeDomainNames: string[], immersiveDomainNames: string[] = []) {
  const allowed = new Set<string>([...activeDomainNames, END_NODE, IMMERSIVE_OPEN_NODE]);
  const immersiveAllowed = new Set<string>(immersiveDomainNames);
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
      // speakText optional; TTS is not wired yet.
    } else if (r.goto === IMMERSIVE_OPEN_NODE) {
      if (typeof r.task !== "string" || r.task.trim() === "") {
        errors.push("When goto is __immersive_open__, task must name the immersive domain to open.");
      } else if (immersiveAllowed.size > 0 && !immersiveAllowed.has(r.task.trim())) {
        errors.push(
          `Unknown immersive domain "${r.task}". Must be one of: ${[...immersiveAllowed].join(", ")}.`,
        );
      }
    } else if (typeof r.goto === "string" && allowed.has(r.goto)) {
      if (typeof r.task !== "string" || r.task.trim() === "") {
        errors.push("When goto is a domain name, task must be a non-empty string.");
      }
    }
    return errors;
  };
}
