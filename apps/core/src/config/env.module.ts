import { Global, Module } from "@nestjs/common";
import { EnvConfig } from "./env";

@Global()
@Module({
  providers: [EnvConfig],
  exports: [EnvConfig],
})
export class EnvConfigModule {}
