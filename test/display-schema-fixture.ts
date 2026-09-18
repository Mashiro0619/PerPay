/** Test-only reconstruction of schema 23, never a production downgrade. */
export function displaySettingsDowngradeSql(): string {
  return `
    ALTER TABLE runtime_configuration DROP COLUMN dashboard_chart_type;
    ALTER TABLE runtime_configuration DROP COLUMN checkout_show_product_name;
    DELETE FROM schema_migrations WHERE version = 24;
  `;
}
