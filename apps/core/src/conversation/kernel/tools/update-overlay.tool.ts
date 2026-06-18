import { makeTool } from "../tool-factory";
import type { AgentTool } from "../agent.types";
import type { OverlayService } from "../../overlay/overlay.service";
import type { SessionService } from "../../ear/session/session.service";
import { UpdateOverlayDto } from "./update-overlay.dto";

// Kernel-provided tool builder. Domains that want their agents to paint
// the interactive overlay inject the output of this factory into their
// AgentSpec.tools. The handler resolves the device that owns the active
// session (via SessionService) and forwards the state record to the
// per-device OverlayService.
//
// When there is no active session for the caller (ctx.sessionId missing
// or session already ended) the call is a no-op: it returns ok:true
// without emitting a wire message so an agent's fall-through path does
// not throw.
export function buildUpdateOverlayTool(
  overlay: OverlayService,
  sessions: SessionService,
): AgentTool {
  return makeTool({
    dto: UpdateOverlayDto,
    name: "update_overlay",
    description:
      "Покрасить интерактивный оверлей на ухе. kind задаёт визуал (listening/capturing/thinking/processing/success/error/idle), hint — короткий текст сверху, caption — подпись снизу, sound — звук (ack_done/ack_success/ack_error/...; wake локальный, недоступен), ttl — миллисекунды до автоматического закрытия Ear-сессии. Любой следующий update_overlay полностью заменяет предыдущее состояние. Используй для шагов processing/success/error в твоих handler-ах.",
    handler: async (dto, ctx) => {
      const deviceId = ctx.earSession?.deviceId
        ?? (ctx.sessionId ? sessions.getDeviceIdForSession(ctx.sessionId) : undefined);
      if (!deviceId) return { ok: true as const, dispatched: false as const };
      const { kind, hint, caption, sound, ttl } = dto;
      const sent = overlay.set(
        deviceId,
        { kind, ...(hint !== undefined ? { hint } : {}), ...(caption !== undefined ? { caption } : {}), ...(sound !== undefined ? { sound } : {}) },
        ttl !== undefined ? { ttl } : {},
        "tool:update_overlay",
      );
      return { ok: true as const, dispatched: sent };
    },
  });
}
