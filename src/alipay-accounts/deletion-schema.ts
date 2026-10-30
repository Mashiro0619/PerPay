/** Schema 38: deleted accounts retain the ownership of immutable collection evidence. */
export const ALIPAY_ACCOUNT_DELETION_SCHEMA_SQL = String.raw`
ALTER TABLE alipay_accounts ADD COLUMN deleted_at INTEGER
 CHECK(deleted_at IS NULL OR (deleted_at >= created_at AND deleted_at = updated_at
   AND enabled = 0 AND code_payload IS NULL AND app_id IS NULL AND provider_account_key IS NULL));

CREATE TRIGGER alipay_accounts_deletion_guard BEFORE UPDATE OF deleted_at ON alipay_accounts
WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL AND (
 EXISTS(SELECT 1 FROM payment_orders WHERE alipay_account_id = OLD.account_id)
 OR EXISTS(SELECT 1 FROM ledger_entries AS entry JOIN alipay_account_generations AS generation USING(provider_account_key)
   WHERE generation.account_id = OLD.account_id)
 OR EXISTS(SELECT 1 FROM sites AS site, json_each(site.configuration, '$.collection.accounts') AS selected
   WHERE site.deleted_at IS NULL AND json_extract(selected.value, '$.account_id') = OLD.account_id))
BEGIN SELECT RAISE(ABORT, 'used Alipay accounts cannot be deleted'); END;

CREATE TRIGGER alipay_accounts_deleted_immutable BEFORE UPDATE ON alipay_accounts
WHEN OLD.deleted_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'deleted Alipay account evidence is immutable'); END;

CREATE TRIGGER alipay_accounts_no_delete BEFORE DELETE ON alipay_accounts
BEGIN SELECT RAISE(ABORT, 'Alipay account ownership evidence cannot be deleted'); END;
`;
