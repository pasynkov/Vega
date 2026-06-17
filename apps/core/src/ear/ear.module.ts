import { Module, OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import { EarGateway } from "./ear.gateway";
import { EarRegistry } from "./ear.registry";
import { WakeCoordinator } from "../wake/wake-coordinator";
import { SessionService } from "../session/session.service";
import { DeepgramClient } from "../deepgram/deepgram.client";
import { RecordingStore } from "../recording/recording-store";

@Module({
  providers: [
    EarGateway,
    EarRegistry,
    WakeCoordinator,
    SessionService,
    DeepgramClient,
    RecordingStore,
  ],
})
export class EarModule implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(
    private readonly gateway: EarGateway,
    private readonly sessions: SessionService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.gateway.start();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.sessions.shutdownAll();
    await this.gateway.stop();
  }
}
