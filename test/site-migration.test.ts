import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { IdentityTransaction } from "../src/database/identity-store.ts";
import { RuntimeSecretCipher } from "../src/settings/crypto.ts";
import { fingerprintApiSecret } from "../src/identity/service.ts";
import { fingerprintSecret } from "../src/settings/model.ts";
import { countSiteDomainViolations } from "../src/sites/integrity.ts";
import { SiteSecretCipher } from "../src/sites/crypto.ts";
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
  it("rolls back all schema and data after failing midway through business-key re-encryption", t => {
    const f = seedLegacy();
    try {
      const beforeSchema = schema(f);
      const secrets = f.connection.prepare("SELECT * FROM runtime_secrets ORDER BY secret_name").all();
      const keys = f.connection.prepare("SELECT * FROM webhook_signing_keys").all();
      const original = SiteSecretCipher.prototype.encrypt;
      let calls = 0;
      const injected = t.mock.method(SiteSecretCipher.prototype, "encrypt", function(this: SiteSecretCipher, ...args: Parameters<SiteSecretCipher["encrypt"]>) {
        if (++calls === 2) {
          assert.equal(f.connection.prepare("SELECT count(*) AS n FROM site_secrets").get()?.n, 1n);
          throw new Error("injected second-key encryption failure");
        }
        return original.apply(this, args);
      });
      assert.throws(() => f.migrate(), /injected second-key/);
      assert.equal(calls, 2);
      assert.deepEqual(schema(f), beforeSchema);
      assert.deepEqual(f.connection.prepare("SELECT * FROM runtime_secrets ORDER BY secret_name").all(), secrets);
      assert.deepEqual(f.connection.prepare("SELECT * FROM webhook_signing_keys").all(), keys);
      assert.equal(f.connection.prepare("SELECT 1 FROM sqlite_temp_schema WHERE name LIKE 'perpay_v34_%'").get(), undefined);
      injected.mock.restore();
      f.migrate();
      assert.equal(f.store().credential("default")?.secret, f.api);
      assert.equal(f.store().notificationSecret("default"), f.webhook);
      assert.equal(countSiteDomainViolations(f.connection), 0);
    } finally { f.close(); }
  });
  it("preserves old credential history without enabling an API key whose material was never stored", () => {
    const f = createSiteFixture();
    try {
      f.owner.write(connection => new IdentityTransaction(connection).syncApiClient("default", "a".repeat(64), Date.now()));
      const history = f.connection.prepare("SELECT * FROM api_client_keys").all();
      f.migrate();
      assert.deepEqual(f.connection.prepare("SELECT * FROM api_client_keys").all(), history);
      assert.equal(f.store().credential("default"), null);
      assert.equal(f.connection.prepare("SELECT enabled FROM api_client_config").get()?.enabled, 0n);
      assert.equal(f.store().get("default")?.configuration.accepting_orders, true);
      assert.equal(countSiteDomainViolations(f.connection), 0);
    } finally { f.close(); }
  });
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

it("preserves a configured old website even when no API or notification key was ever issued", () => {
  const f = createSiteFixture();
  try {
    f.connection.prepare("UPDATE runtime_configuration SET revision = revision + 1, order_ttl_seconds = 450, system_name = '原来的收银台', updated_at = max(updated_at, ?) WHERE singleton_key = 1").run(Date.now());
    assert.equal(f.connection.prepare("SELECT count(*) AS total FROM api_client_config").get()?.total, 0n);
    const revisions = f.connection.prepare("SELECT revision, payment_revision FROM runtime_configuration").get();
    f.migrate();
    const site = f.store().get("default");
    assert.ok(site);
    assert.equal(site.configuration.policy.orders.order_ttl_seconds, 450);
    assert.equal(site.configuration.policy.display.checkout_name, "原来的收银台");
    assert.equal(f.store().credential("default"), null);
    assert.equal(f.store().notificationSecret("default"), null);
    assert.deepEqual(f.connection.prepare("SELECT revision, payment_revision FROM runtime_configuration").get(), revisions);
    assert.equal(countSiteDomainViolations(f.connection), 0);
  } finally { f.close(); }
});
