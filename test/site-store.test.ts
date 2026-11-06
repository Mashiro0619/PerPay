import assert from "node:assert/strict";
import crypto, { createHash, randomUUID } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { describe, it } from "node:test";
import { createSiteFixture } from "./site-fixture.ts";
import { SiteError } from "../src/sites/store.ts";
import { IdentityTransaction } from "../src/database/identity-store.ts";

const audit = { actorId: "admin" };
function prepared() {
  const f = createSiteFixture(); f.migrate(); const store = f.store();
  const input = () => ({ operation_id: randomUUID(), configuration: { name: "网站", accepting_orders: true, notifications_enabled: false, notification_origin: null, return_origin: null, policy: store.defaults().policy } });
  return { ...f, store, input };
}
describe("website transactional store", () => {
  it("retains legacy creation fingerprints and binds custom identities to their request", () => {
    const f = prepared();
    try {
      const automatic = f.input();
      const site = f.store.create(automatic, audit);
      const fingerprint = createHash("sha256").update(JSON.stringify(automatic.configuration)).digest("hex");
      assert.equal(f.connection.prepare("SELECT request_fingerprint FROM site_creation_requests WHERE operation_id = ?").get(automatic.operation_id)?.request_fingerprint, fingerprint);
      assert.equal(f.store.create(automatic, audit).clientId, site.clientId);
      assert.throws(() => f.store.create({ ...automatic, client_id: site.clientId }, audit), { code: "site_operation_conflict" });

      const custom = { ...f.input(), client_id: "Shop.One-2_A" };
      assert.equal(f.store.create(custom, audit).clientId, custom.client_id);
      assert.equal(f.store.create(custom, audit).clientId, custom.client_id);
      assert.throws(() => f.store.create({ ...custom, client_id: "Shop.Two" }, audit), { code: "site_operation_conflict" });
      assert.throws(() => f.store.create({ operation_id: custom.operation_id, configuration: custom.configuration }, audit), { code: "site_operation_conflict" });
      const lower = f.store.create({ ...f.input(), client_id: custom.client_id.toLowerCase() }, audit);
      assert.notEqual(lower.clientId, custom.client_id);
      assert.equal(f.connection.prepare("SELECT count(*) AS total FROM audit_events WHERE action='site.created'").get()?.total, 3n);
    } finally { f.close(); }
  });
  it("rejects occupied, deleted and historical client identities without retaining a failed request", () => {
    const f = prepared();
    try {
      const request = { ...f.input(), client_id: "Shop.Original" };
      const site = f.store.create(request, audit);
      const rejected = { ...f.input(), client_id: site.clientId };
      const snapshot = () => ["api_client_config", "sites", "site_creation_requests", "audit_events"].map(table => f.connection.prepare("SELECT * FROM " + table + " ORDER BY rowid").all());
      let before = snapshot();
      assert.throws(() => f.store.create(rejected, audit), { code: "site_client_id_conflict" });
      assert.deepEqual(snapshot(), before);
      f.store.delete(site.clientId, site.revision, audit);
      before = snapshot();
      assert.throws(() => f.store.create(rejected, audit), { code: "site_client_id_conflict" });
      assert.deepEqual(snapshot(), before);
      assert.notEqual(f.store.create(request, audit).deletedAt, null);
      assert.equal(f.store.create({ ...rejected, client_id: "Shop.Corrected" }, audit).clientId, "Shop.Corrected");

      new IdentityTransaction(f.connection).ensureApiClientIdentity("Legacy.Client", 1);
      f.connection.prepare("INSERT INTO api_client_idempotency_namespaces(client_id, namespace_id, recorded_at) VALUES ('default', 'Old.Namespace', 1)").run();
      for (const client_id of ["Legacy.Client", "Old.Namespace"]) {
        before = snapshot();
        assert.throws(() => f.store.create({ ...f.input(), client_id }, audit), { code: "site_client_id_conflict" });
        assert.deepEqual(snapshot(), before);
      }
    } finally { f.close(); }
  });
  it("refuses an automatically generated ID collision instead of adopting an existing identity", t => {
    const f = prepared();
    const uuid = "68cd261d-cdb0-4c99-8750-76dc2f22353d";
    try {
      const input = f.input();
      new IdentityTransaction(f.connection).ensureApiClientIdentity("site_" + uuid, 1);
      t.mock.method(crypto, "randomUUID", () => uuid);
      syncBuiltinESMExports();
      assert.throws(() => f.store.create(input, audit), { code: "site_client_id_conflict" });
      assert.equal(f.store.list().length, 0);
      assert.equal(f.connection.prepare("SELECT count(*) AS total FROM site_creation_requests").get()?.total, 0n);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      f.close();
    }
  });
  it("rolls back website identity and deletion when audit append fails", () => {
    const f = prepared();
    try {
      const snapshot = () => Object.fromEntries(["api_client_config", "api_client_keys", "sites", "site_creation_requests", "audit_events"].map(table =>
        [table, f.connection.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
      const fail = () => f.connection.exec("CREATE TEMP TRIGGER reject_site_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'injected site audit failure'); END;");
      const input = f.input(), beforeCreate = snapshot();
      fail(); assert.throws(() => f.store.create(input, audit), /injected site audit failure/);
      assert.deepEqual(snapshot(), beforeCreate);
      f.connection.exec("DROP TRIGGER reject_site_audit");
      const site = f.store.create(input, audit);
      f.store.rotateSecret(site.clientId, "api_secret", site.revision, audit);
      const beforeDelete = snapshot();
      fail(); assert.throws(() => f.store.delete(site.clientId, 1, audit), /injected site audit failure/);
      assert.deepEqual(snapshot(), beforeDelete); assert.ok(f.store.credential(site.clientId));
      f.connection.exec("DROP TRIGGER reject_site_audit");
      f.store.delete(site.clientId, 1, audit);
      assert.equal(f.store.credential(site.clientId), null);
    } finally { f.close(); }
  });
  it("creates two independent identities without changing instance settings", () => {
    const f = prepared();
    try {
      const before = f.connection.prepare("SELECT * FROM runtime_configuration").get();
      assert.deepEqual(f.store.list(), []);
      const a = f.store.create(f.input(), audit); const b = f.store.create(f.input(), audit);
      assert.notEqual(a.clientId, b.clientId);
      assert.equal(f.store.list().length, 2);
      assert.equal(f.store.credential(a.clientId), null);
      assert.deepEqual(f.connection.prepare("SELECT * FROM runtime_configuration").get(), before);
      assert.equal(f.connection.prepare("PRAGMA foreign_key_check").all().length, 0);
    } finally { f.close(); }
  });
  it("deduplicates creation and rejects changed payloads under the same operation", () => {
    const f = prepared();
    try {
      const input = f.input(); const a = f.store.create(input, audit);
      assert.equal(f.store.create(input, audit).clientId, a.clientId);
      assert.throws(() => f.store.create({ ...input, configuration: { ...input.configuration, name: "changed" } }, audit), (e: unknown) => e instanceof SiteError && e.code === "site_operation_conflict");
      assert.equal(f.store.list().length, 1);
      assert.equal(f.connection.prepare("SELECT count(*) AS total FROM audit_events WHERE action = 'site.created'").get()?.total, 1n);
    } finally { f.close(); }
  });
  it("updates defaults without mutating existing websites and rejects stale revisions", () => {
    const f = prepared();
    try {
      const a = f.store.create(f.input(), audit);
      const defaults = f.store.defaults(); defaults.policy.orders.order_ttl_seconds = 600;
      f.store.saveDefaults(defaults, audit);
      const b = f.store.create(f.input(), audit);
      assert.equal(f.store.get(a.clientId)?.configuration.policy.orders.order_ttl_seconds, 300);
      assert.equal(b.configuration.policy.orders.order_ttl_seconds, 600);
      assert.throws(() => f.store.saveDefaults(defaults, audit), SiteError);
    } finally { f.close(); }
  });
  it("rotates API credentials only for their own website; pause does not revoke", () => {
    const f = prepared();
    try {
      const a = f.store.create(f.input(), audit); const b = f.store.create(f.input(), audit);
      const ka = f.store.rotateSecret(a.clientId, "api_secret", 0, audit);
      const kb = f.store.rotateSecret(b.clientId, "api_secret", 0, audit);
      assert.notEqual(ka.secret, kb.secret);
      assert.equal(f.store.credential(a.clientId)?.secret, ka.secret);
      assert.equal(f.store.credential(b.clientId)?.secret, kb.secret);
      const rotated = f.store.rotateSecret(a.clientId, "api_secret", 1, audit);
      assert.equal(f.store.credential(a.clientId)?.keyVersion, 2);
      assert.equal(f.store.credential(b.clientId)?.keyVersion, 1);
      assert.throws(() => f.store.rotateSecret(a.clientId, "api_secret", 1, audit), SiteError);
      f.store.update(a.clientId, { revision: 2, configuration: { ...rotated.site.configuration, accepting_orders: false } }, audit);
      assert.equal(f.store.credential(a.clientId)?.secret, rotated.secret);
    } finally { f.close(); }
  });
  it("keeps global key references and independent website notification versions", () => {
    const f = prepared();
    try {
      const a = f.store.create(f.input(), audit); const b = f.store.create(f.input(), audit);
      f.store.rotateSecret(a.clientId, "webhook_secret", 0, audit);
      f.store.rotateSecret(b.clientId, "webhook_secret", 0, audit);
      f.store.rotateSecret(a.clientId, "webhook_secret", 1, audit);
      const rows = f.connection.prepare("SELECT client_id, key_version, site_key_version, retired_at FROM webhook_signing_keys ORDER BY key_version").all();
      assert.deepEqual(rows.map(r => [r.client_id, r.key_version, r.site_key_version]), [[a.clientId, 1n, 1n], [b.clientId, 2n, 1n], [a.clientId, 3n, 2n]]);
      assert.notEqual(rows[0]?.retired_at, null);
      assert.equal(rows[1]?.retired_at, null); assert.equal(rows[2]?.retired_at, null);
    } finally { f.close(); }
  });
  it("keeps notification rules on disable and requires a signing key to enable", () => {
    const f = prepared();
    try {
      const site = f.store.create(f.input(), audit);
      const configuration = { ...site.configuration, notifications_enabled: true, notification_origin: "https://notify.example.com", return_origin: "https://shop.example.com" };
      assert.throws(() => f.store.update(site.clientId, { revision: 0, configuration }, audit), SiteError);
      f.store.rotateSecret(site.clientId, "webhook_secret", 0, audit);
      f.store.update(site.clientId, { revision: 1, configuration }, audit);
      const disabled = f.store.update(site.clientId, { revision: 2, configuration: { ...configuration, notifications_enabled: false } }, audit);
      assert.equal(disabled.configuration.notification_origin, configuration.notification_origin);
      assert.ok(f.store.notificationSecret(site.clientId));
    } finally { f.close(); }
  });
  it("tombstones an empty site, invalidates credentials, and never recreates it on replay", () => {
    const f = prepared();
    try {
      const input = f.input(); const site = f.store.create(input, audit);
      f.store.rotateSecret(site.clientId, "api_secret", 0, audit);
      f.store.delete(site.clientId, 1, audit);
      assert.equal(f.store.credential(site.clientId), null);
      assert.equal(f.store.get(site.clientId), null);
      assert.deepEqual(f.store.list(), []);
      assert.notEqual(f.store.create(input, audit).deletedAt, null);
      assert.throws(() => f.store.rotateSecret(site.clientId, "api_secret", 2, audit), SiteError);
      assert.throws(() => f.connection.prepare("DELETE FROM sites WHERE client_id = ?").run(site.clientId));
      assert.throws(() => f.connection.prepare("DELETE FROM api_client_config WHERE client_id = ?").run(site.clientId));
    } finally { f.close(); }
  });
  it("does not return secrets when encrypted website ownership is forged", () => {
    const f = prepared();
    try {
      const a = f.store.create(f.input(), audit); const b = f.store.create(f.input(), audit);
      f.store.rotateSecret(a.clientId, "api_secret", 0, audit); f.store.rotateSecret(b.clientId, "api_secret", 0, audit);
      const encrypted = f.connection.prepare("SELECT nonce, ciphertext, authentication_tag FROM site_secrets WHERE client_id = ? AND secret_name = 'api_secret'").get(a.clientId)!;
      f.connection.exec("DROP TRIGGER site_secrets_version_guard");
      f.connection.prepare("UPDATE site_secrets SET nonce = ?, ciphertext = ?, authentication_tag = ? WHERE client_id = ? AND secret_name = 'api_secret'").run(encrypted.nonce!, encrypted.ciphertext!, encrypted.authentication_tag!, b.clientId);
      assert.throws(() => f.store.credential(b.clientId));
    } finally { f.close(); }
  });
});
