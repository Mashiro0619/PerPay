import { createHash } from "node:crypto";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

/** Stable catalog checksum used to detect edited migration SQL at startup. */
export function migrationChecksum(migration: Pick<Migration, "version" | "name" | "sql">): string {
  return createHash("sha256")
    .update(`${migration.version}\0${migration.name}\0${migration.sql}`, "utf8")
    .digest("hex");
}

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "initial_system_schema",
    sql: `
      CREATE TABLE system_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      INSERT INTO system_metadata (key, value, updated_at)
      VALUES ('instance_id', lower(hex(randomblob(16))), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
    `,
  },
] as const;
