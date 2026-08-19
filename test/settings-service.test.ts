import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { AppDatabase, inspectDatabaseIntegrity } from "../src/database/database.ts";
import { LedgerStore } from "../src/ledger/store.ts";
import {
  RuntimeSettingsService,
  RuntimeSettingsStore,
  SettingsError,
} from "../src/settings/index.ts";

const masterKey = Buffer.alloc(32, 0x31);
const replacementMasterKey = Buffer.alloc(32, 0x32);
const applicationKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const platformKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const applicationPrivateKey = applicationKeys.privateKey
  .export({ format: "pem", type: "pkcs8" })
  .toString();
const platformPublicKey = platformKeys.publicKey
  .export({ format: "pem", type: "spki" })
  .toString();

describe("runtime settings", () => {
  it("encrypts secrets, enforces revisions, and rejects the wrong deployment key", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-settings-"));
    const databasePath = join(directory, "perpay.sqlite3");
    const database = await AppDatabase.open(databasePath);
    try {
      const settings = service(database, masterKey);
      assert.deepEqual(settings.status(), {
        revision: 0,
        paymentRevision: 0,
        updatedAt: settings.status().updatedAt,
        complete: false,
        collectionConfigured: false,
        providerConfigured: false,
        apiConfigured: false,
        notificationConfigured: true,
        activeProviderAccountKey: null,
      });

      await settings.saveCollection({
        revision: 0,
        code_payload: "https://qr.example.test/settings",
        order_ttl_seconds: 300,
        amount_offset_maximum_cents: 19,
      }, audit("collection"));
      await settings.saveProvider(providerInput(1, "2026000000000001"), audit("provider"));
      const rotated = await settings.rotateApiSecret(2, audit("api"));
      assert.equal(rotated.client_id, "default");
      assert.match(rotated.secret, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(rotated.settings.completion.complete, true);
      assert.equal(rotated.settings.completion.application_key, true);
      assert.equal(rotated.settings.completion.next_step, null);
      assert.equal(rotated.settings.payment_revision, 2);
      assert.equal(rotated.settings.secrets.api_secret.masked, `••••${rotated.secret.slice(-4)}`);
      assert.equal(settings.revealSecret("api_secret", audit("reveal")), rotated.secret);
      const credential = settings.apiCredential();
      assert.ok(credential);
      assert.equal(credential.clientId, "default");
      assert.equal(credential.keyVersion, 1);
      assert.equal(credential.secret, rotated.secret);
      assert.equal(credential.secretFingerprint, rotated.settings.secrets.api_secret.fingerprint);

      const stored = database.read((connection) => connection.prepare(
        `SELECT ciphertext, nonce, authentication_tag
           FROM runtime_secrets WHERE secret_name = 'api_secret'`,
      ).get() as {
        ciphertext: Uint8Array;
        nonce: Uint8Array;
        authentication_tag: Uint8Array;
      });
      assert.equal(Buffer.from(stored.ciphertext).includes(Buffer.from(rotated.secret)), false);
      assert.equal(stored.nonce.byteLength, 12);
      assert.equal(stored.authentication_tag.byteLength, 16);

      await assert.rejects(
        settings.rotateApiSecret(2, audit("stale")),
        (error: unknown) =>
          error instanceof SettingsError && error.code === "settings_revision_conflict",
      );
      assert.equal(settings.status().revision, 3);
      assert.equal(
        database.read((connection) => Number((connection.prepare(
          "SELECT COUNT(*) AS count FROM api_client_config",
        ).get() as { count: bigint }).count)),
        1,
      );
      const auditJson = database.read((connection) =>
        [...connection.prepare(
          `SELECT details_json FROM audit_events
            WHERE action LIKE 'settings.%' OR action LIKE 'api_client.%'`,
        ).iterate()].map((row) => String((row as { details_json: string }).details_json)).join("\n")
      );
      assert.equal(auditJson.includes(rotated.secret), false);
      assert.equal(auditJson.includes(applicationPrivateKey), false);
    } finally {
      database.close();
    }

    const restored = await AppDatabase.open(databasePath);
    try {
      assert.throws(
        () => new RuntimeSettingsStore(restored, replacementMasterKey).initialize(),
        /PERPAY_MASTER_KEY does not match this database/i,
      );
      const correct = new RuntimeSettingsStore(restored, masterKey);
      correct.initialize();
      assert.equal(correct.status().complete, true);
    } finally {
      restored.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("generates and stages an encrypted application key for initial provider setup", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-settings-generated-provider-key-"));
    const database = await AppDatabase.open(join(directory, "perpay.sqlite3"));
    try {
      const settings = service(database, masterKey);
      assert.deepEqual(settings.view().completion, {
        complete: false,
        application_key: false,
        collection: false,
        provider: false,
        api: false,
        notifications: true,
        next_step: "GENERATE_APPLICATION_KEY",
      });
      const initialProvider = providerInput(0, "2026000000000098");
      const { private_key: _missingPrivateKey, ...platformOnly } = initialProvider;
      await assert.rejects(
        settings.saveProvider(platformOnly, audit("provider-missing-generated-key")),
        (error: unknown) => error instanceof SettingsError &&
          error.code === "provider_application_key_missing",
      );
      const generatedConcurrently = await Promise.all([
        settings.generateProviderApplicationKey(0, audit("generate-provider-key-first")),
        settings.generateProviderApplicationKey(0, audit("generate-provider-key-retry")),
      ]);
      const generated = generatedConcurrently.find((result) => result.created);
      const concurrentRetry = generatedConcurrently.find((result) => !result.created);
      assert.ok(generated);
      assert.ok(concurrentRetry);
      assert.equal(concurrentRetry.public_key, generated.public_key);
      assert.equal(concurrentRetry.fingerprint, generated.fingerprint);
      assert.equal(concurrentRetry.settings.revision, 1);

      assert.equal(generated.settings.revision, 1);
      assert.equal(generated.settings.payment_revision, 0);
      assert.equal(generated.settings.application_public_key, generated.public_key);
      assert.equal(generated.settings.application_key_fingerprint, generated.fingerprint);
      assert.equal(generated.created, true);
      assert.equal(generated.settings.completion.next_step, "CONFIGURE_PROVIDER");
      assert.match(generated.public_key, /^[A-Za-z0-9+/]+={0,2}$/u);
      assert.match(generated.fingerprint, /^[0-9a-f]{64}$/u);

      const privateKey = settings.revealSecret(
        "provider_private_key",
        audit("reveal-generated-provider-key"),
      );
      const derivedPublicKey = createPublicKey(createPrivateKey(privateKey))
        .export({ format: "der", type: "spki" })
        .toString("base64");
      assert.equal(derivedPublicKey, generated.public_key);

      const stored = database.read((connection) => connection.prepare(
        `SELECT ciphertext FROM runtime_secrets WHERE secret_name = 'provider_private_key'`,
      ).get() as { ciphertext: Uint8Array });
      assert.equal(Buffer.from(stored.ciphertext).includes(Buffer.from(privateKey)), false);

      const repeated = await settings.generateProviderApplicationKey(
        0,
        audit("repeat-provider-key-generation"),
      );
      assert.equal(repeated.created, false);
      assert.equal(repeated.settings.revision, 1);
      assert.equal(repeated.public_key, generated.public_key);
      assert.equal(repeated.fingerprint, generated.fingerprint);
      assert.equal(settings.revealSecret(
        "provider_private_key",
        audit("reveal-repeated-provider-key"),
      ), privateKey);

      const otherApplicationKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
      const otherPrivateKey = otherApplicationKeys.privateKey
        .export({ format: "pem", type: "pkcs8" })
        .toString();

      const input = providerInput(1, "2026000000000099");

      await assert.rejects(
        settings.saveProvider({
          ...input,
          private_key: otherPrivateKey,
        }, audit("provider-with-mismatched-generated-key")),
        /does not match the generated application public key/u,
      );
      assert.equal(settings.view().revision, 1);

      const saved = await settings.saveProvider({
        ...input,
        private_key: undefined,
      }, audit("provider-with-generated-key"));
      assert.equal(saved.provider?.app_id, "2026000000000099");
      assert.equal(saved.application_public_key, generated.public_key);
      assert.equal(saved.payment_revision, 1);
      assert.equal(saved.completion.next_step, "CONFIGURE_COLLECTION");

      const auditJson = database.read((connection) => String((connection.prepare(
        `SELECT details_json FROM audit_events
          WHERE action = 'settings.provider_application_key_generated'`,
      ).get() as { details_json: string }).details_json));
      assert.equal(auditJson.includes(privateKey), false);
      assert.deepEqual(JSON.parse(auditJson), {
        application_key_fingerprint: generated.fingerprint,
        payment_revision_changed: false,
        revision: 1,
      });
      assert.equal(database.read((connection) => Number((connection.prepare(
        `SELECT COUNT(*) AS count FROM audit_events
          WHERE action = 'settings.provider_application_key_generated'`,
      ).get() as { count: bigint | number }).count)), 1);
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not overwrite the private key of an active provider application", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-settings-active-provider-key-"));
    const database = await AppDatabase.open(join(directory, "perpay.sqlite3"));
    try {
      let pauses = 0;
      let applies = 0;
      const settings = new RuntimeSettingsService({
        store: new RuntimeSettingsStore(database, masterKey),
        onPaymentMutationStarted: () => { pauses += 1; },
        onApplied: () => { applies += 1; },
      });
      settings.initialize();
      await settings.saveProvider(providerInput(0, "2026000000000001"), audit("active-provider"));
      const before = settings.view();
      const privateKeyBefore = settings.revealSecret("provider_private_key", audit("active-key-before"));
      pauses = 0;
      applies = 0;

      await assert.rejects(
        settings.generateProviderApplicationKey(before.revision, audit("active-key-regenerate")),
        (error: unknown) => error instanceof SettingsError &&
          error.code === "provider_application_key_rotation_not_supported",
      );
      assert.equal(settings.view().revision, before.revision);
      assert.equal(settings.view().payment_revision, before.payment_revision);
      assert.equal(
        settings.revealSecret("provider_private_key", audit("active-key-after")),
        privateKeyBefore,
      );
      assert.equal(pauses, 0);
      assert.equal(applies, 0);
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects replacing the private key while retaining the same active application", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-settings-active-key-update-"));
    const database = await AppDatabase.open(join(directory, "perpay.sqlite3"));
    try {
      const settings = service(database, masterKey);
      await settings.saveProvider(providerInput(0, "2026000000000001"), audit("active-provider"));
      const before = settings.view();
      const privateKeyBefore = settings.revealSecret(
        "provider_private_key",
        audit("active-private-key-before"),
      );
      const replacement = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey
        .export({ format: "pem", type: "pkcs8" })
        .toString();

      await assert.rejects(
        settings.saveProvider({
          ...providerInput(before.revision, "2026000000000001"),
          private_key: replacement,
        }, audit("replace-active-private-key")),
        (error: unknown) => error instanceof SettingsError &&
          error.code === "provider_application_key_rotation_not_supported",
      );

      assert.equal(settings.view().revision, before.revision);
      assert.equal(settings.view().payment_revision, before.payment_revision);
      assert.equal(
        settings.revealSecret("provider_private_key", audit("active-private-key-after")),
        privateKeyBefore,
      );
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects key generation when an immutable provider generation survives without runtime configuration", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-settings-historical-provider-key-"));
    const database = await AppDatabase.open(join(directory, "perpay.sqlite3"));
    try {
      const ledger = new LedgerStore(database);
      ledger.bindProviderIdentity({
        providerAccountKey: "source:historical",
        providerKind: "alipay",
        endpoint: "https://openapi.alipay.com",
        externalAccountId: "2026000000000042",
      }, 1);
      const settings = new RuntimeSettingsService({
        store: new RuntimeSettingsStore(database, masterKey),
        // Deliberately omit providerHistory to prove the transactional store guard
        // also protects callers whose history projection is stale or unavailable.
      });
      settings.initialize();

      assert.equal(settings.snapshot().activeProviderAccountKey, null);
      await assert.rejects(
        settings.generateProviderApplicationKey(0, audit("historical-key-regenerate")),
        (error: unknown) => error instanceof SettingsError &&
          error.code === "provider_application_key_rotation_not_supported",
      );
      assert.equal(settings.view().revision, 0);
      assert.equal(settings.view().application_public_key, null);
      assert.equal(
        database.read((connection) => Number((connection.prepare(
          `SELECT COUNT(*) AS count
             FROM runtime_secrets
            WHERE secret_name = 'provider_private_key'`,
        ).get() as { count: bigint | number }).count)),
        0,
      );
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not replace a missing guard while encrypted settings remain", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-settings-missing-guard-"));
    const database = await AppDatabase.open(join(directory, "perpay.sqlite3"));
    try {
      const settings = service(database, masterKey);
      await settings.rotateApiSecret(0, audit("missing-guard-secret"));
      const guard = database.read((connection) => connection.prepare(
        `SELECT cipher_version, nonce, ciphertext, authentication_tag, created_at
           FROM runtime_master_key_guard WHERE singleton_key = 1`,
      ).get() as {
        cipher_version: bigint | number;
        nonce: Uint8Array;
        ciphertext: Uint8Array;
        authentication_tag: Uint8Array;
        created_at: bigint | number;
      });

      database.write((connection) => {
        const deleteTrigger = connection.prepare(
          `SELECT sql FROM sqlite_schema
            WHERE type = 'trigger' AND name = 'runtime_master_key_guard_no_delete'`,
        ).get() as { sql: string };
        connection.exec("DROP TRIGGER runtime_master_key_guard_no_delete");
        connection.prepare(
          "DELETE FROM runtime_master_key_guard WHERE singleton_key = 1",
        ).run();
        connection.exec(deleteTrigger.sql);
      });
      const damaged = database.read((connection) => inspectDatabaseIntegrity(connection));
      assert.equal(damaged.ok, false);
      assert.equal(damaged.domainViolations, 1);

      assert.throws(
        () => new RuntimeSettingsStore(database, replacementMasterKey).initialize(),
        /guard is missing while encrypted settings still exist/i,
      );
      assert.equal(
        database.read((connection) => Number((connection.prepare(
          "SELECT COUNT(*) AS count FROM runtime_master_key_guard",
        ).get() as { count: bigint }).count)),
        0,
      );

      database.write((connection) => {
        connection.prepare(
          `INSERT INTO runtime_master_key_guard(
             singleton_key, cipher_version, nonce, ciphertext,
             authentication_tag, created_at
           ) VALUES (1, ?, ?, ?, ?, ?)`,
        ).run(
          guard.cipher_version,
          guard.nonce,
          guard.ciphertext,
          guard.authentication_tag,
          guard.created_at,
        );
      });
      const recovered = new RuntimeSettingsStore(database, masterKey);
      recovered.initialize();
      assert.equal(recovered.status().apiConfigured, true);
      assert.equal(
        database.read((connection) => inspectDatabaseIntegrity(connection)).ok,
        true,
      );
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rolls provider binding, activation, secrets, and configuration back together", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-settings-provider-"));
    const database = await AppDatabase.open(join(directory, "perpay.sqlite3"));
    try {
      const settings = service(database, masterKey);
      await settings.saveProvider(providerInput(0, "2026000000000001"), audit("first"));
      const before = settings.snapshot();
      assert.ok(before.activeProviderAccountKey);
      database.write((connection) => connection.exec(`
        CREATE TRIGGER test_abort_runtime_provider_update
        BEFORE UPDATE ON runtime_configuration
        WHEN NEW.provider_app_id = '2026000000000002'
        BEGIN
          SELECT RAISE(ABORT, 'injected provider settings failure');
        END;
      `));

      await assert.rejects(
        settings.saveProvider(
          providerInput(before.revision, "2026000000000002"),
          audit("failed-switch"),
        ),
        /injected provider settings failure/,
      );
      const after = settings.snapshot();
      assert.equal(after.revision, before.revision);
      assert.equal(after.paymentRevision, before.paymentRevision);
      assert.equal(after.activeProviderAccountKey, before.activeProviderAccountKey);
      assert.deepEqual(database.read((connection) => ({
        bindings: Number((connection.prepare(
          "SELECT COUNT(*) AS count FROM provider_account_bindings",
        ).get() as { count: bigint }).count),
        activations: Number((connection.prepare(
          "SELECT COUNT(*) AS count FROM provider_account_activations",
        ).get() as { count: bigint }).count),
        providerSecrets: Number((connection.prepare(
          `SELECT COUNT(*) AS count FROM runtime_secrets
            WHERE secret_name IN ('provider_private_key', 'provider_public_key')`,
        ).get() as { count: bigint }).count),
      })), {
        bindings: 1,
        activations: 1,
        providerSecrets: 2,
      });
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("creates a fresh namespace when a previously used application becomes active again", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-settings-provider-return-"));
    const database = await AppDatabase.open(join(directory, "perpay.sqlite3"));
    try {
      const settings = service(database, masterKey);
      await settings.saveProvider(providerInput(0, "2026000000000001"), audit("provider-a1"));
      const first = settings.snapshot().activeProviderAccountKey;
      const firstPrivateKey = settings.revealSecret("provider_private_key", audit("provider-a1-key"));
      await settings.saveProvider(
        providerInputWithoutPrivateKey(1, "2026000000000002"),
        audit("provider-b"),
      );
      const second = settings.snapshot().activeProviderAccountKey;
      await settings.saveProvider(
        providerInputWithoutPrivateKey(2, "2026000000000001"),
        audit("provider-a2"),
      );
      const third = settings.snapshot().activeProviderAccountKey;

      assert.ok(first);
      assert.ok(second);
      assert.ok(third);
      assert.equal(new Set([first, second, third]).size, 3);
      assert.equal(
        settings.revealSecret("provider_private_key", audit("provider-a2-key")),
        firstPrivateKey,
      );
      assert.deepEqual(database.read((connection) => ({
        bindings: Number((connection.prepare(
          "SELECT COUNT(*) AS count FROM provider_account_bindings",
        ).get() as { count: bigint }).count),
        activations: Number((connection.prepare(
          "SELECT COUNT(*) AS count FROM provider_account_activations",
        ).get() as { count: bigint }).count),
      })), { bindings: 3, activations: 3 });
      assert.equal(database.integrityCheck().ok, true);
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("retries applying a committed setting before reporting success", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-settings-apply-retry-"));
    const database = await AppDatabase.open(join(directory, "perpay.sqlite3"));
    try {
      let attempts = 0;
      const settings = new RuntimeSettingsService({
        store: new RuntimeSettingsStore(database, masterKey),
        onApplied: () => {
          attempts += 1;
          if (attempts === 1) throw new Error("injected first apply failure");
        },
      });
      settings.initialize();

      const rotated = await settings.rotateApiSecret(0, audit("apply-retry"));
      assert.equal(attempts, 2);
      assert.equal(rotated.settings.revision, 1);
      assert.equal(settings.revealSecret("api_secret", audit("apply-retry-reveal")), rotated.secret);
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("saves advanced checkout policy without advancing payment revision or replacing schedulers", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-settings-advanced-"));
    const database = await AppDatabase.open(join(directory, "perpay.sqlite3"));
    try {
      let applyCount = 0;
      const settings = new RuntimeSettingsService({
        store: new RuntimeSettingsStore(database, masterKey),
        onApplied: () => {
          applyCount += 1;
        },
      });
      const initial = settings.initialize();
      assert.deepEqual(initial.advanced, {
        checkoutKeyRotationDays: 90,
        checkoutTerminalObservationSeconds: 86_400,
      });

      const view = await settings.saveAdvanced({
        revision: initial.revision,
        checkout_key_rotation_days: 30,
        checkout_terminal_observation_seconds: 3_600,
      }, audit("advanced"));

      assert.equal(view.revision, initial.revision + 1);
      assert.equal(view.payment_revision, initial.paymentRevision);
      assert.deepEqual(view.advanced, {
        checkout_key_rotation_days: 30,
        checkout_terminal_observation_seconds: 3_600,
      });
      assert.equal(applyCount, 0);
      assert.deepEqual(settings.snapshot().advanced, {
        checkoutKeyRotationDays: 30,
        checkoutTerminalObservationSeconds: 3_600,
      });
      assert.throws(
        () => database.write((connection) => connection.prepare(
          `UPDATE runtime_configuration
              SET revision = revision + 1,
                  checkout_key_rotation_days = 0,
                  updated_at = updated_at + 1
            WHERE singleton_key = 1`,
        ).run()),
        /CHECK constraint failed/,
      );
      const auditDetails = database.read((connection) => connection.prepare(
        `SELECT details_json FROM audit_events
          WHERE action = 'settings.advanced_updated'`,
      ).get() as { details_json: string });
      assert.deepEqual(JSON.parse(auditDetails.details_json), {
        checkout_key_rotation_days: 30,
        checkout_terminal_observation_seconds: 3_600,
        payment_revision_changed: false,
        revision: 1,
      });
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("validates provider keys before pausing payment work or running the switch guard", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-settings-provider-validation-"));
    const database = await AppDatabase.open(join(directory, "perpay.sqlite3"));
    try {
      let pauses = 0;
      let guards = 0;
      const settings = new RuntimeSettingsService({
        store: new RuntimeSettingsStore(database, masterKey),
        onPaymentMutationStarted: () => {
          pauses += 1;
        },
        guardProviderSwitch: () => {
          guards += 1;
        },
      });
      settings.initialize();

      await assert.rejects(
        settings.saveProvider({
          ...providerInput(0, "2026000000000001"),
          private_key: "not-an-rsa-private-key",
        }, audit("provider-validation")),
        /provider private key .*invalid|valid RSA private key/u,
      );
      assert.equal(pauses, 0);
      assert.equal(guards, 0);
      assert.equal(settings.status().revision, 0);
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("enters transition mode before awaiting the provider guard and restores after rejection", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-settings-provider-transition-"));
    const database = await AppDatabase.open(join(directory, "perpay.sqlite3"));
    try {
      const guardEntered = deferred<void>();
      const releaseGuard = deferred<void>();
      const guardFailure = new SettingsError("provider_switch_blocked", "injected guard failure");
      let transitioning = false;
      const appliedRevisions: number[] = [];
      const settings = new RuntimeSettingsService({
        store: new RuntimeSettingsStore(database, masterKey),
        providerHistory: () => [{
          activationId: "11111111-1111-4111-8111-111111111111",
          sequence: 1,
          providerAccountKey: "source:existing",
          previousProviderAccountKey: null,
          activatedAt: 1,
          reason: "CONFIG_SYNC",
          providerKind: "alipay",
          endpoint: "https://openapi.alipay.com",
          externalAccountId: "2026000000000000",
          identityFingerprintVersion: 1,
          identityFingerprint: "a".repeat(64),
          boundAt: 1,
        }],
        onPaymentMutationStarted: () => {
          transitioning = true;
        },
        guardProviderSwitch: async () => {
          assert.equal(transitioning, true);
          guardEntered.resolve();
          await releaseGuard.promise;
          throw guardFailure;
        },
        onApplied: (snapshot) => {
          appliedRevisions.push(snapshot.revision);
          transitioning = false;
        },
      });
      settings.initialize();

      const saving = settings.saveProvider(
        providerInput(0, "2026000000000001"),
        audit("provider-transition"),
      );
      await guardEntered.promise;
      assert.equal(transitioning, true);
      assert.equal(settings.status().revision, 0);
      releaseGuard.resolve();
      await assert.rejects(saving, (error: unknown) => error === guardFailure);
      assert.deepEqual(appliedRevisions, [0]);
      assert.equal(transitioning, false);
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("preserves both the mutation and restoration failures", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-settings-restore-failure-"));
    const database = await AppDatabase.open(join(directory, "perpay.sqlite3"));
    try {
      const guardFailure = new SettingsError("provider_switch_blocked", "guard failed");
      const restoreFailure = new Error("runtime restore failed");
      const settings = new RuntimeSettingsService({
        store: new RuntimeSettingsStore(database, masterKey),
        providerHistory: () => [{
          activationId: "11111111-1111-4111-8111-111111111112",
          sequence: 1,
          providerAccountKey: "source:existing",
          previousProviderAccountKey: null,
          activatedAt: 1,
          reason: "CONFIG_SYNC",
          providerKind: "alipay",
          endpoint: "https://openapi.alipay.com",
          externalAccountId: "2026000000000000",
          identityFingerprintVersion: 1,
          identityFingerprint: "b".repeat(64),
          boundAt: 1,
        }],
        guardProviderSwitch: () => {
          throw guardFailure;
        },
        onApplied: () => {
          throw restoreFailure;
        },
      });
      settings.initialize();

      await assert.rejects(
        settings.saveProvider(providerInput(0, "2026000000000001"), audit("restore-failure")),
        (error: unknown) =>
          error instanceof AggregateError &&
          error.message === "settings mutation failed and the previous runtime could not be restored" &&
          error.errors[0] === guardFailure &&
          error.errors[1] === restoreFailure,
      );
      assert.equal(settings.status().revision, 0);
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("retries collection profile publication and runtime application as one unit", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-settings-whole-apply-retry-"));
    const database = await AppDatabase.open(join(directory, "perpay.sqlite3"));
    try {
      let collectionAttempts = 0;
      let applyAttempts = 0;
      const settings = new RuntimeSettingsService({
        store: new RuntimeSettingsStore(database, masterKey),
        onCollectionApplied: () => {
          collectionAttempts += 1;
          if (collectionAttempts === 1) throw new Error("injected profile publication failure");
        },
        onApplied: () => {
          applyAttempts += 1;
        },
      });
      settings.initialize();
      await settings.saveProvider(providerInput(0, "2026000000000001"), audit("whole-retry-provider"));
      collectionAttempts = 0;
      applyAttempts = 0;

      const view = await settings.saveCollection({
        revision: 1,
        code_payload: "https://qr.example.test/whole-apply-retry",
        order_ttl_seconds: 300,
        amount_offset_maximum_cents: 19,
      }, audit("whole-retry-collection"));
      assert.equal(view.revision, 2);
      assert.equal(collectionAttempts, 2);
      assert.equal(applyAttempts, 1);
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps a committed API secret recoverable when runtime application fails twice", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-settings-api-apply-failure-"));
    const database = await AppDatabase.open(join(directory, "perpay.sqlite3"));
    try {
      const settings = new RuntimeSettingsService({
        store: new RuntimeSettingsStore(database, masterKey),
        onApplied: () => {
          throw new Error("injected runtime application failure");
        },
      });
      settings.initialize();

      await assert.rejects(
        settings.rotateApiSecret(0, audit("api-apply-failure")),
        (error: unknown) => error instanceof AggregateError && error.errors.length === 2,
      );
      const recovered = settings.revealSecret("api_secret", audit("api-apply-reveal"));
      assert.match(recovered, /^[A-Za-z0-9_-]{43}$/u);
      assert.equal(settings.apiCredential()?.secret, recovered);
      assert.equal(settings.status().revision, 1);
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function service(database: AppDatabase, key: Uint8Array): RuntimeSettingsService {
  const settings = new RuntimeSettingsService({
    store: new RuntimeSettingsStore(database, key),
  });
  settings.initialize();
  return settings;
}

function providerInput(revision: number, appId: string) {
  return {
    revision,
    environment: "SANDBOX" as const,
    app_id: appId,
    private_key: applicationPrivateKey,
    platform_public_key: platformPublicKey,
    timeout_milliseconds: 8_000,
    scan_interval_seconds: 10,
    maximum_success_age_seconds: 60,
  };
}

function providerInputWithoutPrivateKey(revision: number, appId: string) {
  return {
    revision,
    environment: "SANDBOX" as const,
    app_id: appId,
    platform_public_key: platformPublicKey,
    timeout_milliseconds: 8_000,
    scan_interval_seconds: 10,
    maximum_success_age_seconds: 60,
  };
}

function audit(suffix: string) {
  return {
    actorId: "admin",
    requestId: `settings-${suffix}`,
    remoteAddressHash: "a".repeat(64),
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
