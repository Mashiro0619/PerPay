import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { IdentityTransaction } from "../src/database/identity-store.ts";
import { RuntimeSecretCipher } from "../src/settings/crypto.ts";
import { fingerprintApiSecret } from "../src/identity/service.ts";
import { fingerprintSecret } from "../src/settings/model.ts";
import { countSiteDomainViolations } from "../src/sites/integrity.ts";
import { createSiteFixture } from "./site-fixture.ts";

function seedLegacy() {
  const f = createSiteFixture();
  const cipher = new RuntimeSecretCipher(f.masterKey, f.instanceId);
  const now = Date.now();
  const guard = cipher.createGuard();
  f.connection.prepare("INSERT INTO runtime_master_key_guard(singleton_key, cipher_version, nonce, ciphertext, authentication_tag, created_at) VALUES (1, ?, ?, ?, ?, ?)").run(guard.cipherVersion, guard.nonce, guard.ciphertext, guard.authenticationTag, now);
  const api = randomBytes(32).toString("base64url"), webhook = randomBytes(32).toString("base64url");
  for (const [purpose, value, fingerprint] of [["api_secret", api, fingerprintApiSecret(api)], ["webhook_secret", webhook, fingerprintSecret(webhook, "webhook-signing-key")]] as const) {
    const encrypted = cipher.encrypt(purpose, 1, value);
    f.connection.prepare("INSERT INTO runtime_secrets(secret_name, secret_version, cipher_version, nonce, ciphertext, authentication_tag, secret_fingerprint, updated_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?)").run(purpose, encrypted.cipherVersion, encrypted.nonce, encrypted.ciphertext, encrypted.authenticationTag, fingerprint, now);
  }
  f.owner.write(connection => new IdentityTransaction(connection).syncApiClient("default", fingerprintApiSecret(api), now));
  f.connection.prepare("INSERT INTO webhook_signing_keys(key_version, key_id, secret_fingerprint, activated_at, retired_at) VALUES (1, ?, ?, ?, NULL)").run(randomUUID(), fingerprintSecret(webhook, "webhook-signing-key"), now);
  f.connection.prepare("UPDATE runtime_configuration SET revision = revision + 1, webhook_enabled = 1, webhook_allowed_origin = 'https://notify.example.com', updated_at = ? WHERE singleton_key = 1").run(now);
  return { ...f, api, webhook };
}
function schema(f: ReturnType<typeof createSiteFixture>) {
  return f.connection.prepare("SELECT type, name, sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type, name").all();
}
describe("multi-site schema migration", () => {
  it("creates no implicit default site in a fresh database", () => {
    const f = createSiteFixture();
    try {
      f.migrate();
      assert.deepEqual(f.store().list(), []);
      assert.equal(countSiteDomainViolations(f.connection), 0);
      assert.equal(f.connection.prepare("SELECT count(*) AS total FROM runtime_secrets").get()?.total, 0n);
      assert.equal(f.connection.prepare("SELECT 1 FROM sqlite_temp_schema WHERE name = 'perpay_v34_secrets'").get(), undefined);
    } finally { f.close(); }
  });
  it("preserves credentials, key references and revisions while moving old configuration", () => {
    const f = seedLegacy();
    try {
      const keys = f.connection.prepare("SELECT key_version, key_id, secret_fingerprint, activated_at, retired_at FROM webhook_signing_keys").all();
      const revisions = f.connection.prepare("SELECT revision, payment_revision FROM runtime_configuration").get();
      f.migrate(); const store = f.store();
      assert.equal(store.credential("default")?.secret, f.api);
      assert.equal(store.notificationSecret("default"), f.webhook);
      assert.equal(store.get("default")?.configuration.notification_origin, "https://notify.example.com");
      assert.equal(store.get("default")?.configuration.return_origin, "https://notify.example.com");
      assert.deepEqual(f.connection.prepare("SELECT key_version, key_id, secret_fingerprint, activated_at, retired_at FROM webhook_signing_keys").all(), keys);
      assert.deepEqual(f.connection.prepare("SELECT revision, payment_revision FROM runtime_configuration").get(), revisions);
      assert.equal(f.connection.prepare("SELECT count(*) AS total FROM runtime_secrets WHERE secret_name IN ('api_secret', 'webhook_secret')").get()?.total, 0n);
      const columns = f.connection.prepare("PRAGMA table_info(runtime_configuration)").all().map(row => row.name);
      for (const name of ["order_ttl_seconds", "amount_reuse_cooldown_seconds", "webhook_enabled", "checkout_help_url"]) assert.equal(columns.includes(name), false);
      assert.equal(countSiteDomainViolations(f.connection), 0);
    } finally { f.close(); }
  });
  it("rolls back the entire schema and ciphertext on a wrong master key", () => {
    const f = seedLegacy();
    try {
      const before = schema(f);
      const secrets = f.connection.prepare("SELECT * FROM runtime_secrets ORDER BY secret_name").all();
      assert.throws(() => f.migrate(randomBytes(32)), /MASTER_KEY/);
      assert.deepEqual(schema(f), before);
      assert.deepEqual(f.connection.prepare("SELECT * FROM runtime_secrets ORDER BY secret_name").all(), secrets);
      assert.equal(f.connection.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'sites'").get(), undefined);
      f.migrate();
      assert.equal(f.store().credential("default")?.secret, f.api);
    } finally { f.close(); }
  });
  it("requires a master key when a guard exists and never replaces a missing guard", () => {
    const f = seedLegacy();
    try {
      assert.throws(() => f.migrate(new Uint8Array()), /master key|MASTER_KEY/);
      f.connection.exec("DROP TRIGGER runtime_master_key_guard_no_delete; DELETE FROM runtime_master_key_guard;");
      assert.throws(() => f.migrate(), /guard is missing/);
      assert.equal(f.connection.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'sites'").get(), undefined);
    } finally { f.close(); }
  });
  it("keeps migrated and new website keys independent under integrity checks", () => {
    const f = seedLegacy();
    try {
      f.migrate(); const store = f.store();
      const b = store.create({ operation_id: randomUUID(), configuration: { name: "B", accepting_orders: true, notifications_enabled: false, notification_origin: null, return_origin: null, policy: store.defaults().policy } }, { actorId: "admin" });
      store.rotateSecret(b.clientId, "api_secret", 0, { actorId: "admin" });
      store.rotateSecret(b.clientId, "webhook_secret", 1, { actorId: "admin" });
      store.rotateSecret("default", "webhook_secret", 0, { actorId: "admin" });
      assert.equal(store.credential("default")?.secret, f.api);
      assert.equal(countSiteDomainViolations(f.connection), 0);
      assert.equal(f.connection.prepare("PRAGMA foreign_key_check").all().length, 0);
    } finally { f.close(); }
  });
  it("produces the same main schema with and without legacy data", () => {
    const empty = createSiteFixture(), old = seedLegacy();
    try {
      empty.migrate(); old.migrate();
      assert.deepEqual(schema(empty), schema(old));
    } finally { empty.close(); old.close(); }
  });
});
