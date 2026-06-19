import { Injectable } from "@nestjs/common";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import type { ListView } from "@vega/ear-protocol";
import { LlmService } from "../../integrations/llm/llm.module";
import { SessionService } from "../../conversation/ear/session/session.service";
import { OverlayService } from "../../conversation/overlay/overlay.service";
import { ListViewService } from "../../conversation/overlay/list-view.service";
import { EarRegistry } from "../../conversation/ear/ear.registry";
import { ShoppingStorageService } from "./shopping-storage.service";
import { buildShoppingTools } from "./shopping.tools";
import { buildShoppingSessionSpec, buildShoppingSupervisorSpec } from "./shopping.agent";
import type { AgentSpec } from "../../conversation/kernel/agent.types";

@Injectable()
export class ShoppingAgentService {
  private readonly supervisorSpec: AgentSpec;
  private readonly immersiveSessionSpec: AgentSpec;

  constructor(
    @InjectPinoLogger(ShoppingAgentService.name) private readonly logger: PinoLogger,
    private readonly llm: LlmService,
    private readonly storage: ShoppingStorageService,
    private readonly overlay: OverlayService,
    private readonly listView: ListViewService,
    private readonly sessions: SessionService,
    private readonly earRegistry: EarRegistry,
  ) {
    const { supervisorTools, sessionTools } = buildShoppingTools(
      this.storage,
      this.overlay,
      this.listView,
      this.sessions,
      this.earRegistry,
    );
    this.supervisorSpec = buildShoppingSupervisorSpec(supervisorTools);
    this.immersiveSessionSpec = buildShoppingSessionSpec(sessionTools);
    void this.llm;
    this.logger.info(
      { supervisorTools: supervisorTools.length, sessionTools: sessionTools.length },
      "Shopping agent spec built",
    );
  }

  get spec(): AgentSpec {
    return this.supervisorSpec;
  }

  get sessionSpec(): AgentSpec {
    return this.immersiveSessionSpec;
  }

  // Entry-paint for immersive mode. Called by EarSessionsModule on
  // bind-success via ImmersiveDomainRegistry. Renders the live list +
  // immersive overlay kind before the first final reaches the runner.
  async sessionBegin(deviceId: string): Promise<void> {
    const items = await this.storage.listLive();
    const snapshot: ListView = {
      title: "Список покупок",
      items: items.map((it) => ({
        id: it.id,
        label: this.storage.formatLabel(it),
        done: it.status === "bought",
      })),
      open: true,
    };
    this.listView.refresh(deviceId, snapshot, "shopping:immersive_begin");
    this.overlay.set(
      deviceId,
      { kind: "immersive", hint: "Покупки" },
      {},
      "shopping:immersive_begin",
    );
  }
}
