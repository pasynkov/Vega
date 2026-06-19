import { Global, Module } from "@nestjs/common";
import { ImmersiveDomainRegistry } from "./immersive-domain.registry";

@Global()
@Module({
  providers: [ImmersiveDomainRegistry],
  exports: [ImmersiveDomainRegistry],
})
export class ImmersiveModule {}
