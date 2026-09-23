/** Test-only reconstruction of schema 23, never a production downgrade. */
export function displaySettingsDowngradeSql(): string {
  return `
    DROP INDEX IF EXISTS payment_matches_status_created_list_idx;
    DROP INDEX IF EXISTS ledger_conflicts_external_list_idx;
    DROP INDEX IF EXISTS webhook_deliveries_predecessor_list_idx;
    DELETE FROM schema_migrations WHERE version = 26;
    DROP INDEX IF EXISTS payment_orders_payable_list_idx;
    DROP INDEX IF EXISTS payment_orders_received_list_idx;
    DROP INDEX IF EXISTS webhook_deliveries_created_list_idx;
    DROP INDEX IF EXISTS webhook_deliveries_attempt_list_idx;
    DROP INDEX IF EXISTS webhook_deliveries_retry_list_idx;
    DELETE FROM schema_migrations WHERE version = 25;
    ALTER TABLE runtime_configuration DROP COLUMN dashboard_chart_type;
    ALTER TABLE runtime_configuration DROP COLUMN checkout_show_product_name;
    DELETE FROM schema_migrations WHERE version = 24;
  `;
}
