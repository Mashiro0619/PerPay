import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { migrationChecksum, migrations } from "../src/database/migrations.ts";
import { DATABASE_COMPATIBILITY } from "../src/version.ts";

// Generated once with:
// node --experimental-strip-types --input-type=module -e "import { migrations, migrationChecksum } from './src/database/migrations.ts'; console.log(JSON.stringify(migrations.map(m => ({version:m.version,name:m.name,checksum:migrationChecksum(m)})),null,2))"
// Published migrations are immutable. Keep this prefix unchanged when appending migrations.
const publishedMigrations = [
  { version: 1, name: "initial_system_schema", checksum: "518bfb4254174d21918d7723ad3ec976e2b6fe1902ad88ed32c7aa5e2a5cdf5b" },
  { version: 2, name: "identity_and_audit_schema", checksum: "6c585aec183dd7b1035663a4f0fffb4ef85aac9ba1dfb32393cf1bd71386a98a" },
  { version: 3, name: "collection_and_order_schema", checksum: "0ec35d0e800c59e2c5b630ac3c676ee7ac3126711ba07e37c8906f5cfa8ea60d" },
  { version: 4, name: "ledger_ingestion_schema", checksum: "78f740efcaa27adb82d89373aea70812988ee3b11b846eb166381f4ea94835c7" },
  { version: 5, name: "reconciliation_and_financial_ledger_schema", checksum: "0f994dd0996190b54c0b7546470cd0c17706ea9fdc01644206a4120d85f9eaaf" },
  { version: 6, name: "reliable_webhook_delivery_schema", checksum: "aced95e151b19b3abe678d111762c6191b6509f1dba16a747e1acceb1e83ad8d" },
  { version: 7, name: "ledger_page_stability", checksum: "9fac51c9a6bf0dbefd3d534bb3b15c96bd719fee48b17dcaf92d9b79cefb0354" },
  { version: 8, name: "payment_match_settlement_history", checksum: "0891c21d638052c0b8c7f33f777225901e3f78be2fef703f54043628c7233139" },
  { version: 9, name: "audit_anchor_and_evidence_fingerprints", checksum: "c4887d64ba23405ad4fdc09fa1604af787789d0bff6dae3381d699dabf801c63" },
  { version: 10, name: "preserve_financial_state_during_provider_conflicts", checksum: "e56d84ac458f5b158e0a7d64b4d384976e50c9b74dd32429be9245257ddab36d" },
  { version: 11, name: "retain_api_client_key_history", checksum: "640589b6cb851f4294190448acb0b73f36e468e2f4b036fb1f602f31ba806dc1" },
  { version: 12, name: "version_checkout_token_keys", checksum: "90f7bc681d46ce3ca32eb8311f2c20c62649f46376b00fd5709a46e44de17678" },
  { version: 13, name: "ledger_conflict_operations", checksum: "5706a3dc31b61dfe2ab34a04fb6cbb95548c10fb89d6b037d40c10c070311801" },
  { version: 14, name: "provider_account_generations", checksum: "82fb196ac27170d6ac7c1c7e974a3fe6eb056016b3c10b37d699b052bde50dd3" },
  { version: 15, name: "configurable_provider_safety_lag", checksum: "2183d0ebd7b4fdba7f4318363d028a4867f0ad34567da7fa0acf81169f50cd33" },
  { version: 16, name: "order_product_name_and_note", checksum: "edecb25bfedde9f6f4e452235b6476b345e281927553a7cd21de5bf990de37fe" },
  { version: 17, name: "order_return_url", checksum: "6d0e480e49de705656cfac841736dab086ba443659006d4187aee6aca5a0e15a" },
  { version: 18, name: "configurable_backup_policy", checksum: "360ae490ea7ae20745b567c55449deba254f8d6a2971c44260375fea19a0d6fe" },
  { version: 19, name: "durable_ledger_compensation_state", checksum: "4247e98a28cb93786058abe581117cbe5ccb13bccbcd500c9751cd78ca89fb27" },
  { version: 20, name: "adaptive_ledger_scan_intervals", checksum: "d11aa94b0a78cdec9f955b48a5fe1bc518622022a6ccc71b5ffec4bb171dbac7" },
  { version: 21, name: "persistent_anonymous_password_budget", checksum: "f30afd3c5eef2897eaf1667c1ffb173a77ae5b2dd31a4c8f79ed3cd4e695366b" },
  { version: 22, name: "amount_reuse_cooldown", checksum: "c3b51aae60534d933132fc28d7219d76fa05d0b3c5cce712206ee0968bec9ec2" },
  { version: 23, name: "administrator_reminders_and_refund_marks", checksum: "995e5efbf13e65afb9783c1cfc919369d8555cc27e7b52ec06245746cc199b4d" },
  { version: 24, name: "checkout_and_dashboard_display_settings", checksum: "daa5772e8ff19af53e6b5df0547bacb1b88787b2f1f6a122a90327e366389086" },
  { version: 25, name: "administrator_order_delivery_query_indexes", checksum: "6d80ad9b9dca7b070168e2d8062d77aa423ecf4b6c2d738f7a5aa8547cc6c765" },
  { version: 26, name: "administrator_reconciliation_query_indexes", checksum: "cea0cc0baae517d12d8793685734d87628b01f67585b265fd788192d1325bff0" },
  { version: 27, name: "optional_manual_settlement_reason", checksum: "ddceb061c404dbcc093253572938ca9c5e961b4c037f64306ebc67e750477a97" },
  { version: 28, name: "provider_application_key_changes", checksum: "04766be1602ac862357cb242129eccf912a4316e2abc0d23e55b318717054619" },
  { version: 29, name: "separate_api_client_identity_from_credentials", checksum: "8014713ab9ab4e82c019c30c06ca1a80ad9c717738e76a9fa9347f2a1c30e0b9" },
  { version: 30, name: "custom_system_name", checksum: "4c051b3e4b3e918ccbbd8f4efd36d7ea21dc38d7ae54db4881174833f41dc74b" },
  { version: 31, name: "checkout_merchant_help_url", checksum: "75fd0203b371bef596d808642364cdf434c0b78a467fd2d7a6a123e71c5f28b6" },
  { version: 32, name: "admin_ip_allowlist", checksum: "ffbf465acb017637839cd0779687b7ddb3b19f20e504c89f3592b3b93f7bf45b" },
  { version: 33, name: "minimum_ledger_scan_interval", checksum: "04ab1165ca52d3b273480eac825897e92268f35c847adf784a2ab7634c5cba9a" },
  { version: 34, name: "multi_business_websites", checksum: "7ac86c4d948f23c6ee1986b362ba3f9347291f034426f05e0b15b53aa3e130ea" },
  { version: 35, name: "administrator_ledger_event_query_indexes", checksum: "89fca4d60ccb10b8d8b72031bb83b169615ee20223c988a9c7db3733332de42d" },
  { version: 36, name: "administrator_login_session_metadata", checksum: "a2d35803417119fecd066bd82805545b1ed46f9d37ee30257b2203f3ccfd19cb" },
  { version: 37, name: "multiple_alipay_accounts", checksum: "5e289d1b4609a1f491f5fd51f2e9b440c1fb8b2d553db19ec8025bde744811b7" },
  { version: 38, name: "alipay_account_deletion_tombstones", checksum: "77fb847341e01f35cbf3c45b6ee9533b0398780a312b70afe70c0fde6f68ce7a" },
] as const;

describe("published migration catalog", () => {
  it("preserves every released migration's version, name and checksum", () => {
    assert.deepEqual(migrations.slice(0, publishedMigrations.length).map(migration => ({
      version: migration.version,
      name: migration.name,
      checksum: migrationChecksum(migration),
    })), publishedMigrations);
  });

  it("keeps the database compatibility maximum at the last migration", () => {
    assert.equal(DATABASE_COMPATIBILITY.maximum, migrations.at(-1)?.version);
  });
});
