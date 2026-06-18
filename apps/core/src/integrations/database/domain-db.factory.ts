import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DataSource, DataSourceOptions } from "typeorm";
import type Database from "better-sqlite3";

// Resolve the project root by walking up from this file looking for a
// `.git` directory. Falls back to process.cwd() if not found. Mirrors
// the convention used by other parts of the codebase that need an
// "output/" path anchored at the repo root.
function findProjectRoot(): string {
  let cursor = __dirname;
  for (let depth = 0; depth < 10; depth++) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require("node:fs") as typeof import("node:fs");
      if (fs.existsSync(resolve(cursor, ".git"))) return cursor;
    } catch {
      // ignore
    }
    cursor = resolve(cursor, "..");
  }
  return process.cwd();
}

export interface CreateDomainDataSourceArgs {
  /** Domain name used as the SQLite filename: `output/db/<name>.sqlite`. */
  name: string;
  /** Entity classes registered with the DataSource. */
  entities: DataSourceOptions["entities"];
  /** Optional explicit path override (e.g. for tests). */
  databasePath?: string;
}

// Provisions an isolated SQLite DataSource for a domain. Each domain
// that calls this gets its own file under `output/db/<name>.sqlite` —
// distinct from the shared `vega.sqlite` that lives at
// `output/recordings/vega.sqlite`. Pragmas mirror the shared DbService
// (WAL + 5 s busy timeout) so domain DBs have the same resilience
// profile. The caller owns the DataSource lifecycle (initialize at
// module init, destroy on shutdown).
export function createDomainDataSource(args: CreateDomainDataSourceArgs): DataSource {
  const path = args.databasePath ?? resolve(findProjectRoot(), "output", "db", `${args.name}.sqlite`);
  mkdirSync(dirname(path), { recursive: true });
  return new DataSource({
    type: "better-sqlite3",
    database: path,
    entities: args.entities,
    synchronize: true,
    prepareDatabase: (db: Database.Database) => {
      db.pragma("journal_mode = WAL");
      db.pragma("busy_timeout = 5000");
    },
  });
}
