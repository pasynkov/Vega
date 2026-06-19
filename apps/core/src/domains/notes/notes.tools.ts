import { makeTool } from "../../conversation/kernel/tool-factory";
import { buildOpenContinuousSessionTool } from "../../conversation/kernel/tools/open-continuous-session.tool";
import { buildUpdateOverlayTool } from "../../conversation/kernel/tools/update-overlay.tool";
import { buildAskUserTool } from "../../conversation/kernel/tools/ask-user.tool";
import type { AgentTool, AgentSpec } from "../../conversation/kernel/agent.types";
import { SessionService } from "../../conversation/ear/session/session.service";
import { EarSessionRouter } from "../../conversation/sessions/ear-session-router.service";
import { ToolUsedOutsideSessionError } from "../../conversation/sessions/ear-session.errors";
import { OverlayService } from "../../conversation/overlay/overlay.service";
import { EarRegistry } from "../../conversation/ear/ear.registry";
import { NotesStorageService } from "./notes-storage.service";
import { DiscardNoteDto, FinalizeNoteDto } from "./notes.dtos";

export interface NotesToolBundle {
  supervisorTools: AgentTool[];
  sessionTools: AgentTool[];
}

export function buildNotesTools(
  storage: NotesStorageService,
  sessions: SessionService,
  router: EarSessionRouter,
  overlay: OverlayService,
  earRegistry: EarRegistry,
  sessionSpecRef: { spec: AgentSpec | null },
): NotesToolBundle {
  const openContinuousSession = buildOpenContinuousSessionTool(router, sessionSpecRef);
  const updateOverlay = buildUpdateOverlayTool(overlay, sessions);
  const askUser = buildAskUserTool(router, sessions, overlay, earRegistry);

  const finalizeNote = makeTool({
    dto: FinalizeNoteDto,
    name: "finalize_note",
    description:
      "Завершить длинную заметку: перезаписать файл очищенным cleanText и закрыть Ear-сессию. Используется ТОЛЬКО внутри session-bound диктовки. Возвращает release-сигнал.",
    handler: async (dto, ctx) => {
      if (!ctx.earSession) throw new ToolUsedOutsideSessionError("finalize_note");
      const { path } = storage.finalizeInProgress(ctx.earSession.sessionId, dto.cleanText);
      overlay.set(
        ctx.earSession.deviceId,
        { kind: "success", hint: "Заметка сохранена", sound: "ack_success" },
        { ttl: 1500 },
        "notes:finalize_note_success",
      );
      return { ok: true, path, release: true as const, reason: "endpoint" as const };
    },
  });

  const discardNote = makeTool({
    dto: DiscardNoteDto,
    name: "discard_note",
    description:
      "Сбросить in-progress заметку и закрыть Ear-сессию (например, пользователь передумал или поток шумовой). Используется ТОЛЬКО внутри session-bound диктовки. Возвращает release-сигнал.",
    handler: async (dto, ctx) => {
      if (!ctx.earSession) throw new ToolUsedOutsideSessionError("discard_note");
      storage.discardInProgress(ctx.earSession.sessionId, dto.reason);
      overlay.set(
        ctx.earSession.deviceId,
        { kind: "error", hint: "Заметка отменена", sound: "ack_error" },
        { ttl: 1500 },
        "notes:discard_note_error",
      );
      return { ok: true, release: true as const, reason: "user" as const, discardReason: dto.reason };
    },
  });

  return {
    supervisorTools: [openContinuousSession, askUser, updateOverlay],
    sessionTools: [finalizeNote, discardNote, updateOverlay],
  };
}
