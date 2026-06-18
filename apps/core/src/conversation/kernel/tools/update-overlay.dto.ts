import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from "class-validator";

const OVERLAY_KIND_VALUES = [
  "idle",
  "listening",
  "capturing",
  "thinking",
  "processing",
  "success",
  "error",
] as const;
type OverlayKindValue = (typeof OVERLAY_KIND_VALUES)[number];

const OVERLAY_SOUND_VALUES = [
  "endpoint",
  "error",
  "ack_done",
  "ack_continue",
  "ack_thinking",
  "ack_success",
  "ack_error",
  "ack_unknown",
] as const;
type OverlaySoundValue = (typeof OVERLAY_SOUND_VALUES)[number];

export class UpdateOverlayDto {
  @IsEnum(OVERLAY_KIND_VALUES)
  kind!: OverlayKindValue;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  hint?: string;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  caption?: string;

  @IsOptional()
  @IsEnum(OVERLAY_SOUND_VALUES)
  sound?: OverlaySoundValue;

  // ms; when set, the kernel terminates the active Ear capture session
  // after this delay (session_end reason `endpoint`). Drop the field for
  // a state with no auto-close behaviour.
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(60_000)
  ttl?: number;
}
