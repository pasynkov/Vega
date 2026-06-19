import { makeTool } from "../tool-factory";
import type { AgentTool } from "../agent.types";
import type { EarSessionRouter } from "../../sessions/ear-session-router.service";
import type { SessionService } from "../../ear/session/session.service";
import type { OverlayService } from "../../overlay/overlay.service";
import type { EarRegistry } from "../../ear/ear.registry";
import { AskUserDto } from "./ask-user.dto";

const ASK_DEFAULT_CAPTURE_MS = 8_000;
const ASK_DEFAULT_HINT = "Скажите ответ";

// Kernel-provided tool builder. Any domain can inject this into its
// supervisor-side or session-bound AgentSpec.tools to ask the user a
// single-shot question through the Ear overlay + mic. The handler
// blocks on the ask-session deferred — when the user answers (or the
// session times out / is cancelled), it returns the outcome to the
// awaiting LLM turn.
export function buildAskUserTool(
  router: EarSessionRouter,
  sessions: SessionService,
  overlay: OverlayService,
  earRegistry: EarRegistry,
): AgentTool {
  return makeTool({
    dto: AskUserDto,
    name: "ask_user",
    description:
      "Задать пользователю короткий голосовой вопрос. Откроет короткую mic-сессию на ухе (overlay: listening + caption=question + cue_listen) и вернёт первый STT-final как answer. captureMs (по умолчанию 8000) — лимит ожидания, после которого вернётся {ok:false, reason:\"timeout\"}. Тап по статус-бару = {ok:false, reason:\"cancelled\"}. Используй, когда домену не хватает параметра (например, имени) и нужно переспросить.",
    handler: async (dto, ctx) => {
      // Resolution order: (1) bound session handle, (2) active session,
      // (3) first registered Ear. The third path matters when handleTurn
      // fires AFTER the wake session already terminated (ear:vad) — at
      // that point sessions.getDeviceIdForSession returns undefined, but
      // the device is still connected and ready to receive arm_capture.
      const deviceId = ctx.earSession?.deviceId
        ?? (ctx.sessionId ? sessions.getDeviceIdForSession(ctx.sessionId) : undefined)
        ?? earRegistry.list()[0]?.deviceId;
      if (!deviceId) return { ok: false as const, reason: "no-active-device" as const };
      const captureMs = dto.captureMs ?? ASK_DEFAULT_CAPTURE_MS;
      const hint = dto.hint ?? ASK_DEFAULT_HINT;
      overlay.set(
        deviceId,
        {
          kind: "listening",
          caption: dto.question.slice(0, 240),
          hint: hint.slice(0, 120),
          sound: "cue_listen",
        },
        {},
        "tool:ask_user",
      );
      let outcome;
      try {
        outcome = await router.openAskSession({ deviceId, captureMs });
      } catch (err) {
        overlay.set(deviceId, { kind: "idle" }, {}, "tool:ask_user:error");
        return { ok: false as const, reason: "infra-error" as const, detail: String(err) };
      }
      overlay.set(deviceId, { kind: "idle" }, {}, "tool:ask_user:done");
      if (outcome.kind === "answer") {
        return { ok: true as const, answer: outcome.text };
      }
      if (outcome.kind === "timeout") {
        return { ok: false as const, reason: "timeout" as const };
      }
      return { ok: false as const, reason: "cancelled" as const };
    },
  });
}
