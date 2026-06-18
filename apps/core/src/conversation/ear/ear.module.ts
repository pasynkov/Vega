import { Module, OnApplicationShutdown } from "@nestjs/common";
import { EarGateway } from "./ear.gateway";
import { EarRegistry } from "./ear.registry";
import { WakeCoordinator } from "./wake/wake-coordinator";
import { SessionService } from "./session/session.service";
import { DeepgramClient } from "../../integrations/deepgram/deepgram.client";
import { RecordingStore } from "./recording/recording-store";
import { OverlayModule } from "../overlay/overlay.module";

@Module({
  imports: [OverlayModule],
  providers: [
    EarGateway,
    EarRegistry,
    WakeCoordinator,
    SessionService,
    DeepgramClient,
    RecordingStore,
  ],
  exports: [SessionService, EarRegistry, OverlayModule],
})
export class EarModule implements OnApplicationShutdown {
  constructor(private readonly sessions: SessionService) {}

  async onApplicationShutdown(): Promise<void> {
    await this.sessions.shutdownAll();
  }
}
