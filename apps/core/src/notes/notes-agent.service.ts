import { Injectable } from "@nestjs/common";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { LlmService } from "../llm/llm.module";
import { SessionService } from "../session/session.service";
import { NotesStorageService } from "./notes-storage.service";
import { buildNotesTools } from "./notes.tools";
import { buildNotesAgentSpec } from "./notes.agent";
import type { AgentSpec } from "../agents/agent.types";

@Injectable()
export class NotesAgentService {
  private readonly _spec: AgentSpec;

  constructor(
    @InjectPinoLogger(NotesAgentService.name) private readonly logger: PinoLogger,
    private readonly llm: LlmService,
    private readonly storage: NotesStorageService,
    private readonly sessions: SessionService,
  ) {
    const tools = buildNotesTools(this.storage, this.sessions);
    this._spec = buildNotesAgentSpec(tools);
    // Surface LlmService to silence "unused dep" if model override is added later.
    void this.llm;
    this.logger.info({ tools: tools.length }, "Notes agent spec built");
  }

  get spec(): AgentSpec {
    return this._spec;
  }
}
