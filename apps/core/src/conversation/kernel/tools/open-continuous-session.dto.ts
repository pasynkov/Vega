import { IsOptional, IsString, MaxLength, MinLength } from "class-validator";

export class OpenContinuousSessionDto {
  // User-facing name of the artefact being captured (e.g. note title).
  // Required. Flows through to storage (filename slug) and overlay caption.
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  // Short free-form description used for logs / future TTS hooks. Optional.
  @IsOptional()
  @IsString()
  @MaxLength(240)
  intent?: string;
}
