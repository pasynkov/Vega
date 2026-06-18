import { makeTool } from "../tool-factory";
import type { AgentSpec, AgentTool } from "../agent.types";
import type { EarSessionRouter } from "../../sessions/ear-session-router.service";
import { OpenContinuousSessionDto } from "./open-continuous-session.dto";

// Kernel-provided tool builder. Domains that want their supervisor agent to
// open a continuous (no-VAD-endpoint, ~60-second silence cap) Ear capture
// session inject the output of this factory into their AgentSpec.tools.
//
// `ownerSpecRef` is the indirection that lets a domain construct its
// supervisor-side tool bundle BEFORE the session-bound AgentSpec is
// finalised — the same indirection notes.tools.ts used to thread its own
// session spec into the inline begin_dictation factory. The handler reads
// ownerSpecRef.spec at invocation time so it always sees the latest value.
export function buildOpenContinuousSessionTool(
  router: EarSessionRouter,
  ownerSpecRef: { spec: AgentSpec | null },
): AgentTool {
  return makeTool({
    dto: OpenContinuousSessionDto,
    name: "open_continuous_session",
    description:
      "Открой СВЕЖУЮ continuous-mode Ear-сессию (Submarine cue, ~60s silence cap), которой будет владеть session-bound агент текущего домена. Активная короткая Ear-сессия будет принудительно закрыта перед тем как Ear получит arm_capture. Используй ТОЛЬКО когда домену реально нужна длинная сессия захвата.",
    handler: async () => {
      const spec = ownerSpecRef.spec;
      if (!spec) {
        return { ok: false, reason: "owner-session-spec-not-ready" };
      }
      const result = router.arm({ ownerSpec: spec, mode: "continuous" });
      return result;
    },
  });
}
