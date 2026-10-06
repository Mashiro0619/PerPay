import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { createSiteFixture } from "./site-fixture.ts";
import { SiteError } from "../src/sites/store.ts";

const audit = { actorId: "admin" };
function prepared() {
  const f = createSiteFixture(); f.migrate(); const store = f.store();
  const input = () => ({ operation_id: randomUUID(), configuration: { name: "网站", accepting_orders: true, notifications_enabled: false, notification_origin: null, return_origin: null, policy: store.defaults().policy } });
  return { ...f, store, input };
}
describe("website transactional store", () => {
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
