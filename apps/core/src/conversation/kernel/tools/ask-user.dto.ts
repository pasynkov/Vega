import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from "class-validator";

export class AskUserDto {
  @IsString()
  @MinLength(1)
  @MaxLength(240)
  question!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  hint?: string;

  @IsOptional()
  @IsInt()
  @Min(1_000)
  @Max(30_000)
  captureMs?: number;
}
