import { IsArray, IsIn, IsOptional, IsString, MinLength } from "class-validator";

const MEMORY_TYPES = ["behavioral", "factual", "episodic"] as const;
type MemoryTypeDto = (typeof MEMORY_TYPES)[number];

export class MemorySearchDto {
  @IsString()
  @MinLength(1)
  query!: string;

  @IsOptional()
  @IsIn(MEMORY_TYPES)
  type?: MemoryTypeDto;
}

export class MemoryWriteDto {
  @IsString()
  @MinLength(1)
  content!: string;

  @IsIn(MEMORY_TYPES)
  type!: MemoryTypeDto;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];
}

export class MemoryUpdateDto {
  @IsString()
  @MinLength(1)
  id!: string;

  @IsString()
  @MinLength(1)
  content!: string;
}

export class MemoryDeleteDto {
  @IsString()
  @MinLength(1)
  id!: string;
}

export class RememberDto {
  @IsString()
  @MinLength(1)
  fact!: string;
}
