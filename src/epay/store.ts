// SPDX-License-Identifier: MIT
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AppDatabase } from "../database/database.ts";
import { appendAuditEvent } from "../database/identity-store.ts";
import { auditSiteContext, redactedAuditChange } from "../audit/context.ts";
import { RuntimeSecretCipher } from "../settings/crypto.ts";
import { ensureRuntimeMasterKeyGuard } from "../settings/master-key-guard.ts";
import { fingerprintSecret, isCanonicalSecret } from "../settings/model.ts";
import { fingerprintApiSecret } from "../identity/service.ts";
import type { SettingsAuditContext } from "../settings/store.ts";
import { SiteSecretCipher } from "../sites/crypto.ts";
import { siteClientIdSchema, type SiteSnapshot } from "../sites/model.ts";
import { readSite, SiteError } from "../sites/store.ts";
import {
  epayConfigurationInputSchema,
  type EpayCredentialPurpose,
  type EpayCredentials,
  type EpayExportInput,
  type EpayExportSnapshot,
  type EpayOrderMetadata,
  type EpayProtocol,
  type EpaySiteSnapshot,
  type InsertEpayOrderInput,
} from "./model.ts";

export type { EpayCredentials, EpaySiteSnapshot, EpayOrderMetadata, EpayCredentialPurpose } from "./model.ts";
type DatabaseOwner = Pick<AppDatabase, "read" | "write" | "instanceId">;
interface EpaySiteRow {
  pid: number | bigint; site_id: string; revision: number | bigint;
  v1_enabled: number | bigint; v2_enabled: number | bigint; updated_at: number | bigint;
}
interface CredentialRow {
  credential_id: string; site_id: string; purpose: EpayCredentialPurpose;
  key_version: number | bigint; fingerprint: string; public_key: string | null;
  public_fingerprint: string | null; cipher_version: number | bigint;
  nonce: Uint8Array; ciphertext: Uint8Array; authentication_tag: Uint8Array;
  created_at: number | bigint;
}
interface OrderRow {
  order_id: string; site_id: string; pid: number | bigint; trade_no: number | bigint;
  protocol: EpayProtocol; param: string | null; request_fingerprint: string;
  return_url: string | null; created_at: number | bigint;
}
interface NativeSecretRow {
  secret_version: number | bigint; cipher_version: number | bigint;
  secret_fingerprint: string;
  nonce: Uint8Array; ciphertext: Uint8Array; authentication_tag: Uint8Array;
}

export type EpayErrorCode = "epay_revision_conflict" | "epay_secret_missing" | "epay_not_configured" | "epay_order_conflict";
export class EpayError extends Error {
  readonly code: EpayErrorCode;
  constructor(code: EpayErrorCode, message: string) {
    super(message);
    this.name = "EpayError";
    this.code = code;
  }
}

export class EpayStore {
  readonly #database: DatabaseOwner;
  readonly #cipher: RuntimeSecretCipher;
  readonly #siteCipher: SiteSecretCipher;

  constructor(database: DatabaseOwner, masterKey: Uint8Array) {
    this.#database = database;
    this.#cipher = new RuntimeSecretCipher(masterKey, database.instanceId());
    this.#siteCipher = new SiteSecretCipher(masterKey, database.instanceId());
  }

  available(): boolean { return this.#database.read(hasEpaySchema); }

  initializeDefaults(connection: DatabaseSync, now = Date.now()): void {
    if (!hasEpaySchema(connection)) return;
    const sites = connection.prepare(`SELECT epay.site_id FROM epay_sites AS epay
      JOIN sites AS site ON site.client_id = epay.site_id
      WHERE site.deleted_at IS NULL AND epay.revision = 0
        AND NOT EXISTS (SELECT 1 FROM epay_credentials WHERE site_id = epay.site_id)
      ORDER BY epay.pid`).all() as Array<{ site_id: string }>;
    for (const site of sites) this.initializeSite(connection, site.site_id, undefined, now);
  }

  initializeSite(connection: DatabaseSync, siteId: string, audit?: SettingsAuditContext, now = Date.now()): boolean {
    if (!connection.isTransaction) throw new Error("epay defaults require the website transaction");
    if (!hasEpaySchema(connection)) return false;
    const site = readSite(connection, siteId);
    if (!site) return false;
    const current = requiredConfiguration(connection, siteId);
    if (safeInteger(current.revision) !== 0 || connection.prepare("SELECT 1 FROM epay_credentials WHERE site_id = ? LIMIT 1").get(siteId)) return false;
    const writtenAt = Math.max(safeInteger(current.updated_at), validTime(now));
    ensureRuntimeMasterKeyGuard(connection, this.#cipher, writtenAt);
    for (const purpose of ["v1_key", "v2_merchant", "v2_platform"] as const) {
      this.#rotateCredential(connection, siteId, purpose, audit, writtenAt);
    }
    connection.prepare(`UPDATE epay_sites SET v1_enabled = 1, v2_enabled = 1,
      revision = revision + 1, updated_at = ? WHERE site_id = ?`).run(writtenAt, siteId);
    recordAudit(connection, audit, siteId, "epay.configuration_updated", writtenAt,
      { revision: 1, v1_enabled: true, v2_enabled: true, defaults_initialized: true });
    return true;
  }

  get(siteId: string): EpaySiteSnapshot {
    siteClientIdSchema.parse(siteId);
    return this.#database.read(connection => snapshot(connection, requiredSite(connection, siteId)));
  }

  update(siteId: string, input: unknown, audit: SettingsAuditContext, now = Date.now()): EpaySiteSnapshot {
    siteClientIdSchema.parse(siteId);
    const parsed = epayConfigurationInputSchema.parse(input);
    return this.#database.write(connection => {
      const site = requiredSite(connection, siteId);
      const current = requiredConfiguration(connection, siteId);
      checkRevision(current, parsed.revision);
      const writtenAt = Math.max(safeInteger(current.updated_at), validTime(now));
      if (parsed.v1_enabled && !readCredential(connection, siteId, "v1_key")) {
        this.#rotateCredential(connection, siteId, "v1_key", audit, writtenAt);
      }
      if (parsed.v2_enabled) {
        for (const purpose of ["v2_merchant", "v2_platform"] as const) {
          if (!readCredential(connection, siteId, purpose)) this.#rotateCredential(connection, siteId, purpose, audit, writtenAt);
        }
      }
      connection.prepare("UPDATE epay_sites SET v1_enabled = ?, v2_enabled = ?, revision = revision + 1, updated_at = ? WHERE site_id = ? AND revision = ?")
        .run(Number(parsed.v1_enabled), Number(parsed.v2_enabled), writtenAt, siteId, parsed.revision);
      recordAudit(connection, audit, siteId, "epay.configuration_updated", writtenAt,
        { revision: parsed.revision + 1, v1_enabled: parsed.v1_enabled, v2_enabled: parsed.v2_enabled });
      return snapshot(connection, site);
    });
  }

  rotate(siteId: string, purpose: EpayCredentialPurpose, revision: number, audit: SettingsAuditContext, now = Date.now()): {
    configuration: EpaySiteSnapshot; credentials: EpayCredentials;
  } {
    siteClientIdSchema.parse(siteId);
    requirePurpose(purpose);
    return this.#database.write(connection => {
      const site = requiredSite(connection, siteId);
      const current = requiredConfiguration(connection, siteId);
      checkRevision(current, revision);
      const writtenAt = Math.max(safeInteger(current.updated_at), validTime(now));
      this.#rotateCredential(connection, siteId, purpose, audit, writtenAt);
      connection.prepare("UPDATE epay_sites SET revision = revision + 1, updated_at = ? WHERE site_id = ?").run(writtenAt, siteId);
      return { configuration: snapshot(connection, site), credentials: this.#credentials(connection, site) };
    });
  }

  reveal(siteId: string, purpose: EpayCredentialPurpose, audit: SettingsAuditContext, now = Date.now()): {
    purpose: EpayCredentialPurpose; keyId: string; keyVersion: number; fingerprint: string; secret: string; publicKey: string | null;
  } {
    siteClientIdSchema.parse(siteId);
    requirePurpose(purpose);
    return this.#database.write(connection => {
      requiredSite(connection, siteId);
      const row = readCredential(connection, siteId, purpose);
      if (!row) throw new EpayError("epay_secret_missing", "尚未生成该易支付密钥。");
      const secret = this.#decrypt(row);
      recordAudit(connection, audit, siteId, "epay.secret_viewed", validTime(now), { purpose, key_version: safeInteger(row.key_version) });
      return { purpose, keyId: row.credential_id, keyVersion: safeInteger(row.key_version), fingerprint: row.fingerprint, secret, publicKey: row.public_key };
    });
  }

  credential(pid: string, options: { protocol?: EpayProtocol; forCreation?: boolean } = {}): EpayCredentials | null {
    if (!canonicalNumber(pid)) return null;
    return this.#database.read(connection => {
      const row = connection.prepare("SELECT site_id FROM epay_sites WHERE pid = ?").get(pid) as { site_id: string } | undefined;
      const site = row ? readSite(connection, row.site_id) : null;
      if (!site) return null;
      const configuration = snapshot(connection, site);
      if (options.forCreation && options.protocol === "epay_v1" && !configuration.v1Enabled) return null;
      if (options.forCreation && options.protocol === "epay_v2" && !configuration.v2Enabled) return null;
      if (options.protocol === "epay_v1" && configuration.v1KeyVersion === 0) return null;
      if (options.protocol === "epay_v2" && (configuration.merchantKeyVersion === 0 || configuration.platformKeyVersion === 0)) return null;
      return this.#credentials(connection, site);
    });
  }

  credentialsForSite(siteId: string): EpayCredentials | null {
    siteClientIdSchema.parse(siteId);
    return this.#database.read(connection => {
      const site = readSite(connection, siteId);
      return site ? this.#credentials(connection, site) : null;
    });
  }

  exportConfiguration(siteId: string, input: EpayExportInput, audit: SettingsAuditContext, now = Date.now()): EpayExportSnapshot {
    siteClientIdSchema.parse(siteId);
    if (!["native", "epay_v1", "epay_v2"].includes(input.protocol)) throw new RangeError("invalid export protocol");
    return this.#database.write(connection => {
      const site = requiredSite(connection, siteId);
      if (site.revision !== input.siteRevision) throw new SiteError("site_revision_conflict", "网站配置已变更，请刷新后重新下载。");
      const current = requiredConfiguration(connection, siteId);
      checkRevision(current, input.epayRevision);
      const configuration = snapshot(connection, site);
      let apiSecret: string | null = null;
      let webhookSecret: string | null = null;
      let credentials: EpayCredentials | null = null;
      if (input.protocol === "native") {
        apiSecret = this.#nativeSecret(connection, siteId, "api_secret");
        webhookSecret = this.#nativeSecret(connection, siteId, "webhook_secret");
      } else {
        credentials = this.#credentials(connection, site);
        if (input.protocol === "epay_v1" && !credentials.v1Key ||
            input.protocol === "epay_v2" && (!credentials.merchantPrivateKey || !credentials.platformPublicKey)) {
          throw new EpayError("epay_secret_missing", "请先生成所选易支付协议的密钥。");
        }
      }
      recordAudit(connection, audit, siteId, "epay.configuration_exported", validTime(now),
        { protocol: input.protocol, site_revision: site.revision, epay_revision: configuration.revision });
      return { site, configuration, credentials, apiSecret, webhookSecret };
    });
  }

  order(orderId: string): EpayOrderMetadata | null {
    return this.#database.read(connection => readEpayOrder(connection, orderId));
  }

  /** The active settlement time stays fixed when checkout or refund state changes. */
  paymentConfirmedAt(orderId: string): number | null {
    return this.#database.read(connection => {
      const row = connection.prepare(`SELECT operation.created_at
        FROM payment_matches AS match
        JOIN financial_operations AS operation ON operation.financial_operation_id = match.created_by_operation_id
        JOIN payment_orders AS orders ON orders.order_id = match.order_id
        WHERE match.order_id = ? AND match.match_role = 'PRIMARY_SETTLEMENT' AND match.status = 'SETTLED'
          AND orders.payment_status = 'CONFIRMED'
          AND operation.operation_type IN ('AUTO_SETTLEMENT', 'MANUAL_SETTLEMENT')`)
        .get(orderId) as { created_at: number | bigint } | undefined;
      return row ? safeInteger(row.created_at) : null;
    });
  }

  findOrder(siteId: string, query: { tradeNo?: string; outTradeNo?: string }): EpayOrderMetadata | null {
    return this.#database.read(connection => findEpayOrder(connection, siteId, query));
  }

  orders(siteId: string, options: { limit?: number; offset?: number; status?: 0 | 1 } = {}): readonly EpayOrderMetadata[] {
    siteClientIdSchema.parse(siteId);
    const limit = options.limit ?? 20;
    const offset = options.offset ?? 0;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || !Number.isSafeInteger(offset) || offset < 0) throw new RangeError("invalid epay pagination");
    if (options.status !== undefined && options.status !== 0 && options.status !== 1) throw new RangeError("invalid epay status");
    return this.#database.read(connection => (connection.prepare(`SELECT epay.* FROM epay_orders AS epay
      JOIN payment_orders AS orders ON orders.order_id = epay.order_id
      WHERE epay.site_id = ? AND (? IS NULL OR (orders.payment_status = 'CONFIRMED') = ?)
      ORDER BY epay.created_at DESC, epay.trade_no DESC LIMIT ? OFFSET ?`)
      .all(siteId, options.status ?? null, options.status ?? null, limit, offset) as unknown as OrderRow[]).map(mapOrder));
  }

  stats(siteId: string, now = Date.now()): { total: number; today: number; yesterday: number; paid: number; amountCents: number; todayAmountCents: number; yesterdayAmountCents: number } {
    siteClientIdSchema.parse(siteId);
    const day = Math.floor((validTime(now) + 28_800_000) / 86_400_000) * 86_400_000 - 28_800_000;
    return this.#database.read(connection => {
      const row = connection.prepare(`SELECT count(*) AS total,
        coalesce(sum(epay.created_at >= ? AND epay.created_at < ?), 0) AS today,
        coalesce(sum(epay.created_at >= ? AND epay.created_at < ?), 0) AS yesterday,
        coalesce(sum(orders.payment_status = 'CONFIRMED'), 0) AS paid,
        coalesce(sum(CASE WHEN orders.payment_status = 'CONFIRMED' AND epay.created_at >= ? AND epay.created_at < ? THEN orders.requested_amount_cents ELSE 0 END), 0) AS today_amount,
        coalesce(sum(CASE WHEN orders.payment_status = 'CONFIRMED' AND epay.created_at >= ? AND epay.created_at < ? THEN orders.requested_amount_cents ELSE 0 END), 0) AS yesterday_amount,
        coalesce(sum(CASE WHEN orders.payment_status = 'CONFIRMED' THEN orders.requested_amount_cents ELSE 0 END), 0) AS amount
        FROM epay_orders AS epay JOIN payment_orders AS orders ON orders.order_id = epay.order_id WHERE epay.site_id = ?`)
        .get(day, day + 86_400_000, day - 86_400_000, day, day, day + 86_400_000, day - 86_400_000, day, siteId) as Record<string, number | bigint>;
      return { total: safeInteger(row.total!), today: safeInteger(row.today!), yesterday: safeInteger(row.yesterday!), paid: safeInteger(row.paid!),
        amountCents: safeInteger(row.amount!), todayAmountCents: safeInteger(row.today_amount!), yesterdayAmountCents: safeInteger(row.yesterday_amount!) };
    });
  }

  #credentials(connection: DatabaseSync, site: SiteSnapshot): EpayCredentials {
    const v1 = readCredential(connection, site.clientId, "v1_key");
    const merchant = readCredential(connection, site.clientId, "v2_merchant");
    const platform = readCredential(connection, site.clientId, "v2_platform");
    return { ...snapshot(connection, site), site,
      v1Key: v1 ? this.#decrypt(v1) : null,
      merchantPrivateKey: merchant ? this.#decrypt(merchant) : null,
      platformPrivateKey: platform ? this.#decrypt(platform) : null,
      v1KeyId: v1?.credential_id ?? null, merchantKeyId: merchant?.credential_id ?? null, platformKeyId: platform?.credential_id ?? null,
      v1Fingerprint: v1?.fingerprint ?? null, merchantFingerprint: merchant?.fingerprint ?? null, platformFingerprint: platform?.fingerprint ?? null };
  }

  #rotateCredential(connection: DatabaseSync, siteId: string, purpose: EpayCredentialPurpose, audit: SettingsAuditContext | undefined, now: number): void {
    const previous = readCredential(connection, siteId, purpose);
    const version = previous ? safeInteger(previous.key_version) + 1 : 1;
    const createdAt = Math.max(now, previous ? safeInteger(previous.created_at) : 0);
    let secret: string;
    let publicKey: string | null = null;
    if (purpose === "v1_key") secret = randomBytes(16).toString("hex");
    else {
      const pair = generateKeyPairSync("rsa", { modulusLength: 2048,
        privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
      secret = pair.privateKey;
      publicKey = pair.publicKey;
    }
    const encrypted = this.#cipher.encrypt(`epay:${siteId}:${purpose}`, version, secret);
    if (previous) connection.prepare("UPDATE epay_credentials SET retired_at = ? WHERE credential_id = ?").run(createdAt, previous.credential_id);
    connection.prepare(`INSERT INTO epay_credentials(credential_id, site_id, purpose, key_version, fingerprint,
      public_key, public_fingerprint, cipher_version, nonce, ciphertext, authentication_tag, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), siteId, purpose, version, credentialFingerprint(purpose, secret), publicKey,
        publicKey ? publicKeyFingerprint(publicKey) : null, encrypted.cipherVersion, encrypted.nonce, encrypted.ciphertext, encrypted.authenticationTag, createdAt);
    recordAudit(connection, audit, siteId, "epay.secret_rotated", createdAt, { purpose, key_version: version }, purpose, previous !== undefined);
  }

  #decrypt(row: CredentialRow): string {
    const plaintext = this.#cipher.decrypt(`epay:${row.site_id}:${row.purpose}`, safeInteger(row.key_version), encryptedSecret(row));
    try {
      const secret = plaintext.toString("utf8");
      if (credentialFingerprint(row.purpose, secret) !== row.fingerprint) throw new Error("epay credential fingerprint mismatch");
      if (row.purpose !== "v1_key" && createPublicKey(secret).export({ format: "pem", type: "spki" }).toString() !== row.public_key) {
        throw new Error("epay public key does not match its encrypted private key");
      }
      return secret;
    } finally { plaintext.fill(0); }
  }

  #nativeSecret(connection: DatabaseSync, siteId: string, purpose: "api_secret" | "webhook_secret"): string {
    const row = connection.prepare("SELECT * FROM site_secrets WHERE client_id = ? AND secret_name = ?").get(siteId, purpose) as unknown as NativeSecretRow | undefined;
    if (!row) throw new SiteError("site_secret_missing", "请先生成网站 API 和通知密钥。");
    const plaintext = this.#siteCipher.decrypt(siteId, purpose, safeInteger(row.secret_version), encryptedSecret(row));
    try {
      const secret = plaintext.toString("utf8");
      const fingerprint = purpose === "api_secret" ? fingerprintApiSecret(secret) : fingerprintSecret(secret, "webhook-signing-key");
      if (!isCanonicalSecret(secret) || fingerprint !== row.secret_fingerprint) throw new Error("website export secret fingerprint mismatch");
      const active = purpose === "api_secret"
        ? connection.prepare(`SELECT key.key_version FROM api_client_keys AS key JOIN api_client_config AS config ON config.client_id = key.client_id
            AND config.key_version = key.key_version AND config.secret_fingerprint = key.secret_fingerprint
            WHERE key.client_id = ? AND key.secret_fingerprint = ? AND key.retired_at IS NULL AND config.enabled = 1`).get(siteId, fingerprint)
        : connection.prepare("SELECT key_version FROM webhook_signing_keys WHERE client_id = ? AND secret_fingerprint = ? AND retired_at IS NULL").get(siteId, fingerprint);
      if (!active) throw new Error("website export secret does not match the active signing key");
      return secret;
    } finally { plaintext.fill(0); }
  }
}

export function insertEpayOrder(connection: DatabaseSync, input: InsertEpayOrderInput): EpayOrderMetadata {
  if (!connection.isTransaction) throw new Error("epay order metadata requires the order creation transaction");
  siteClientIdSchema.parse(input.siteId);
  if (input.protocol !== "epay_v1" && input.protocol !== "epay_v2") throw new RangeError("invalid epay protocol");
  if (!/^[0-9a-f]{64}$/.test(input.requestFingerprint)) throw new RangeError("invalid epay request fingerprint");
  const config = requiredConfiguration(connection, input.siteId);
  connection.prepare(`INSERT INTO epay_orders(order_id, site_id, pid, protocol, param, request_fingerprint, return_url, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(input.orderId, input.siteId, config.pid, input.protocol, input.param, input.requestFingerprint, input.returnUrl, validTime(input.createdAt));
  return readEpayOrder(connection, input.orderId)!;
}

export function readEpayOrder(connection: DatabaseSync, orderId: string): EpayOrderMetadata | null {
  const row = connection.prepare("SELECT * FROM epay_orders WHERE order_id = ?").get(orderId) as unknown as OrderRow | undefined;
  return row ? mapOrder(row) : null;
}

export function findEpayOrder(connection: DatabaseSync, siteId: string, query: { tradeNo?: string; outTradeNo?: string }): EpayOrderMetadata | null {
  siteClientIdSchema.parse(siteId);
  let row: OrderRow | undefined;
  if (query.tradeNo !== undefined) {
    if (!canonicalNumber(query.tradeNo)) return null;
    row = connection.prepare("SELECT * FROM epay_orders WHERE site_id = ? AND trade_no = ?").get(siteId, query.tradeNo) as unknown as OrderRow | undefined;
  } else if (query.outTradeNo !== undefined) {
    row = connection.prepare(`SELECT epay.* FROM epay_orders AS epay JOIN payment_orders AS orders ON orders.order_id = epay.order_id
      WHERE epay.site_id = ? AND orders.merchant_order_no = ?`).get(siteId, query.outTradeNo) as unknown as OrderRow | undefined;
  }
  return row ? mapOrder(row) : null;
}

export function hasEpaySchema(connection: DatabaseSync): boolean {
  return !!connection.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'epay_sites'").get();
}

export function credentialFingerprint(purpose: EpayCredentialPurpose, secret: string): string {
  return createHash("sha256").update(`perpay:epay-credential:v1\0${purpose}\0${secret}`).digest("hex");
}

export function publicKeyFingerprint(key: string): string { return createHash("sha256").update(key).digest("hex"); }

function requiredSite(connection: DatabaseSync, siteId: string): SiteSnapshot {
  const site = readSite(connection, siteId);
  if (!site) throw new SiteError("site_not_found", "业务网站不存在。");
  return site;
}

function requiredConfiguration(connection: DatabaseSync, siteId: string): EpaySiteRow {
  const row = connection.prepare("SELECT * FROM epay_sites WHERE site_id = ?").get(siteId) as unknown as EpaySiteRow | undefined;
  if (!row) throw new EpayError("epay_not_configured", "易支付网站配置尚未初始化。");
  return row;
}

function readCredential(connection: DatabaseSync, siteId: string, purpose: EpayCredentialPurpose): CredentialRow | undefined {
  return connection.prepare("SELECT * FROM epay_credentials WHERE site_id = ? AND purpose = ? AND retired_at IS NULL")
    .get(siteId, purpose) as unknown as CredentialRow | undefined;
}

function snapshot(connection: DatabaseSync, site: SiteSnapshot): EpaySiteSnapshot {
  const row = requiredConfiguration(connection, site.clientId);
  const v1 = readCredential(connection, site.clientId, "v1_key");
  const merchant = readCredential(connection, site.clientId, "v2_merchant");
  const platform = readCredential(connection, site.clientId, "v2_platform");
  return { siteId: site.clientId, clientId: site.apiClientId, pid: String(row.pid), revision: safeInteger(row.revision),
    v1Enabled: Number(row.v1_enabled) === 1, v2Enabled: Number(row.v2_enabled) === 1,
    v1KeyVersion: v1 ? safeInteger(v1.key_version) : 0, merchantKeyVersion: merchant ? safeInteger(merchant.key_version) : 0,
    platformKeyVersion: platform ? safeInteger(platform.key_version) : 0,
    merchantPublicKey: merchant?.public_key ?? null, platformPublicKey: platform?.public_key ?? null };
}

function mapOrder(row: OrderRow): EpayOrderMetadata {
  return { orderId: row.order_id, siteId: row.site_id, pid: String(row.pid), protocol: row.protocol, tradeNo: String(row.trade_no),
    param: row.param, requestFingerprint: row.request_fingerprint, returnUrl: row.return_url, createdAt: safeInteger(row.created_at) };
}

function encryptedSecret(row: NativeSecretRow | CredentialRow) {
  return { cipherVersion: safeInteger(row.cipher_version) as 1, nonce: Buffer.from(row.nonce),
    ciphertext: Buffer.from(row.ciphertext), authenticationTag: Buffer.from(row.authentication_tag) };
}

function requirePurpose(purpose: EpayCredentialPurpose): void {
  if (!["v1_key", "v2_merchant", "v2_platform"].includes(purpose)) throw new RangeError("invalid epay credential purpose");
}

function safeInteger(value: number | bigint): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new RangeError("invalid epay integer");
  return number;
}

function validTime(now: number): number { return safeInteger(now); }
function canonicalNumber(value: string): boolean { return /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)); }
function checkRevision(current: EpaySiteRow, expected: number): void {
  if (!Number.isSafeInteger(expected) || expected < 0 || safeInteger(current.revision) !== expected) {
    throw new EpayError("epay_revision_conflict", "易支付配置已变更，请刷新后重试。");
  }
}

function recordAudit(connection: DatabaseSync, audit: SettingsAuditContext | undefined, siteId: string, action: string, now: number,
  details: Record<string, unknown>, purpose?: EpayCredentialPurpose, existed = false): void {
  appendAuditEvent(connection, { occurredAt: now, actorType: audit ? "ADMIN" : "SYSTEM", actorId: audit?.actorId, action, outcome: "SUCCESS",
    subjectType: "website", subjectId: siteId, requestId: audit?.requestId, remoteAddressHash: audit?.remoteAddressHash, details,
    context: { ...auditSiteContext(connection, siteId), changes: purpose ? [redactedAuditChange(purpose, existed, true)] : [] } });
}
