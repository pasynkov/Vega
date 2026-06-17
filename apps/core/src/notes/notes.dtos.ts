import { IsString, MinLength } from "class-validator";

export class SaveShortNoteDto {
  @IsString()
  @MinLength(1)
  text!: string;
}

export class EnableLongNoteModeDto {
  // Marker DTO. Tools require non-empty schemas; the placeholder keeps the
  // boot smoke happy while expressing "no input expected".
  @IsString()
  @MinLength(0)
  intent!: string;
}

export class EndLongNoteModeDto {
  @IsString()
  @MinLength(1)
  cleanText!: string;
}
