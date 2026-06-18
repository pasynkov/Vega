import { Injectable, OnModuleInit } from "@nestjs/common";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { LlmService } from "../../integrations/llm/llm.module";
import { SessionService } from "../../conversation/ear/session/session.service";
import { EarSessionRouter } from "../../conversation/sessions/ear-session-router.service";
import { FlushHookRegistry } from "../../conversation/sessions/flush-hook-registry.service";
import { OverlayService } from "../../conversation/overlay/overlay.service";
import { NotesStorageService } from "./notes-storage.service";
import { buildNotesTools } from "./notes.tools";
import { buildNotesSessionSpec, buildNotesSupervisorSpec } from "./notes.agent";
import type { AgentSpec } from "../../conversation/kernel/agent.types";

@Injectable()
export class NotesAgentService implements OnModuleInit {
  private readonly supervisorSpec: AgentSpec;
  private readonly sessionSpec: AgentSpec;

  constructor(
    @InjectPinoLogger(NotesAgentService.name) private readonly logger: PinoLogger,
    private readonly llm: LlmService,
    private readonly storage: NotesStorageService,
    private readonly sessions: SessionService,
    private readonly router: EarSessionRouter,
    private readonly flushHooks: FlushHookRegistry,
    private readonly overlay: OverlayService,
  ) {
    const sessionSpecRef: { spec: AgentSpec | null } = { spec: null };
    const { supervisorTools, sessionTools } = buildNotesTools(
      this.storage,
      this.sessions,
      this.router,
      this.overlay,
      sessionSpecRef,
    );
    this.supervisorSpec = buildNotesSupervisorSpec(supervisorTools);
    this.sessionSpec = buildNotesSessionSpec(sessionTools);
    sessionSpecRef.spec = this.sessionSpec;
    void this.llm;
    this.logger.info(
      { supervisorTools: supervisorTools.length, sessionTools: sessionTools.length },
      "Notes agent specs built",
    );
  }

  onModuleInit(): void {
    this.flushHooks.register(this.sessionSpec.name, (sessionId, initiator) => {
      // Incremental appends already persisted the transcript. On forced
      // termination (cap or error) we leave the in-progress file in place;
      // explicit cleanup happens via discard_note or finalize_note.
      if (this.storage.hasInProgress(sessionId)) {
        this.logger.warn(
          { sessionId, initiator },
          "Long-note session terminated externally; in-progress file kept as-is",
        );
      }
    });
    // Framework writes every final directly to the in-progress file. The
    // session sub-agent only runs on pauses to decide finalize/continue.
    this.flushHooks.registerFinalAppend(this.sessionSpec.name, (sessionId, text) => {
      this.storage.appendChunk(sessionId, text);
    });
  }

  get spec(): AgentSpec {
    return this.supervisorSpec;
  }
}
