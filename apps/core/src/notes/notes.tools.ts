import { makeTool } from "../agents/tool-factory";
import type { AgentTool } from "../agents/agent.types";
import { SessionService, LONG_NOTE_SILENCE_CAP_MS } from "../session/session.service";
import { NotesStorageService } from "./notes-storage.service";
import {
  EnableLongNoteModeDto,
  EndLongNoteModeDto,
  SaveShortNoteDto,
} from "./notes.dtos";

export function buildNotesTools(
  storage: NotesStorageService,
  sessions: SessionService,
): AgentTool[] {
  const saveShortNote = makeTool({
    dto: SaveShortNoteDto,
    name: "save_short_note",
    description:
      "Persist a short dictated note to disk and acknowledge the user with the ack_done cue. Use for finished short notes (one or two sentences).",
    handler: async (dto, ctx) => {
      const { path } = storage.saveNote(dto.text);
      if (ctx.sessionId) {
        sessions.emitCue(ctx.sessionId, "ack_done");
      }
      return { ok: true, path };
    },
  });

  const enableLongNoteMode = makeTool({
    dto: EnableLongNoteModeDto,
    name: "enable_long_note_mode",
    description:
      "Arm the Ear to open a FRESH capture session under long-note mode. The original short utterance is already closed; this tool asks the Ear to start a new session right away with a relaxed silence cap (60s) and play the Submarine cue so the user knows they can dictate freely with pauses. Use ONLY when the user signals they are about to dictate a long-form note.",
    handler: async (_dto) => {
      const armed = sessions.armEarCapture("long_note");
      if (!armed) {
        return { ok: false, reason: "no-ear-connection" };
      }
      return { ok: true, mode: "long_note", silenceCapMs: LONG_NOTE_SILENCE_CAP_MS };
    },
  });

  const endLongNoteMode = makeTool({
    dto: EndLongNoteModeDto,
    name: "end_long_note_mode",
    description:
      "Save the accumulated long note text and terminate the active session with a normal endpoint cue. Use when the user signals they have finished dictating the long note.",
    handler: async (dto, ctx) => {
      const { path } = storage.saveNote(dto.cleanText);
      if (ctx.sessionId && sessions.hasActiveSession(ctx.sessionId)) {
        await sessions.terminateExternal(ctx.sessionId, "endpoint", "core:long_note_end");
      }
      return { ok: true, path };
    },
  });

  return [saveShortNote, enableLongNoteMode, endLongNoteMode];
}
