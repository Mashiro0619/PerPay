// SPDX-License-Identifier: MIT
import { lstatSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const STORAGE_TABLES = [
  "payment_orders", "ledger_entries", "audit_events", "activity_events",
  "provider_raw_pages", "provider_raw_events", "ingest_run_page_observations", "ingest_runs", "ingest_segments", "ingest_errors",
  "ledger_request_checkpoints", "ledger_retention_state",
] as const;

export interface DatabaseStoragePages {
  readonly databaseBytes: number;
  readonly walBytes: number;
  readonly journalBytes: number;
  readonly totalBytes: number;
  readonly pageSize: number;
  readonly pageCount: number;
  readonly freePages: number;
  readonly usedBytes: number;
  readonly reclaimableBytes: number;
}

export interface DatabaseTableStorage {
  readonly name: string;
  readonly rows: number;
  readonly tableBytes: number | null;
  readonly indexBytes: number | null;
}

export interface DatabaseStorage extends DatabaseStoragePages {
  readonly dbstatAvailable: boolean;
  readonly tables: readonly DatabaseTableStorage[];
}

export function readDatabaseStoragePages(database: DatabaseSync, path: string): DatabaseStoragePages {
  const pageSize = Number(database.prepare("PRAGMA page_size").get()!.page_size);
  const pageCount = Number(database.prepare("PRAGMA page_count").get()!.page_count);
  const freePages = Number(database.prepare("PRAGMA freelist_count").get()!.freelist_count);
  const databaseBytes = fileBytes(path), walBytes = fileBytes(path + "-wal", true), journalBytes = fileBytes(path + "-journal", true);
  return {
    databaseBytes, walBytes, journalBytes, totalBytes: databaseBytes + walBytes + journalBytes,
    pageSize, pageCount, freePages, usedBytes: (pageCount - freePages) * pageSize, reclaimableBytes: freePages * pageSize,
  };
}

/** Counts and page allocation share one read snapshot, including committed WAL pages. */
export function inspectDatabaseStorage(path: string): DatabaseStorage {
  fileBytes(path);
  const database = new DatabaseSync(path, { readOnly: true, defensive: true, readBigInts: true, timeout: 5_000 });
  try {
    database.exec("BEGIN");
    const schema = database.prepare("SELECT name, tbl_name, type FROM sqlite_schema WHERE type IN ('table', 'index')").all();
    const tables = new Set(schema.filter(row => row.type === "table").map(row => String(row.name)));
    if (!tables.has("schema_migrations") || !tables.has("payment_orders")) throw new Error("storage inspection requires an existing PerPay database");
    const dbstatAvailable = database.prepare("SELECT 1 FROM pragma_module_list WHERE name = 'dbstat'").get() !== undefined;
    const allocations = dbstatAvailable
      ? new Map(database.prepare("SELECT name, pgsize FROM dbstat WHERE aggregate = TRUE").all().map(row => [String(row.name), Number(row.pgsize)]))
      : null;
    const result: DatabaseStorage = {
      ...readDatabaseStoragePages(database, path), dbstatAvailable,
      tables: STORAGE_TABLES.filter(name => tables.has(name)).map(name => ({
        name,
        rows: Number(database.prepare(`SELECT count(*) AS count FROM "${name}"`).get()!.count),
        tableBytes: allocations?.get(name) ?? (allocations ? 0 : null),
        indexBytes: allocations ? schema.filter(row => row.type === "index" && row.tbl_name === name)
          .reduce((sum, row) => sum + (allocations.get(String(row.name)) ?? 0), 0) : null,
      })),
    };
    database.exec("COMMIT");
    return result;
  } finally {
    database.close();
  }
}

function fileBytes(path: string, optional = false): number {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("database storage must use ordinary files with one link");
    return stat.size;
  } catch (error) {
    if (optional && error instanceof Error && "code" in error && error.code === "ENOENT") return 0;
    throw error;
  }
}
