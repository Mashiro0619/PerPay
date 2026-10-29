import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AppDatabase } from "../database/database.ts";
import { appendAuditEvent, IdentityTransaction } from "../database/identity-store.ts";
import { fingerprintApiSecret } from "../identity/service.ts";
import { fingerprintSecret, isCanonicalSecret } from "../settings/model.ts";
import type { SiteSecretPurpose } from "../settings/crypto.ts";
import type { SettingsAuditContext } from "../settings/store.ts";
import { SiteSecretCipher } from "./crypto.ts";
import {
  createSiteInputSchema, generateSiteClientId, siteClientIdSchema, siteConfigurationSchema,
  sitePolicySchema, updateSiteDefaultsInputSchema, updateSiteInputSchema,
  type SiteConfiguration, type SitePolicy, type SiteSnapshot,
} from "./model.ts";

type DatabaseOwner = Pick<AppDatabase, "read" | "write" | "instanceId">;
interface SiteRow {
  client_id: string; revision: number | bigint; configuration: string;
  created_at: number | bigint; updated_at: number | bigint; deleted_at: number | bigint | null;
}
interface SecretRow {
  secret_version: number | bigint; cipher_version: number | bigint; nonce: Uint8Array;
  ciphertext: Uint8Array; authentication_tag: Uint8Array; secret_fingerprint: string;
}
export type SiteErrorCode = "site_not_found" | "site_revision_conflict" | "site_operation_conflict" | "site_has_history" | "site_paused" | "site_order_limit_exceeded" | "site_secret_missing" | "site_collection_required" | "site_collection_invalid";
export class SiteError extends Error {
  readonly code: SiteErrorCode;
  readonly retryAfterSeconds: number | undefined;
  constructor(code: SiteErrorCode, message: string, retryAfterSeconds?: number) {
    super(message); this.name = "SiteError"; this.code = code; this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class SiteStore {
  readonly #database: DatabaseOwner;
  readonly #cipher: SiteSecretCipher;
  constructor(database: DatabaseOwner, masterKey: Uint8Array) {
    this.#database = database;
    this.#cipher = new SiteSecretCipher(masterKey, database.instanceId());
  }

  get(clientId: string): SiteSnapshot | null {
    siteClientIdSchema.parse(clientId);
    return this.#database.read(connection => readSite(connection, clientId));
  }

  list(afterClientId: string | null = null, limit = 100, search = ""): readonly SiteSnapshot[] {
    if (typeof search !== "string" || search.length > 128) throw new RangeError("website search is invalid");
    if (afterClientId !== null) siteClientIdSchema.parse(afterClientId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RangeError("website page limit is invalid");
    return this.#database.read(connection => (connection.prepare(
      "SELECT * FROM sites WHERE deleted_at IS NULL AND (? IS NULL OR client_id > ?) AND (? = '' OR instr(lower(client_id), lower(?)) > 0 OR instr(lower(json_extract(configuration, '$.name')), lower(?)) > 0) ORDER BY client_id LIMIT ?",
    ).all(afterClientId, afterClientId, search, search, search, limit) as unknown as SiteRow[]).map(mapSite));
  }

  checkOrderAdmission(clientId: string, now = Date.now()): void {
    siteClientIdSchema.parse(clientId);
    this.#database.read(connection => { assertSiteCanCreate(connection, clientId, now); });
  }

  defaults(): { revision: number; policy: SitePolicy } {
    return this.#database.read(readDefaults);
  }

  saveDefaults(input: unknown, audit: SettingsAuditContext, now = Date.now()): { revision: number; policy: SitePolicy } {
    const parsed = updateSiteDefaultsInputSchema.parse(input);
    return this.#database.write(connection => {
      const current = readDefaults(connection);
      checkRevision(current.revision, parsed.revision);
      const updated = connection.prepare(
        "UPDATE site_defaults SET revision = revision + 1, policy = ?, updated_at = max(updated_at, ?) WHERE singleton_key = 1 AND revision = ?",
      ).run(JSON.stringify(parsed.policy), now, parsed.revision);
      changed(updated.changes);
      auditSite(connection, audit, "site_defaults.updated", "defaults", now, { revision: parsed.revision + 1 });
      return readDefaults(connection);
    });
  }

  create(input: unknown, audit: SettingsAuditContext, now = Date.now()): SiteSnapshot {
    const parsed = createSiteInputSchema.parse(input);
    if (parsed.configuration.notifications_enabled) throw new SiteError("site_secret_missing", "请先创建网站并生成通知签名密钥，再开启通知。");
    const serialized = JSON.stringify(parsed.configuration);
    const fingerprint = createHash("sha256").update(serialized).digest("hex");
    return this.#database.write(connection => {
      const previous = connection.prepare("SELECT client_id, request_fingerprint FROM site_creation_requests WHERE operation_id = ?").get(parsed.operation_id) as { client_id: string; request_fingerprint: string } | undefined;
      if (previous) {
        if (previous.request_fingerprint !== fingerprint) throw new SiteError("site_operation_conflict", "创建请求已用于其他网站配置。");
        const row = connection.prepare("SELECT * FROM sites WHERE client_id = ?").get(previous.client_id) as unknown as SiteRow | undefined;
        if (!row) throw new Error("website creation record has no website");
        return mapSite(row);
      }
      const configuration = resolveSiteCollection(connection, parsed.configuration);
      const clientId = generateSiteClientId();
      new IdentityTransaction(connection).ensureApiClientIdentity(clientId, now);
      connection.prepare("INSERT INTO sites(client_id, revision, configuration, created_at, updated_at, deleted_at) VALUES (?, 0, ?, ?, ?, NULL)").run(clientId, JSON.stringify(configuration), now, now);
      connection.prepare("INSERT INTO site_creation_requests(operation_id, request_fingerprint, client_id, created_at) VALUES (?, ?, ?, ?)").run(parsed.operation_id, fingerprint, clientId, now);
      auditSite(connection, audit, "site.created", clientId, now, { revision: 0 });
      return requiredSite(connection, clientId);
    });
  }

  update(clientId: string, input: unknown, audit: SettingsAuditContext, now = Date.now()): SiteSnapshot {
    siteClientIdSchema.parse(clientId);
    const parsed = updateSiteInputSchema.parse(input);
    return this.#database.write(connection => {
      const current = requiredSite(connection, clientId);
      checkRevision(current.revision, parsed.revision);
      const configuration = resolveSiteCollection(connection, { ...parsed.configuration, collection: parsed.configuration.collection ?? current.configuration.collection });
      if (parsed.configuration.notifications_enabled && !readSecret(connection, clientId, "webhook_secret")) {
        throw new SiteError("site_secret_missing", "开启通知前请先生成通知签名密钥。");
      }
      changed(connection.prepare("UPDATE sites SET configuration = ?, revision = revision + 1, updated_at = max(updated_at, ?) WHERE client_id = ? AND revision = ? AND deleted_at IS NULL")
        .run(JSON.stringify(configuration), now, clientId, parsed.revision).changes);
      auditSite(connection, audit, "site.updated", clientId, now, { revision: parsed.revision + 1 });
      return requiredSite(connection, clientId);
    });
  }

  delete(clientId: string, revision: number, audit: SettingsAuditContext, now = Date.now()): void {
    siteClientIdSchema.parse(clientId);
    return this.#database.write(connection => {
      const current = requiredSite(connection, clientId);
      checkRevision(current.revision, revision);
      if (connection.prepare("SELECT 1 FROM payment_orders WHERE api_client_id = ? LIMIT 1").get(clientId)) {
        throw new SiteError("site_has_history", "有历史订单的网站不能删除，请使用暂停接单。");
      }
      connection.prepare("UPDATE api_client_config SET enabled = 0, updated_at = max(updated_at, ?) WHERE client_id = ?").run(now, clientId);
      changed(connection.prepare("UPDATE sites SET deleted_at = max(updated_at, ?), updated_at = max(updated_at, ?), revision = revision + 1 WHERE client_id = ? AND revision = ? AND deleted_at IS NULL")
        .run(now, now, clientId, revision).changes);
      auditSite(connection, audit, "site.deleted", clientId, now, { revision: revision + 1 });
    });
  }

  rotateSecret(clientId: string, purpose: SiteSecretPurpose, revision: number, audit: SettingsAuditContext, now = Date.now()): { site: SiteSnapshot; secret: string } {
    siteClientIdSchema.parse(clientId);
    if (purpose !== "api_secret" && purpose !== "webhook_secret") throw new RangeError("invalid website secret purpose");
    return this.#database.write(connection => {
      const current = requiredSite(connection, clientId);
      checkRevision(current.revision, revision);
      const previous = readSecret(connection, clientId, purpose);
      const version = previous ? integer(previous.secret_version) + 1 : 1;
      const secret = randomBytes(32).toString("base64url");
      const fingerprint = secretFingerprint(purpose, secret);
      const encrypted = this.#cipher.encrypt(clientId, purpose, version, secret);
      const writtenAt = Math.max(now, current.updatedAt);
      connection.prepare(
        "INSERT INTO site_secrets(client_id, secret_name, secret_version, cipher_version, nonce, ciphertext, authentication_tag, secret_fingerprint, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(client_id, secret_name) DO UPDATE SET secret_version = excluded.secret_version, cipher_version = excluded.cipher_version, nonce = excluded.nonce, ciphertext = excluded.ciphertext, authentication_tag = excluded.authentication_tag, secret_fingerprint = excluded.secret_fingerprint, updated_at = excluded.updated_at",
      ).run(clientId, purpose, version, encrypted.cipherVersion, encrypted.nonce, encrypted.ciphertext, encrypted.authenticationTag, fingerprint, writtenAt);
      if (purpose === "api_secret") new IdentityTransaction(connection).syncApiClient(clientId, fingerprint, writtenAt);
      else syncSiteSigningKey(connection, clientId, fingerprint, writtenAt);
      changed(connection.prepare("UPDATE sites SET revision = revision + 1, updated_at = ? WHERE client_id = ? AND revision = ? AND deleted_at IS NULL").run(writtenAt, clientId, revision).changes);
      auditSite(connection, audit, "site.secret_rotated", clientId, writtenAt, { purpose, revision: revision + 1, version });
      return { site: requiredSite(connection, clientId), secret };
    });
  }

  revealSecret(clientId: string, purpose: SiteSecretPurpose, audit: SettingsAuditContext, now = Date.now()): string {
    siteClientIdSchema.parse(clientId);
    return this.#database.write(connection => {
      requiredSite(connection, clientId);
      const row = readSecret(connection, clientId, purpose);
      if (!row) throw new SiteError("site_secret_missing", "尚未生成该网站的密钥。");
      const secret = this.#decrypt(clientId, purpose, row);
      auditSite(connection, audit, "site.secret_viewed", clientId, now, { purpose });
      return secret;
    });
  }

  credential(clientId: string): { clientId: string; keyVersion: number; secretFingerprint: string; secret: string } | null {
    if (!siteClientIdSchema.safeParse(clientId).success) return null;
    return this.#database.read(connection => {
      if (!readSite(connection, clientId)) return null;
      const active = new IdentityTransaction(connection).activeApiClient(clientId);
      if (!active?.enabled) return null;
      const row = readSecret(connection, clientId, "api_secret");
      if (!row || row.secret_fingerprint !== active.secretFingerprint) throw new Error("website API credential is inconsistent");
      return { clientId, keyVersion: active.keyVersion, secretFingerprint: active.secretFingerprint, secret: this.#decrypt(clientId, "api_secret", row) };
    });
  }

  nextNotificationSite(afterClientId: string | null, now: number): string | null {
    if (afterClientId !== null) siteClientIdSchema.parse(afterClientId);
    return this.#database.read(connection => {
      const row = connection.prepare(
        `SELECT site.client_id FROM sites AS site WHERE site.deleted_at IS NULL
          AND json_extract(site.configuration, '$.notifications_enabled') = 1
          AND (EXISTS (
            SELECT 1 FROM outbox_events AS event JOIN webhook_targets AS target ON target.order_id = event.aggregate_id
            WHERE target.api_client_id = site.client_id AND NOT EXISTS (
              SELECT 1 FROM webhook_deliveries WHERE outbox_event_id = event.outbox_event_id AND target_id = target.target_id AND generation = 1))
          OR EXISTS (
            SELECT 1 FROM webhook_deliveries AS delivery JOIN webhook_targets AS target ON target.target_id = delivery.target_id
            WHERE target.api_client_id = site.client_id AND (
              (delivery.status IN ('PENDING', 'RETRY_WAIT') AND delivery.next_attempt_at <= ?) OR
              (delivery.status = 'LEASED' AND delivery.lease_expires_at <= ?))))
          ORDER BY CASE WHEN ? IS NULL OR site.client_id > ? THEN 0 ELSE 1 END, site.client_id LIMIT 1`,
      ).get(now, now, afterClientId, afterClientId) as { client_id: string } | undefined;
      return row?.client_id ?? null;
    });
  }

  notificationSecret(clientId: string): string | null {
    return this.#database.read(connection => {
      if (!readSite(connection, clientId)) return null;
      const row = readSecret(connection, clientId, "webhook_secret");
      return row ? this.#decrypt(clientId, "webhook_secret", row) : null;
    });
  }

  #decrypt(clientId: string, purpose: SiteSecretPurpose, row: SecretRow): string {
    const plaintext = this.#cipher.decrypt(clientId, purpose, integer(row.secret_version), {
      cipherVersion: integer(row.cipher_version) as 1, nonce: Buffer.from(row.nonce), ciphertext: Buffer.from(row.ciphertext), authenticationTag: Buffer.from(row.authentication_tag),
    });
    try {
      const value = plaintext.toString("utf8");
      if (!isCanonicalSecret(value) || secretFingerprint(purpose, value) !== row.secret_fingerprint) throw new Error("website secret fingerprint is invalid");
      return value;
    } finally { plaintext.fill(0); }
  }
}

export function readSite(connection: DatabaseSync, clientId: string): SiteSnapshot | null {
  const row = connection.prepare("SELECT * FROM sites WHERE client_id = ? AND deleted_at IS NULL").get(clientId) as unknown as SiteRow | undefined;
  return row ? mapSite(row) : null;
}
export function assertSiteCanCreate(connection: DatabaseSync, clientId: string, now: number): SiteConfiguration {
  const site = requiredSite(connection, clientId);
  if (!site.configuration.accepting_orders) throw new SiteError("site_paused", "该网站已暂停接收新订单。");
  const limit = site.configuration.policy.orders.pending_order_limit;
  if (limit !== null) {
    const row = connection.prepare("SELECT count(*) AS total, min(expires_at) AS earliest_expiry FROM payment_orders WHERE api_client_id = ? AND checkout_status = 'OPEN' AND payment_status = 'UNPAID' AND expires_at > ?").get(clientId, now) as { total: number | bigint; earliest_expiry: number | bigint | null };
    if (Number(row.total) >= limit) throw new SiteError("site_order_limit_exceeded", "该网站待付款订单已达到上限。", row.earliest_expiry === null ? undefined : Math.max(1, Math.ceil((Number(row.earliest_expiry) - now) / 1000)));
  }
  return site.configuration;
}
function requiredSite(connection: DatabaseSync, clientId: string): SiteSnapshot {
  const site = readSite(connection, clientId);
  if (!site) throw new SiteError("site_not_found", "业务网站不存在。");
  return site;
}
function mapSite(row: SiteRow): SiteSnapshot {
  return { clientId: row.client_id, revision: integer(row.revision), configuration: siteConfigurationSchema.parse(JSON.parse(row.configuration)), createdAt: integer(row.created_at), updatedAt: integer(row.updated_at), deletedAt: row.deleted_at === null ? null : integer(row.deleted_at) };
}
function resolveSiteCollection(connection: DatabaseSync, configuration: SiteConfiguration): SiteConfiguration {
  if (!connection.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'alipay_accounts'").get()) return configuration;
  let collection = configuration.collection;
  if (!collection) {
    const rows = connection.prepare("SELECT account_id FROM alipay_accounts WHERE enabled = 1 ORDER BY account_id LIMIT 2").all() as Array<{ account_id: string }>;
    if (rows.length !== 1) throw new SiteError("site_collection_required", "请为网站选择收款账号。");
    collection = { mode: "FIXED", accounts: [{ account_id: rows[0]!.account_id, weight: 1 }] };
  }
  for (const account of collection.accounts) {
    if (!connection.prepare("SELECT 1 FROM alipay_accounts WHERE account_id = ?").get(account.account_id)) {
      throw new SiteError("site_collection_invalid", "所选收款账号不存在，请重新选择。");
    }
  }
  return { ...configuration, collection };
}
function readDefaults(connection: DatabaseSync): { revision: number; policy: SitePolicy } {
  const row = connection.prepare("SELECT revision, policy FROM site_defaults WHERE singleton_key = 1").get() as { revision: number | bigint; policy: string } | undefined;
  if (!row) throw new Error("website defaults are missing");
  return { revision: integer(row.revision), policy: sitePolicySchema.parse(JSON.parse(row.policy)) };
}
function readSecret(connection: DatabaseSync, clientId: string, purpose: SiteSecretPurpose): SecretRow | undefined {
  return connection.prepare("SELECT * FROM site_secrets WHERE client_id = ? AND secret_name = ?").get(clientId, purpose) as unknown as SecretRow | undefined;
}
function integer(value: number | bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error("invalid website integer");
  return result;
}
function checkRevision(actual: number, expected: number): void {
  if (!Number.isSafeInteger(expected) || expected < 0 || actual !== expected) throw new SiteError("site_revision_conflict", "网站配置已变更，请刷新后重试。");
}
function changed(changes: number | bigint): void {
  if (Number(changes) !== 1) throw new SiteError("site_revision_conflict", "网站配置已变更，请刷新后重试。");
}
function secretFingerprint(purpose: SiteSecretPurpose, value: string): string {
  return purpose === "api_secret" ? fingerprintApiSecret(value) : fingerprintSecret(value, "webhook-signing-key");
}
function auditSite(connection: DatabaseSync, audit: SettingsAuditContext, action: string, clientId: string, now: number, details: Record<string, unknown>): void {
  appendAuditEvent(connection, { occurredAt: now, actorType: "ADMIN", actorId: audit.actorId, action, outcome: "SUCCESS", subjectType: "website", subjectId: clientId, requestId: audit.requestId, remoteAddressHash: audit.remoteAddressHash, details });
}
export function syncSiteSigningKey(connection: DatabaseSync, clientId: string, fingerprint: string, now: number): void {
  const active = connection.prepare("SELECT key_version, site_key_version, secret_fingerprint, activated_at FROM webhook_signing_keys WHERE client_id = ? AND retired_at IS NULL").get(clientId) as { key_version: number | bigint; site_key_version: number | bigint; secret_fingerprint: string; activated_at: number | bigint } | undefined;
  if (active?.secret_fingerprint === fingerprint) return;
  const timestamp = Math.max(now, active ? integer(active.activated_at) : now);
  if (active) connection.prepare("UPDATE webhook_signing_keys SET retired_at = ? WHERE key_version = ? AND client_id = ? AND retired_at IS NULL").run(timestamp, active.key_version, clientId);
  const next = connection.prepare("SELECT coalesce(max(key_version), 0) + 1 AS version FROM webhook_signing_keys").get() as { version: number | bigint };
  connection.prepare("INSERT INTO webhook_signing_keys(client_id, site_key_version, key_version, key_id, secret_fingerprint, activated_at, retired_at) VALUES (?, ?, ?, ?, ?, ?, NULL)").run(clientId, active ? integer(active.site_key_version) + 1 : 1, next.version, randomUUID(), fingerprint, timestamp);
}
