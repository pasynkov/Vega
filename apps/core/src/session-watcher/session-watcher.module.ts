import { Module } from "@nestjs/common";
import { EarModule } from "../ear/ear.module";
import { HaikuClassifierService } from "./haiku-classifier.service";
import { SessionWatcher } from "./session-watcher.service";

@Module({
  imports: [EarModule],
  providers: [HaikuClassifierService, SessionWatcher],
  exports: [SessionWatcher],
})
export class SessionWatcherModule {}
