import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DataSource } from "typeorm";
import { Memory } from "../../src/tools/memory/memory.entity";
import { MemoryService } from "../../src/tools/memory/memory.service";

function makeStubDb(ds: DataSource) {
  return {
    dataSource: ds,
  };
}

describe("MemoryService", () => {
  let ds: DataSource;
  let svc: MemoryService;

  beforeEach(async () => {
    ds = new DataSource({
      type: "better-sqlite3",
      database: ":memory:",
      entities: [Memory],
      synchronize: true,
    });
    await ds.initialize();
    svc = new MemoryService(makeStubDb(ds) as any);
    svc.onModuleInit();
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it("write returns a new id, second identical write deduplicates", async () => {
    const r1 = await svc.write("user prefers espresso", "behavioral", ["coffee"]);
    expect(r1.deduplicated).toBe(false);
    const r2 = await svc.write("USER prefers espresso   ", "behavioral", []);
    expect(r2.deduplicated).toBe(true);
    expect(r2.id).toBe(r1.id);
  });

  it("search by tokenized content matches", async () => {
    await svc.write("user prefers espresso", "behavioral");
    await svc.write("pyotr email is pyotr@example.com", "factual");
    const rows = await svc.search("espresso");
    expect(rows.length).toBe(1);
    expect(rows[0].content).toContain("espresso");
  });

  it("search filtered by type", async () => {
    await svc.write("user prefers espresso", "behavioral");
    await svc.write("user prefers tea", "factual");
    const rows = await svc.search("user prefers", { type: "factual" });
    expect(rows.length).toBe(1);
    expect(rows[0].type).toBe("factual");
  });

  it("searchTopK respects k and orders by relevance then updatedAt", async () => {
    await svc.write("coffee espresso latte", "behavioral");
    await new Promise((r) => setTimeout(r, 5));
    await svc.write("coffee", "behavioral");
    const rows = await svc.searchTopK("coffee espresso", 2);
    expect(rows.length).toBe(2);
    expect(rows[0].content).toContain("espresso");
  });

  it("update changes content and contentHash", async () => {
    const r = await svc.write("user likes oat milk", "behavioral");
    const updated = await svc.update(r.id, "user likes soy milk");
    expect(updated.content).toBe("user likes soy milk");
    const found = await svc.search("soy milk");
    expect(found.length).toBe(1);
  });

  it("delete on missing id resolves without throwing", async () => {
    await expect(svc.delete("nonexistent-uuid")).resolves.toBeUndefined();
  });
});
