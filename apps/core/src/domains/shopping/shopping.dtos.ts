import {
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";

export class AddItemDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100_000)
  quantity?: number;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  unit?: string;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  note?: string;
}

export class MarkBoughtDto {
  @IsUUID()
  id!: string;
}

export class DeleteItemDto {
  @IsUUID()
  id!: string;
}

// class-validator requires a non-empty input schema for tools. The
// placeholder mirrors the pattern from OpenContinuousSessionDto — the
// LLM never needs to fill it meaningfully.
export class ShoppingIntentDto {
  @IsString()
  @MinLength(0)
  @MaxLength(120)
  intent!: string;
}

export class CloseImmersiveSessionDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  intent?: string;
}

