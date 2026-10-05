import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { migrations } from "../src/database/migrations.ts";
import { MULTI_SITE_SCHEMA_SQL } from "../src/sites/migrations/schema.ts";
import { migrateSiteData } from "../src/sites/migrations/data.ts";
import { SiteStore } from "../src/sites/store.ts";

export function createSiteFixture() {
  const connection = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true, readBigInts: true });
  for (const migration of migrations) connection.exec(migration.sql);
  const instanceId = (connection.prepare("SELECT value FROM system_metadata WHERE key = 'instance_id'").get() as { value: string }).value;
  const masterKey = randomBytes(32);
  const owner = {
    instanceId: () => instanceId,
    read<T>(callback: (database: DatabaseSync) => T): T { return callback(connection); },
    write<T>(callback: (database: DatabaseSync) => T): T {
      connection.exec("BEGIN IMMEDIATE");
      try { const result = callback(connection); connection.exec("COMMIT"); return result; }
      catch (error) { if (connection.isTransaction) connection.exec("ROLLBACK"); throw error; }
    },
  };
  function migrate(key: Uint8Array | undefined = masterKey) {
    return owner.write(database => { database.exec(MULTI_SITE_SCHEMA_SQL); migrateSiteData(database, key); });
  }
  return { connection, masterKey, instanceId, owner, migrate, store: () => new SiteStore(owner, masterKey), close: () => connection.close() };
}
