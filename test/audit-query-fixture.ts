import { DatabaseSync } from "node:sqlite";
import { migrations } from "../src/database/migrations.ts";
import { appendAuditEvent, type AuditInput } from "../src/database/identity-store.ts";
import { CORE_AUDIT_SCHEMA_SQL } from "../src/audit/core-schema.ts";
import { ACTIVITY_SCHEMA_SQL } from "../src/audit/activity-schema.ts";
import { createActivityEvent, persistActivityEvent, type ActivityEventInput } from "../src/audit/activity.ts";

export const AUDIT_TEST_NOW = Date.UTC(2026, 10, 1, 12);
export function auditQueryFixture(legacy?: AuditInput) {
  const connection = new DatabaseSync(":memory:", { readBigInts: true });
  connection.exec(migrations[0]!.sql);
  connection.exec(migrations[1]!.sql);
  const legacyEvent = legacy ? appendAuditEvent(connection, legacy) : null;
  connection.exec(CORE_AUDIT_SCHEMA_SQL + ACTIVITY_SCHEMA_SQL);
  const database = {
    read<T>(operation: (db: DatabaseSync) => T): T { return operation(connection); },
    write<T>(operation: (db: DatabaseSync) => T): T {
      connection.exec("BEGIN IMMEDIATE");
      try { const result = operation(connection); connection.exec("COMMIT"); return result; }
      catch (error) { connection.exec("ROLLBACK"); throw error; }
    },
  };
  return {
    connection, database, legacyEvent,
    core(input: Partial<AuditInput> = {}) {
      return database.write(db => appendAuditEvent(db, { occurredAt: AUDIT_TEST_NOW, actorType: "ADMIN", actorId: "admin", action: "settings.display_updated", outcome: "SUCCESS", ...input }));
    },
    activity(input: Partial<ActivityEventInput> = {}) {
      const event = createActivityEvent({ action: "http.request", sourceType: "HTTP", occurredAt: AUDIT_TEST_NOW, ...input }, AUDIT_TEST_NOW);
      database.write(db => persistActivityEvent(db, event));
      return event;
    },
    close() { connection.close(); },
  };
}
