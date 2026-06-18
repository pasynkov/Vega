import { Global, Injectable, Module, OnApplicationShutdown, OnModuleInit } from "@nestjs/common";
import { DataSource } from "typeorm";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import type Database from "better-sqlite3";
import { EnvConfig } from "../../config/env";

@Injectable()
export class DbService implements OnModuleInit, OnApplicationShutdown {
  private _dataSource: DataSource | null = null;

  constructor(
    @InjectPinoLogger(DbService.name) private readonly logger: PinoLogger,
    private readonly env: EnvConfig,
  ) {}

  async onModuleInit(): Promise<void> {
    mkdirSync(dirname(this.env.vegaDbPath), { recursive: true });
    this._dataSource = new DataSource({
      type: "better-sqlite3",
      database: this.env.vegaDbPath,
      // After the refactor-backend-modules reorg this file lives at
      // src/integrations/database/, so "../**/*.entity.{ts,js}" used to
      // narrow the glob to src/integrations/** and miss every entity
      // outside that subtree (the Memory entity under tools/memory/, the
      // ConversationSessionRow entity under conversation/). Walk up two
      // levels so the glob lands at src/**/*.entity.{ts,js} again.
      entities: [__dirname + "/../../**/*.entity.{ts,js}"],
      synchronize: true,
      prepareDatabase: (db: Database.Database) => {
        db.pragma("journal_mode = WAL");
        db.pragma("busy_timeout = 5000");
      },
    });
    await this._dataSource.initialize();
    this.logger.info({ path: this.env.vegaDbPath }, "SQLite data source initialized (WAL mode)");
  }

  async onApplicationShutdown(): Promise<void> {
    if (this._dataSource?.isInitialized) {
      await this._dataSource.destroy();
      this.logger.info("SQLite data source closed");
    }
  }

  get dataSource(): DataSource {
    if (!this._dataSource) {
      throw new Error("DbService accessed before onModuleInit completed");
    }
    return this._dataSource;
  }
}

@Global()
@Module({
  providers: [DbService],
  exports: [DbService],
})
export class DbModule {}
