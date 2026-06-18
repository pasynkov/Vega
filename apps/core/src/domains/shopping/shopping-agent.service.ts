import { Injectable } from "@nestjs/common";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { LlmService } from "../../integrations/llm/llm.module";
import { SessionService } from "../../conversation/ear/session/session.service";
import { OverlayService } from "../../conversation/overlay/overlay.service";
import { ListViewService } from "../../conversation/overlay/list-view.service";
import { EarRegistry } from "../../conversation/ear/ear.registry";
import { ShoppingStorageService } from "./shopping-storage.service";
import { buildShoppingTools } from "./shopping.tools";
import { buildShoppingSupervisorSpec } from "./shopping.agent";
import type { AgentSpec } from "../../conversation/kernel/agent.types";

@Injectable()
export class ShoppingAgentService {
  private readonly supervisorSpec: AgentSpec;

  constructor(
    @InjectPinoLogger(ShoppingAgentService.name) private readonly logger: PinoLogger,
    private readonly llm: LlmService,
    private readonly storage: ShoppingStorageService,
    private readonly overlay: OverlayService,
    private readonly listView: ListViewService,
    private readonly sessions: SessionService,
    private readonly earRegistry: EarRegistry,
  ) {
    const { supervisorTools } = buildShoppingTools(
      this.storage,
      this.overlay,
      this.listView,
      this.sessions,
      this.earRegistry,
    );
    this.supervisorSpec = buildShoppingSupervisorSpec(supervisorTools);
    void this.llm;
    this.logger.info({ tools: supervisorTools.length }, "Shopping agent spec built");
  }

  get spec(): AgentSpec {
    return this.supervisorSpec;
  }
}
