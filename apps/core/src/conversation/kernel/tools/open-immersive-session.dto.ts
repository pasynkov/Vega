import { IsOptional, IsString, MaxLength, MinLength } from "class-validator";

export class OpenImmersiveSessionDto {
  // Kebab-case immersive domain name. Validated at handler-time against
  // ImmersiveDomainRegistry.list().
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  domain!: string;

  // Short free-form description used for logs. Optional.
  @IsOptional()
  @IsString()
  @MaxLength(240)
  intent?: string;
}
