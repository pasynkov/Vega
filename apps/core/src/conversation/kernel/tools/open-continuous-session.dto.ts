import { IsString, MinLength } from "class-validator";

export class OpenContinuousSessionDto {
  // Marker DTO. Tools require non-empty schemas; the placeholder keeps the
  // boot smoke happy while expressing "no input expected" beyond a
  // free-form description of why the agent wants the continuous session.
  @IsString()
  @MinLength(0)
  intent!: string;
}
