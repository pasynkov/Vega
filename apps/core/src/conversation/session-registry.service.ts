import { Injectable, OnModuleInit } from "@nestjs/common";
import { Repository } from "typeorm";
import { DbService } from "../integrations/database/db.module";
import { ConversationSessionRow } from "./session.entity";

export interface SessionMetadata {
  id: string;
  createdAt: Date;
  lastActiveAt: Date;
}

@Injectable()
export class SessionRegistry implements OnModuleInit {
  private repo!: Repository<ConversationSessionRow>;

  constructor(private readonly db: DbService) {}

  onModuleInit(): void {
    this.repo = this.db.dataSource.getRepository(ConversationSessionRow);
  }

  async get(sessionId: string): Promise<SessionMetadata | null> {
    const row = await this.repo.findOne({ where: { id: sessionId } });
    return row ? this.toMeta(row) : null;
  }

  async create(sessionId: string): Promise<SessionMetadata> {
    const row = this.repo.create({ id: sessionId });
    await this.repo.save(row);
    return this.toMeta(row);
  }

  async touch(sessionId: string): Promise<SessionMetadata> {
    let row = await this.repo.findOne({ where: { id: sessionId } });
    if (!row) {
      row = this.repo.create({ id: sessionId });
    }
    row.lastActiveAt = new Date();
    await this.repo.save(row);
    return this.toMeta(row);
  }

  async list(): Promise<SessionMetadata[]> {
    const rows = await this.repo.find({ order: { lastActiveAt: "DESC" } });
    return rows.map((r) => this.toMeta(r));
  }

  private toMeta(row: ConversationSessionRow): SessionMetadata {
    return { id: row.id, createdAt: row.createdAt, lastActiveAt: row.lastActiveAt };
  }
}
