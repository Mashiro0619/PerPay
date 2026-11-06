import { DatabaseSync, type DatabaseSyncOptions } from "node:sqlite";

/** Keep integrity-query intermediates under the same policy as the application. */
export function configureTemporaryStorage(connection: DatabaseSync): void {
  connection.exec("PRAGMA temp_store = MEMORY");
  const row = connection.prepare("PRAGMA temp_store").get() as { temp_store: bigint | number };
  if (Number(row.temp_store) !== 2) throw new Error("SQLite temp_store assertion failed: expected MEMORY");
}

export function openIntegrityDatabase(path: string, options: DatabaseSyncOptions): DatabaseSync {
  const connection = new DatabaseSync(path, options);
  try {
    configureTemporaryStorage(connection);
    return connection;
  } catch (error) {
    connection.close();
    throw error;
  }
}
