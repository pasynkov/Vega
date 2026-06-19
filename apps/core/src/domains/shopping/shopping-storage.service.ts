import { Inject, Injectable } from "@nestjs/common";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { IsNull, Repository } from "typeorm";
import { v4 as uuidv4 } from "uuid";
import { ShoppingItem } from "./shopping-item.entity";

export const SHOPPING_ITEM_REPOSITORY = Symbol("SHOPPING_ITEM_REPOSITORY");

export interface ShoppingItemPayload {
  name: string;
  quantity: number | null;
  unit: string | null;
  note: string | null;
}

@Injectable()
export class ShoppingStorageService {
  constructor(
    @InjectPinoLogger(ShoppingStorageService.name) private readonly logger: PinoLogger,
    @Inject(SHOPPING_ITEM_REPOSITORY) private readonly repo: Repository<ShoppingItem>,
  ) {}

  // Upserts a pending row by case-insensitive name match. When a pending
  // row already exists, overwrites quantity/unit/note (any of which may
  // be null to clear). When no pending row exists, inserts a fresh one
  // — even if a bought row with the same name exists (the bought row
  // represents a closed prior purchase).
  async addOrUpdatePending(payload: ShoppingItemPayload): Promise<ShoppingItem> {
    const lowered = payload.name.trim().toLowerCase();
    const existing = await this.repo
      .createQueryBuilder("i")
      .where("LOWER(i.name) = :name", { name: lowered })
      .andWhere("i.status = :status", { status: "pending" })
      .andWhere("i.deletedAt IS NULL")
      .getOne();

    if (existing) {
      existing.quantity = payload.quantity;
      existing.unit = payload.unit;
      existing.note = payload.note;
      const saved = await this.repo.save(existing);
      this.logger.info({ id: saved.id, name: saved.name }, "shopping: pending updated");
      return saved;
    }

    const item = this.repo.create({
      id: uuidv4(),
      name: payload.name.trim(),
      note: payload.note,
      quantity: payload.quantity,
      unit: payload.unit,
      status: "pending",
      deletedAt: null,
    });
    const saved = await this.repo.save(item);
    this.logger.info({ id: saved.id, name: saved.name }, "shopping: pending inserted");
    return saved;
  }

  async listLive(): Promise<ShoppingItem[]> {
    // Order: pending block on top, bought block on the bottom; within
    // each block sort by createdAt ASC so newer entries land at the
    // bottom of their group. The status sort relies on alphabetical
    // ordering ("pending" > "bought") with DESC to put pending first.
    return this.repo.find({
      where: { deletedAt: IsNull() },
      order: { status: "DESC", createdAt: "ASC" },
    });
  }

  async markBought(id: string): Promise<{ changed: boolean }> {
    const item = await this.repo.findOne({ where: { id, deletedAt: IsNull() } });
    if (!item || item.status === "bought") return { changed: false };
    item.status = "bought";
    await this.repo.save(item);
    this.logger.info({ id }, "shopping: marked bought");
    return { changed: true };
  }

  async softDelete(id: string): Promise<{ changed: boolean }> {
    const item = await this.repo.findOne({ where: { id, deletedAt: IsNull() } });
    if (!item) return { changed: false };
    item.deletedAt = new Date();
    await this.repo.save(item);
    this.logger.info({ id }, "shopping: soft-deleted");
    return { changed: true };
  }

  async clearAllLive(): Promise<{ count: number }> {
    const result = await this.repo
      .createQueryBuilder()
      .update(ShoppingItem)
      .set({ deletedAt: new Date() })
      .where("deletedAt IS NULL")
      .execute();
    const count = result.affected ?? 0;
    this.logger.info({ count }, "shopping: cleared all live");
    return { count };
  }

  formatLabel(item: ShoppingItem): string {
    const parts: string[] = [item.name];
    if (item.quantity !== null) {
      parts.push(String(item.quantity));
    }
    if (item.unit !== null && item.unit.trim().length > 0) {
      parts.push(item.unit);
    }
    return parts.join(" ");
  }
}
