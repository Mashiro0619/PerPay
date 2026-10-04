import { migrations } from "../src/database/migrations.ts";

/** Reconstructs schema 28 only in isolated tests with already-issued credentials. */
export function apiClientCredentialsDowngradeSql(): string {
  const initial = migrations.find((migration) => migration.version === 2)!.sql;
  const start = initial.indexOf("CREATE TABLE api_client_config (");
  const table = initial.slice(start, initial.indexOf(") STRICT;", start) + ") STRICT;".length);
  const history = migrations.find((migration) => migration.version === 11)!.sql;
  const trigger = history.slice(history.indexOf("CREATE TRIGGER api_client_config_key_transition"));
  return `
    SAVEPOINT api_client_credentials_downgrade;
    ALTER TABLE runtime_configuration DROP COLUMN admin_access;
    DELETE FROM schema_migrations WHERE version = 32;
    ALTER TABLE runtime_configuration DROP COLUMN checkout_help_url;
    DELETE FROM schema_migrations WHERE version = 31;
    ALTER TABLE runtime_configuration DROP COLUMN system_name;
    DELETE FROM schema_migrations WHERE version = 30;
    PRAGMA defer_foreign_keys = ON;
    CREATE TABLE api_client_config_v29 AS SELECT * FROM api_client_config;
    DROP TABLE api_client_config;
    ${table}
    INSERT INTO api_client_config SELECT * FROM api_client_config_v29;
    DROP TABLE api_client_config_v29;
    ${trigger}
    DELETE FROM schema_migrations WHERE version = 29;
    RELEASE api_client_credentials_downgrade;
  `;
}
