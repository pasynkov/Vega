import { Injectable, OnModuleInit } from "@nestjs/common";
import { Repository } from "typeorm";
import { createHash, randomUUID } from "node:crypto";
import { DbService } from "../db/db.module";
import { Memory, type MemoryType } from "./memory.entity";
import type { MemorySearchPort } from "../agents/supervisor/memory-search.port";

export interface SearchOpts {
  type?: MemoryType;
  limit?: number;
}

export interface WriteResult {
  id: string;
  deduplicated: boolean;
}

const DEFAULT_LIMIT = 20;

@Injectable()
export class MemoryService implements OnModuleInit, MemorySearchPort {
  private repo!: Repository<Memory>;

  constructor(private readonly db: DbService) {}

  onModuleInit(): void {
    this.repo = this.db.dataSource.getRepository(Memory);
  }

  async write(content: string, type: MemoryType, tags: string[] = []): Promise<WriteResult> {
    const normalized = normalize(content);
    const hash = sha256(normalized);
    const existing = await this.repo.findOne({ where: { contentHash: hash } });
    if (existing) {
      return { id: existing.id, deduplicated: true };
    }
    const row = this.repo.create({
      id: randomUUID(),
      content,
      type,
      tags,
      contentHash: hash,
      embedding: null,
    });
    await this.repo.save(row);
    return { id: row.id, deduplicated: false };
  }

  async search(query: string, opts: SearchOpts = {}): Promise<Memory[]> {
    const limit = opts.limit ?? DEFAULT_LIMIT;
    const tokens = tokenize(query);
    if (tokens.length === 0) return [];
    const qb = this.repo.createQueryBuilder("m");
    const tokenClauses = tokens.map((_, i) => `LOWER(m.content) LIKE :tok${i}`).join(" OR ");
    const tokenParams: Record<string, string> = {};
    tokens.forEach((tok, i) => {
      tokenParams[`tok${i}`] = `%${tok.toLowerCase()}%`;
    });
    qb.where(`(${tokenClauses})`, tokenParams);
    if (opts.type) {
      qb.andWhere("m.type = :type", { type: opts.type });
    }
    qb.orderBy("m.updatedAt", "DESC").limit(limit);
    return qb.getMany();
  }

  async searchTopK(query: string, k: number): Promise<Memory[]> {
    const rows = await this.search(query, { limit: k * 3 });
    const tokens = tokenize(query).map((t) => t.toLowerCase());
    const scored = rows.map((row) => {
      const lc = row.content.toLowerCase();
      let score = 0;
      for (const t of tokens) {
        if (lc.includes(t)) score += 1;
      }
      return { row, score };
    });
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.row.updatedAt.getTime() - a.row.updatedAt.getTime();
    });
    return scored.slice(0, k).map((s) => s.row);
  }

  async update(id: string, content: string): Promise<Memory> {
    const row = await this.repo.findOne({ where: { id } });
    if (!row) {
      throw new Error(`Memory ${id} not found`);
    }
    row.content = content;
    row.contentHash = sha256(normalize(content));
    await this.repo.save(row);
    return row;
  }

  async delete(id: string): Promise<void> {
    await this.repo.delete({ id });
  }
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

function tokenize(s: string): string[] {
  return s
    .split(/[^\p{L}\p{N}]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}
