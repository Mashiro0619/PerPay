import type { DatabaseSync } from "node:sqlite";

import type { AppDatabase } from "../database/database.ts";
import { IdentityTransaction } from "../database/identity-store.ts";
import { fingerprintApiSecret } from "../identity/service.ts";
import {
  bindProviderIdentityInTransaction,
} from "../ledger/store.ts";
import { LEDGER_PROVIDER_KIND } from "../ledger/model.ts";
import {
  API_CLIENT_ID,
  fingerprintSecret,
  isCanonicalSecret,
  parseProviderApplicationPrivateKey,
  parseProviderKeys,
  type AdvancedSettingsInput,
  type CollectionSettingsInput,
  type ApiCredentialSnapshot,
  type ProviderEnvironment,
  type ProviderApplicationKeyMaterial,
  type ProviderSettings,
  type RuntimeSecretName,
  type RuntimeSettingsSnapshot,
  type RuntimeSettingsStatus,
  type WebhookSettingsInput,
} from "./model.ts";
import { RuntimeSecretCipher, type EncryptedSecret } from "./crypto.ts";

interface ConfigurationRow {
  readonly revision: bigint | number;
  readonly payment_revision: bigint | number;
  readonly collection_code_payload: string | null;
  readonly order_ttl_seconds: bigint | number;
  readonly amount_offset_maximum_cents: bigint | number;
  readonly provider_environment: ProviderEnvironment | null;
  readonly provider_app_id: string | null;
  readonly provider_account_key: string | null;
  readonly provider_timeout_milliseconds: bigint | number;
  readonly provider_scan_interval_milliseconds: bigint | number;
  readonly provider_safety_lag_milliseconds: bigint | number;
  readonly provider_maximum_success_age_milliseconds: bigint | number;
  readonly webhook_enabled: bigint | number;
  readonly webhook_allowed_origin: string | null;
  readonly webhook_timeout_milliseconds: bigint | number;
  readonly webhook_maximum_attempts: bigint | number;
  readonly webhook_retry_base_milliseconds: bigint | number;
  readonly webhook_retry_maximum_milliseconds: bigint | number;
  readonly checkout_key_rotation_days: bigint | number;
  readonly checkout_terminal_observation_seconds: bigint | number;
  readonly updated_at: bigint | number;
}

interface SecretRow {
  readonly secret_name: RuntimeSecretName;
  readonly secret_version: bigint | number;
  readonly cipher_version: bigint | number;
  readonly nonce: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly authentication_tag: Uint8Array;
  readonly secret_fingerprint: string;
  readonly updated_at: bigint | number;
}

interface GuardRow {
  readonly cipher_version: bigint | number;
  readonly nonce: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly authentication_tag: Uint8Array;
}

export interface SettingsAuditContext {
  readonly actorId: string;
  readonly requestId?: string | undefined;
  readonly remoteAddressHash?: string | undefined;
}

export class SettingsError extends Error {
  readonly code:
    | "settings_revision_conflict"
    | "settings_not_configured"
    | "secret_not_found"
    | "provider_application_key_missing"
    | "provider_switch_blocked"
    | "provider_application_key_rotation_not_supported";

  constructor(code: SettingsError["code"], message: string) {
    super(message);
    this.name = "SettingsError";
    this.code = code;
  }
}

export class RuntimeSettingsStore {
  readonly #database: AppDatabase;
  readonly #cipher: RuntimeSecretCipher;

  constructor(database: AppDatabase, masterKey: Uint8Array) {
    this.#database = database;
    this.#cipher = new RuntimeSecretCipher(masterKey, database.instanceId());
  }

  initialize(): void {
    this.#database.write((connection) => {
      const existing = readGuard(connection);
      if (existing) {
        this.#cipher.verifyGuard(existing);
        return;
      }
      const encryptedSecret = connection.prepare(
        "SELECT 1 AS present FROM runtime_secrets LIMIT 1",
      ).get() as { present: number } | undefined;
      if (encryptedSecret) {
        throw new Error(
          "runtime master key guard is missing while encrypted settings still exist",
        );
      }
      const encrypted = this.#cipher.createGuard();
      const inserted = connection.prepare(
        `INSERT INTO runtime_master_key_guard(
           singleton_key, cipher_version, nonce, ciphertext,
           authentication_tag, created_at
         ) VALUES (1, ?, ?, ?, ?, ?)`,
      ).run(
        encrypted.cipherVersion,
        encrypted.nonce,
        encrypted.ciphertext,
        encrypted.authenticationTag,
        Date.now(),
      );
      if (Number(inserted.changes) !== 1) throw new Error("master key guard was not initialized");
    });
  }

  snapshot(): RuntimeSettingsSnapshot {
    return this.#database.read((connection) => this.#snapshot(connection));
  }

  /**
   * Reads the active API secret and identity key generation in one SQLite
   * statement. Secret rotation publishes both records atomically; callers
   * must use this pair and pass the generation back when consuming a nonce.
   */
  apiCredential(): ApiCredentialSnapshot | null {
    return this.#database.read((connection) => {
      const row = connection.prepare(
        `SELECT secret.secret_name, secret.secret_version, secret.cipher_version,
                secret.nonce, secret.ciphertext, secret.authentication_tag,
                secret.secret_fingerprint, secret.updated_at,
                client.client_id, client.key_version
           FROM runtime_secrets AS secret
           JOIN api_client_config AS client
             ON client.singleton_key = 1
            AND client.client_id = ?
            AND client.enabled = 1
            AND client.secret_fingerprint = secret.secret_fingerprint
          WHERE secret.secret_name = 'api_secret'`,
      ).get(API_CLIENT_ID) as (SecretRow & {
        readonly client_id: string;
        readonly key_version: bigint | number;
      }) | undefined;
      if (!row || row.client_id !== API_CLIENT_ID) return null;
      return Object.freeze({
        clientId: API_CLIENT_ID,
        keyVersion: safeInteger(row.key_version, "API client key version"),
        secretFingerprint: row.secret_fingerprint,
        secret: decryptSecret(this.#cipher, row),
      });
    });
  }

  status(): RuntimeSettingsStatus {
    const snapshot = this.snapshot();
    const collectionConfigured = snapshot.collection !== null;
    const providerConfigured = snapshot.provider !== null && snapshot.activeProviderAccountKey !== null;
    const apiConfigured = snapshot.apiSecret !== null;
    return {
      revision: snapshot.revision,
      paymentRevision: snapshot.paymentRevision,
      updatedAt: snapshot.updatedAt,
      complete: collectionConfigured && providerConfigured && apiConfigured,
      collectionConfigured,
      providerConfigured,
      apiConfigured,
      notificationConfigured: !snapshot.webhook.enabled || snapshot.webhook.secret !== null,
      activeProviderAccountKey: snapshot.activeProviderAccountKey,
    };
  }

  providerApplicationKey(): ProviderApplicationKeyMaterial | null {
    return this.#database.read((connection) => {
      const row = readSecret(connection, "provider_private_key");
      return row
        ? parseProviderApplicationPrivateKey(decryptSecret(this.#cipher, row))
        : null;
    });
  }

  saveCollection(
    input: CollectionSettingsInput,
    audit: SettingsAuditContext,
    now = Date.now(),
  ): RuntimeSettingsSnapshot {
    return this.#database.write((connection) => {
      assertRevision(connection, input.revision);
      const updated = connection.prepare(
        `UPDATE runtime_configuration
            SET revision = revision + 1,
                payment_revision = payment_revision + 1,
                collection_code_payload = ?,
                order_ttl_seconds = ?,
                amount_offset_maximum_cents = ?,
                updated_at = ?
          WHERE singleton_key = 1 AND revision = ?`,
      ).run(
        input.code_payload,
        input.order_ttl_seconds,
        input.amount_offset_maximum_cents,
        now,
        input.revision,
      );
      assertUpdated(updated.changes);
      appendSettingsAudit(connection, audit, now, "settings.collection_updated", {
        revision: input.revision + 1,
        payment_revision_changed: true,
      });
      return this.#snapshot(connection);
    });
  }

  saveProvider(input: {
    readonly expectedRevision: number;
    readonly accountKey: string;
    readonly environment: ProviderEnvironment;
    readonly appId: string;
    readonly privateKeyPem: string;
    readonly publicKeyPem: string;
    readonly privateKeyFingerprint: string;
    readonly publicKeyFingerprint: string;
    readonly timeoutMilliseconds: number;
    readonly scanIntervalMilliseconds: number;
    readonly safetyLagMilliseconds: number;
    readonly maximumSuccessAgeMilliseconds: number;
    readonly providerIdentity: {
      readonly endpoint: string;
      readonly externalAccountId: string;
    };
    readonly audit: SettingsAuditContext;
    readonly now?: number;
  }): RuntimeSettingsSnapshot {
    const now = input.now ?? Date.now();
    return this.#database.write((connection) => {
      assertRevision(connection, input.expectedRevision);
      bindProviderIdentityInTransaction(connection, {
        ...input.providerIdentity,
        providerAccountKey: input.accountKey,
        providerKind: LEDGER_PROVIDER_KIND,
      }, now);
      writeSecret(
        connection,
        this.#cipher,
        "provider_private_key",
        input.privateKeyPem,
        input.privateKeyFingerprint,
        now,
      );
      writeSecret(
        connection,
        this.#cipher,
        "provider_public_key",
        input.publicKeyPem,
        input.publicKeyFingerprint,
        now,
      );
      const updated = connection.prepare(
        `UPDATE runtime_configuration
            SET revision = revision + 1,
                payment_revision = payment_revision + 1,
                provider_environment = ?,
                provider_app_id = ?,
                provider_account_key = ?,
                provider_timeout_milliseconds = ?,
                provider_scan_interval_milliseconds = ?,
                provider_safety_lag_milliseconds = ?,
                provider_maximum_success_age_milliseconds = ?,
                updated_at = ?
          WHERE singleton_key = 1 AND revision = ?`,
      ).run(
        input.environment,
        input.appId,
        input.accountKey,
        input.timeoutMilliseconds,
        input.scanIntervalMilliseconds,
        input.safetyLagMilliseconds,
        input.maximumSuccessAgeMilliseconds,
        now,
        input.expectedRevision,
      );
      assertUpdated(updated.changes);
      appendSettingsAudit(connection, input.audit, now, "settings.provider_updated", {
        revision: input.expectedRevision + 1,
        provider_account_key: input.accountKey,
        environment: input.environment,
        app_id: input.appId,
        application_key_fingerprint: input.privateKeyFingerprint,
        platform_key_fingerprint: input.publicKeyFingerprint,
      });
      return this.#snapshot(connection);
    });
  }

  saveGeneratedProviderApplicationKey(input: {
    readonly expectedRevision: number;
    readonly privateKeyPem: string;
    readonly fingerprint: string;
    readonly audit: SettingsAuditContext;
    readonly now?: number;
  }): RuntimeSettingsSnapshot {
    const key = parseProviderApplicationPrivateKey(input.privateKeyPem);
    if (key.fingerprint !== input.fingerprint) {
      throw new RangeError("provider application key fingerprint does not match the private key");
    }
    const now = input.now ?? Date.now();
    return this.#database.write((connection) => {
      assertRevision(connection, input.expectedRevision);
      const configuration = readConfiguration(connection);
      const historicalProvider = connection.prepare(
        "SELECT 1 AS present FROM provider_account_bindings LIMIT 1",
      ).get() as { readonly present: number } | undefined;
      if (configuration.provider_account_key !== null || historicalProvider !== undefined) {
        throw new SettingsError(
          "provider_application_key_rotation_not_supported",
          "an application key cannot be generated after a provider generation has been created",
        );
      }
      if (readSecret(connection, "provider_private_key") !== null) {
        throw new SettingsError(
          "provider_application_key_rotation_not_supported",
          "the initial application key has already been generated",
        );
      }
      writeSecret(
        connection,
        this.#cipher,
        "provider_private_key",
        key.privateKeyPem,
        key.fingerprint,
        now,
      );
      const updated = connection.prepare(
        `UPDATE runtime_configuration
            SET revision = revision + 1,
                updated_at = ?
          WHERE singleton_key = 1 AND revision = ?`,
      ).run(now, input.expectedRevision);
      assertUpdated(updated.changes);
      appendSettingsAudit(
        connection,
        input.audit,
        now,
        "settings.provider_application_key_generated",
        {
          revision: input.expectedRevision + 1,
          payment_revision_changed: false,
          application_key_fingerprint: key.fingerprint,
        },
      );
      return this.#snapshot(connection);
    });
  }

  saveApiSecret(
    secret: string,
    expectedRevision: number,
    audit: SettingsAuditContext,
    now = Date.now(),
  ): RuntimeSettingsSnapshot {
    if (!isCanonicalSecret(secret)) throw new RangeError("API secret must contain exactly 32 random bytes");
    return this.#database.write((connection) => {
      assertRevision(connection, expectedRevision);
      writeSecret(
        connection,
        this.#cipher,
        "api_secret",
        secret,
        fingerprintApiSecret(secret),
        now,
      );
      const identity = new IdentityTransaction(connection);
      const before = identity.activeApiClient(API_CLIENT_ID);
      const current = identity.syncApiClient(API_CLIENT_ID, fingerprintApiSecret(secret), now);
      const updated = connection.prepare(
        `UPDATE runtime_configuration
            SET revision = revision + 1, updated_at = ?
          WHERE singleton_key = 1 AND revision = ?`,
      ).run(now, expectedRevision);
      assertUpdated(updated.changes);
      identity.appendAudit({
        occurredAt: now,
        actorType: "ADMIN",
        actorId: audit.actorId,
        action: before ? "api_client.rotated" : "api_client.initialized",
        outcome: "SUCCESS",
        subjectType: "api_client",
        subjectId: API_CLIENT_ID,
        requestId: audit.requestId,
        remoteAddressHash: audit.remoteAddressHash,
        details: {
          key_version: current.keyVersion,
          settings_revision: expectedRevision + 1,
        },
      });
      return this.#snapshot(connection);
    });
  }

  saveWebhook(
    input: WebhookSettingsInput & { readonly secret: string | null },
    audit: SettingsAuditContext,
    now = Date.now(),
  ): RuntimeSettingsSnapshot {
    return this.#database.write((connection) => {
      assertRevision(connection, input.revision);
      if (input.secret !== null) {
        if (!isCanonicalSecret(input.secret)) {
          throw new RangeError("notification secret must contain exactly 32 random bytes");
        }
        writeSecret(
          connection,
          this.#cipher,
          "webhook_secret",
          input.secret,
          fingerprintSecret(input.secret, "webhook-signing-key"),
          now,
        );
      }
      const updated = connection.prepare(
        `UPDATE runtime_configuration
            SET revision = revision + 1,
                webhook_enabled = ?,
                webhook_allowed_origin = ?,
                webhook_timeout_milliseconds = ?,
                webhook_maximum_attempts = ?,
                webhook_retry_base_milliseconds = ?,
                webhook_retry_maximum_milliseconds = ?,
                updated_at = ?
          WHERE singleton_key = 1 AND revision = ?`,
      ).run(
        input.enabled ? 1 : 0,
        input.enabled ? input.allowed_origin ?? null : null,
        input.timeout_milliseconds,
        input.maximum_attempts,
        input.retry_base_seconds * 1_000,
        input.retry_maximum_seconds * 1_000,
        now,
        input.revision,
      );
      assertUpdated(updated.changes);
      appendSettingsAudit(connection, audit, now, "settings.notifications_updated", {
        revision: input.revision + 1,
        enabled: input.enabled,
        signing_key_rotated: input.secret !== null,
      });
      return this.#snapshot(connection);
    });
  }

  saveAdvanced(
    input: AdvancedSettingsInput,
    audit: SettingsAuditContext,
    now = Date.now(),
  ): RuntimeSettingsSnapshot {
    return this.#database.write((connection) => {
      assertRevision(connection, input.revision);
      const updated = connection.prepare(
        `UPDATE runtime_configuration
            SET revision = revision + 1,
                checkout_key_rotation_days = ?,
                checkout_terminal_observation_seconds = ?,
                updated_at = ?
          WHERE singleton_key = 1 AND revision = ?`,
      ).run(
        input.checkout_key_rotation_days,
        input.checkout_terminal_observation_seconds,
        now,
        input.revision,
      );
      assertUpdated(updated.changes);
      appendSettingsAudit(connection, audit, now, "settings.advanced_updated", {
        revision: input.revision + 1,
        checkout_key_rotation_days: input.checkout_key_rotation_days,
        checkout_terminal_observation_seconds: input.checkout_terminal_observation_seconds,
        payment_revision_changed: false,
      });
      return this.#snapshot(connection);
    });
  }

  reveal(name: RuntimeSecretName, audit: SettingsAuditContext, now = Date.now()): string {
    return this.#database.write((connection) => {
      const row = readSecret(connection, name);
      if (!row) throw new SettingsError("secret_not_found", "secret has not been configured");
      const plaintext = decryptSecret(this.#cipher, row);
      appendSettingsAudit(connection, audit, now, "settings.secret_revealed", {
        field: name,
        version: safeInteger(row.secret_version, "secret version"),
        fingerprint: row.secret_fingerprint,
      });
      return plaintext;
    });
  }

  secretMetadata(name: RuntimeSecretName): {
    readonly configured: boolean;
    readonly version: number | null;
    readonly fingerprint: string | null;
    readonly masked: string | null;
    readonly updatedAt: number | null;
  } {
    return this.#database.read((connection) => {
      const row = readSecret(connection, name);
      if (!row) {
        return { configured: false, version: null, fingerprint: null, masked: null, updatedAt: null };
      }
      const plaintext = decryptSecret(this.#cipher, row);
      return {
        configured: true,
        version: safeInteger(row.secret_version, "secret version"),
        fingerprint: row.secret_fingerprint,
        masked: `••••${plaintext.slice(-4)}`,
        updatedAt: safeInteger(row.updated_at, "secret updated time"),
      };
    });
  }

  #snapshot(connection: DatabaseSync): RuntimeSettingsSnapshot {
    const row = readConfiguration(connection);
    const apiRow = readSecret(connection, "api_secret");
    const privateKeyRow = readSecret(connection, "provider_private_key");
    const publicKeyRow = readSecret(connection, "provider_public_key");
    const webhookSecretRow = readSecret(connection, "webhook_secret");

    let provider: ProviderSettings | null = null;
    if (
      row.provider_environment !== null &&
      row.provider_app_id !== null &&
      row.provider_account_key !== null &&
      privateKeyRow &&
      publicKeyRow
    ) {
      provider = parseProviderKeys({
        environment: row.provider_environment,
        appId: row.provider_app_id,
        privateKey: decryptSecret(this.#cipher, privateKeyRow),
        publicKey: decryptSecret(this.#cipher, publicKeyRow),
        timeoutMilliseconds: safeInteger(row.provider_timeout_milliseconds, "provider timeout"),
        scanIntervalMilliseconds: safeInteger(
          row.provider_scan_interval_milliseconds,
          "provider scan interval",
        ),
        safetyLagMilliseconds: safeInteger(
          row.provider_safety_lag_milliseconds,
          "provider safety lag",
        ),
        maximumSuccessAgeMilliseconds: safeInteger(
          row.provider_maximum_success_age_milliseconds,
          "provider maximum success age",
        ),
      });
    }

    const webhookSecret = webhookSecretRow ? decryptSecret(this.#cipher, webhookSecretRow) : null;
    const webhookEnabled = Number(row.webhook_enabled) === 1;
    return {
      revision: safeInteger(row.revision, "runtime configuration revision"),
      paymentRevision: safeInteger(row.payment_revision, "payment configuration revision"),
      updatedAt: safeInteger(row.updated_at, "runtime configuration updated time"),
      collection: row.collection_code_payload === null
        ? null
        : {
            codePayload: row.collection_code_payload,
            orderTtlSeconds: safeInteger(row.order_ttl_seconds, "order TTL"),
            amountOffsetMaximumCents: safeInteger(
              row.amount_offset_maximum_cents,
              "amount offset maximum",
            ),
          },
      provider,
      apiSecret: apiRow ? decryptSecret(this.#cipher, apiRow) : null,
      apiSecretFingerprint: apiRow?.secret_fingerprint ?? null,
      webhook: {
        enabled: webhookEnabled,
        allowedOrigin: row.webhook_allowed_origin,
        secret: webhookSecret,
        signingKeyFingerprint: webhookSecretRow?.secret_fingerprint ?? null,
        timeoutMilliseconds: safeInteger(row.webhook_timeout_milliseconds, "webhook timeout"),
        maximumAttempts: safeInteger(row.webhook_maximum_attempts, "webhook attempts"),
        retryBaseMilliseconds: safeInteger(
          row.webhook_retry_base_milliseconds,
          "webhook retry base",
        ),
        retryMaximumMilliseconds: safeInteger(
          row.webhook_retry_maximum_milliseconds,
          "webhook retry maximum",
        ),
      },
      advanced: {
        checkoutKeyRotationDays: safeInteger(
          row.checkout_key_rotation_days,
          "checkout key rotation days",
        ),
        checkoutTerminalObservationSeconds: safeInteger(
          row.checkout_terminal_observation_seconds,
          "checkout terminal observation seconds",
        ),
      },
      activeProviderAccountKey: row.provider_account_key,
    };
  }
}

export { API_CLIENT_ID };

function readConfiguration(connection: DatabaseSync): ConfigurationRow {
  const row = connection.prepare(
    `SELECT revision, payment_revision, collection_code_payload,
            order_ttl_seconds, amount_offset_maximum_cents,
            provider_environment, provider_app_id, provider_account_key,
            provider_timeout_milliseconds,
            provider_scan_interval_milliseconds,
            provider_safety_lag_milliseconds,
            provider_maximum_success_age_milliseconds,
            webhook_enabled, webhook_allowed_origin,
            webhook_timeout_milliseconds, webhook_maximum_attempts,
            webhook_retry_base_milliseconds,
            webhook_retry_maximum_milliseconds,
            checkout_key_rotation_days,
            checkout_terminal_observation_seconds,
            updated_at
       FROM runtime_configuration WHERE singleton_key = 1`,
  ).get() as ConfigurationRow | undefined;
  if (!row) throw new Error("runtime configuration singleton is missing");
  return row;
}

function assertRevision(connection: DatabaseSync, expected: number): void {
  const current = safeInteger(readConfiguration(connection).revision, "runtime configuration revision");
  if (current !== expected) {
    throw new SettingsError(
      "settings_revision_conflict",
      `settings changed concurrently: expected revision ${expected}, current revision ${current}`,
    );
  }
}

function assertUpdated(changes: bigint | number): void {
  if (Number(changes) !== 1) {
    throw new SettingsError("settings_revision_conflict", "settings changed concurrently");
  }
}

function readSecret(connection: DatabaseSync, name: RuntimeSecretName): SecretRow | null {
  const row = connection.prepare(
    `SELECT secret_name, secret_version, cipher_version, nonce,
            ciphertext, authentication_tag, secret_fingerprint, updated_at
       FROM runtime_secrets WHERE secret_name = ?`,
  ).get(name) as SecretRow | undefined;
  return row ?? null;
}

function writeSecret(
  connection: DatabaseSync,
  cipher: RuntimeSecretCipher,
  name: RuntimeSecretName,
  plaintext: string,
  fingerprint: string,
  now: number,
): void {
  const existing = readSecret(connection, name);
  const version = existing ? safeInteger(existing.secret_version, "secret version") + 1 : 1;
  const encrypted = cipher.encrypt(name, version, plaintext);
  if (existing) {
    const updated = connection.prepare(
      `UPDATE runtime_secrets
          SET secret_version = ?, cipher_version = ?, nonce = ?, ciphertext = ?,
              authentication_tag = ?, secret_fingerprint = ?, updated_at = ?
        WHERE secret_name = ? AND secret_version = ?`,
    ).run(
      version,
      encrypted.cipherVersion,
      encrypted.nonce,
      encrypted.ciphertext,
      encrypted.authenticationTag,
      fingerprint,
      now,
      name,
      version - 1,
    );
    if (Number(updated.changes) !== 1) throw new Error(`runtime secret ${name} update conflicted`);
  } else {
    const inserted = connection.prepare(
      `INSERT INTO runtime_secrets(
         secret_name, secret_version, cipher_version, nonce, ciphertext,
         authentication_tag, secret_fingerprint, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      name,
      version,
      encrypted.cipherVersion,
      encrypted.nonce,
      encrypted.ciphertext,
      encrypted.authenticationTag,
      fingerprint,
      now,
    );
    if (Number(inserted.changes) !== 1) throw new Error(`runtime secret ${name} was not inserted`);
  }
}

function decryptSecret(cipher: RuntimeSecretCipher, row: SecretRow): string {
  return cipher.decrypt(row.secret_name, safeInteger(row.secret_version, "secret version"), {
    cipherVersion: safeInteger(row.cipher_version, "secret cipher version") as 1,
    nonce: Buffer.from(row.nonce),
    ciphertext: Buffer.from(row.ciphertext),
    authenticationTag: Buffer.from(row.authentication_tag),
  }).toString("utf8");
}

function readGuard(connection: DatabaseSync): EncryptedSecret | null {
  const row = connection.prepare(
    `SELECT cipher_version, nonce, ciphertext, authentication_tag
       FROM runtime_master_key_guard WHERE singleton_key = 1`,
  ).get() as GuardRow | undefined;
  if (!row) return null;
  return {
    cipherVersion: safeInteger(row.cipher_version, "guard cipher version") as 1,
    nonce: Buffer.from(row.nonce),
    ciphertext: Buffer.from(row.ciphertext),
    authenticationTag: Buffer.from(row.authentication_tag),
  };
}

function safeInteger(value: bigint | number, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} is invalid`);
  return parsed;
}

function appendSettingsAudit(
  connection: DatabaseSync,
  audit: SettingsAuditContext,
  occurredAt: number,
  action: string,
  details: Readonly<Record<string, unknown>>,
): void {
  new IdentityTransaction(connection).appendAudit({
    occurredAt,
    actorType: "ADMIN",
    actorId: audit.actorId,
    action,
    outcome: "SUCCESS",
    subjectType: "runtime_configuration",
    subjectId: "1",
    requestId: audit.requestId,
    remoteAddressHash: audit.remoteAddressHash,
    details,
  });
}
