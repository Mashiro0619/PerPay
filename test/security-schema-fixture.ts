import { administratorStateDowngradeSql } from "./admin-state-schema-fixture.ts";

/** Reconstructs schema 20 in isolated tests; never a production rollback procedure. */
export function securityHardeningDowngradeSql(): string {
  return `
    ${administratorStateDowngradeSql()}
    DROP TRIGGER amount_slots_cooldown_guard;
    DROP TRIGGER payment_orders_cooldown_immutable;
    ALTER TABLE payment_orders DROP COLUMN amount_reuse_cooldown_seconds;
    ALTER TABLE runtime_configuration DROP COLUMN amount_reuse_cooldown_seconds;
    DROP TABLE anonymous_password_budget;
    DELETE FROM schema_migrations WHERE version > 20;
  `;
}
