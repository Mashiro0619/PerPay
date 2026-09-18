import { displaySettingsDowngradeSql } from "./display-schema-fixture.ts";

/** Test-only reconstruction of schema 22; never use as a production downgrade. */
export function administratorStateDowngradeSql(): string {
  return `
    ${displaySettingsDowngradeSql()}
    DROP TABLE IF EXISTS admin_refund_marks;
    DROP TABLE IF EXISTS admin_refund_mark_events;
    DROP TABLE IF EXISTS admin_work_item_states;
    DROP TABLE IF EXISTS admin_work_item_operations;
    DROP TABLE IF EXISTS admin_operation_log;
    DELETE FROM schema_migrations WHERE version = 23;
  `;
}
