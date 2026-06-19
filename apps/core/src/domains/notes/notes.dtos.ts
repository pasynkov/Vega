import { IsIn, IsString, MinLength } from "class-validator";

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
