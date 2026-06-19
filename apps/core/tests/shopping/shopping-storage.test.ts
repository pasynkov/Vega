import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DataSource } from "typeorm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShoppingItem } from "../../src/domains/shopping/shopping-item.entity";
import { ShoppingStorageService } from "../../src/domains/shopping/shopping-storage.service";
import { createDomainDataSource } from "../../src/integrations/database/domain-db.factory";

class StubLogger {
  info() {}
  warn() {}
  error() {}
  debug() {}
}

describe("ShoppingStorageService + DomainDbFactory", () => {
  let tmpDir: string;
  let ds: DataSource;
  let svc: ShoppingStorageService;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "shopping-test-"));
    ds = createDomainDataSource({
      name: "shopping",
      entities: [ShoppingItem],
      databasePath: join(tmpDir, "shopping.sqlite"),
    });
    await ds.initialize();
    svc = new ShoppingStorageService(new StubLogger() as any, ds.getRepository(ShoppingItem));
  });

  afterEach(async () => {
    if (ds.isInitialized) await ds.destroy();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("addOrUpdatePending inserts a new pending item", async () => {
    const item = await svc.addOrUpdatePending({ name: "молоко", quantity: 1, unit: "л", note: null });
    expect(item.id).toBeTruthy();
    expect(item.status).toBe("pending");
    expect(item.quantity).toBe(1);
    expect((await svc.listLive()).length).toBe(1);
  });

  it("addOrUpdatePending updates existing pending row by name (case-insensitive)", async () => {
    const first = await svc.addOrUpdatePending({ name: "молоко", quantity: 1, unit: "л", note: null });
    const second = await svc.addOrUpdatePending({ name: "МОЛОКО", quantity: 2, unit: "л", note: "холодное" });
    expect(second.id).toBe(first.id);
    expect(second.quantity).toBe(2);
    expect(second.note).toBe("холодное");
    expect((await svc.listLive()).length).toBe(1);
  });

  it("addOrUpdatePending inserts fresh pending alongside a bought row of the same name", async () => {
    const first = await svc.addOrUpdatePending({ name: "яйца", quantity: 10, unit: "шт", note: null });
    await svc.markBought(first.id);
    const second = await svc.addOrUpdatePending({ name: "яйца", quantity: 10, unit: "шт", note: null });
    expect(second.id).not.toBe(first.id);
    const live = await svc.listLive();
    expect(live.length).toBe(2);
  });

  it("softDelete removes from live and is idempotent", async () => {
    const item = await svc.addOrUpdatePending({ name: "хлеб", quantity: null, unit: null, note: null });
    const r1 = await svc.softDelete(item.id);
    expect(r1.changed).toBe(true);
    const r2 = await svc.softDelete(item.id);
    expect(r2.changed).toBe(false);
    expect((await svc.listLive()).length).toBe(0);
  });

  it("markBought is idempotent", async () => {
    const item = await svc.addOrUpdatePending({ name: "масло", quantity: null, unit: null, note: null });
    const r1 = await svc.markBought(item.id);
    expect(r1.changed).toBe(true);
    const r2 = await svc.markBought(item.id);
    expect(r2.changed).toBe(false);
  });

  it("clearAllLive soft-deletes every live row regardless of status", async () => {
    const a = await svc.addOrUpdatePending({ name: "1", quantity: null, unit: null, note: null });
    await svc.addOrUpdatePending({ name: "2", quantity: null, unit: null, note: null });
    await svc.addOrUpdatePending({ name: "3", quantity: null, unit: null, note: null });
    await svc.markBought(a.id);
    const result = await svc.clearAllLive();
    expect(result.count).toBe(3);
    expect((await svc.listLive()).length).toBe(0);
  });

  it("listLive sorts pending before bought; within each block by createdAt ASC", async () => {
    // Inserted A (pending), B (pending), C (pending) in order. Mark B
    // bought. Expected: A, C, B — pending block (A, C) sorted by
    // createdAt ASC, then bought block (B).
    const a = await svc.addOrUpdatePending({ name: "a-молоко", quantity: null, unit: null, note: null });
    // SQLite CreateDateColumn resolution is per-second; sleep briefly so
    // each row gets a strictly later createdAt and the ASC order is
    // deterministic.
    await new Promise((r) => setTimeout(r, 1100));
    const b = await svc.addOrUpdatePending({ name: "b-хлеб", quantity: null, unit: null, note: null });
    await new Promise((r) => setTimeout(r, 1100));
    const c = await svc.addOrUpdatePending({ name: "c-яйца", quantity: null, unit: null, note: null });
    await svc.markBought(b.id);
    const live = await svc.listLive();
    expect(live.map((it) => it.id)).toEqual([a.id, c.id, b.id]);
  });

  it("formatLabel renders name + quantity + unit, omits null fields", async () => {
    const milk = await svc.addOrUpdatePending({ name: "молоко", quantity: 2, unit: "л", note: null });
    expect(svc.formatLabel(milk)).toBe("молоко 2 л");
    const bread = await svc.addOrUpdatePending({ name: "хлеб", quantity: null, unit: null, note: null });
    expect(svc.formatLabel(bread)).toBe("хлеб");
    const butter = await svc.addOrUpdatePending({ name: "масло", quantity: 1, unit: "пачка", note: null });
    expect(svc.formatLabel(butter)).toBe("масло 1 пачка");
  });
});
