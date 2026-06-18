import { IsIn, IsString, MinLength } from "class-validator";

export class SaveShortNoteDto {
  @IsString()
  @MinLength(1)
  text!: string;
}

export class BeginDictationDto {
  // Marker DTO. Tools require non-empty schemas; the placeholder keeps the
  // boot smoke happy while expressing "no input expected".
  @IsString()
  @MinLength(0)
  intent!: string;
}

export class FinalizeNoteDto {
  @IsString()
  @MinLength(1)
  cleanText!: string;
}

export class DiscardNoteDto {
  @IsString()
  @IsIn(["user", "noise", "off-topic", "other"])
  reason!: "user" | "noise" | "off-topic" | "other";
}
