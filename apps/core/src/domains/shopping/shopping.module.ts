import {
  Global,
  Inject,
  Module,
  OnApplicationShutdown,
  OnModuleInit,
} from "@nestjs/common";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { DataSource } from "typeorm";
import { ConversationModule } from "../../conversation/conversation.module";
import { AgentRegistry } from "../../conversation/kernel/agent-registry.service";
import { ImmersiveDomainRegistry } from "../../conversation/immersive/immersive-domain.registry";
import { createDomainDataSource } from "../../integrations/database/domain-db.factory";
import { ShoppingItem } from "./shopping-item.entity";
import {
  SHOPPING_ITEM_REPOSITORY,
  ShoppingStorageService,
} from "./shopping-storage.service";
import { ShoppingAgentService } from "./shopping-agent.service";

const SHOPPING_DATA_SOURCE = Symbol("SHOPPING_DATA_SOURCE");

@Global()
@Module({
  imports: [ConversationModule],
  providers: [
    {
      provide: SHOPPING_DATA_SOURCE,
      useFactory: () => createDomainDataSource({ name: "shopping", entities: [ShoppingItem] }),
    },
    {
      provide: SHOPPING_ITEM_REPOSITORY,
      inject: [SHOPPING_DATA_SOURCE],
      useFactory: (ds: DataSource) => ds.getRepository(ShoppingItem),
    },
    ShoppingStorageService,
    ShoppingAgentService,
  ],
  exports: [ShoppingStorageService, ShoppingAgentService],
})
export class ShoppingModule implements OnModuleInit, OnApplicationShutdown {
  constructor(
    @InjectPinoLogger(ShoppingModule.name) private readonly logger: PinoLogger,
    private readonly registry: AgentRegistry,
    private readonly immersiveRegistry: ImmersiveDomainRegistry,
    private readonly shoppingAgent: ShoppingAgentService,
    @Inject(SHOPPING_DATA_SOURCE) private readonly dataSource: DataSource,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.dataSource.isInitialized) {
      await this.dataSource.initialize();
      this.logger.info({ database: this.dataSource.options.database }, "shopping DataSource initialized");
    }
    this.registry.register(this.shoppingAgent.spec);
    this.immersiveRegistry.register({
      name: "shopping",
      sessionSpec: this.shoppingAgent.sessionSpec,
      sessionBegin: (deviceId) => this.shoppingAgent.sessionBegin(deviceId),
    });
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.dataSource.isInitialized) {
      await this.dataSource.destroy();
      this.logger.info("shopping DataSource closed");
    }
  }
}
