import { makeTool } from "../tool-factory";
import type { AgentTool } from "../agent.types";
import type { EarSessionRouter } from "../../sessions/ear-session-router.service";
import type { ImmersiveDomainRegistry } from "../../immersive/immersive-domain.registry";
import { OpenImmersiveSessionDto } from "./open-immersive-session.dto";

// Kernel-provided tool for the top-supervisor. Opens an immersive Ear
// session bound to a domain's session-spec; subsequent finals bypass the
// top-supervisor and go directly into that spec via SessionAgentRunner's
// per-final-turn strategy.
export function buildOpenImmersiveSessionTool(
  router: EarSessionRouter,
  registry: ImmersiveDomainRegistry,
): AgentTool {
  return makeTool({
    dto: OpenImmersiveSessionDto,
    name: "open_immersive_session",
    description:
      "Открой immersive-сессию (погружение) в указанный домен. После открытия каждая реплика пользователя уходит прямо в session-spec этого домена, минуя верхний роутер. Сессия живёт до voice-команды close или 15с молчания. domain — один из зарегистрированных immersive-доменов; intent — короткое описание для логов.",
    handler: async (dto) => {
      const reg = registry.get(dto.domain);
      if (!reg) {
        return {
          ok: false,
          reason: "unknown-immersive-domain",
          available: registry.list(),
        };
      }
      const result = router.arm({
        ownerSpec: reg.sessionSpec,
        mode: "immersive",
        intent: dto.intent,
      });
      return { ...result, domain: dto.domain };
    },
  });
}
