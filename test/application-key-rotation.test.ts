import { apiClientCredentialsDowngradeSql } from "./api-client-schema-fixture.ts";
import assert from "node:assert/strict";
import { createPublicKey, randomUUID, sign, verify } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { ZodError } from "zod";
import { SettingsError, RuntimeSettingsStore, RuntimeSettingsService } from "../src/settings/index.ts";
import {
  changeRequest,
  keyAudit,
  keyMaster,
  nextPlatformPem,
  providerInput,
  withKeyFixture,
} from "./application-key-fixture.ts";

const errorCode = (code: SettingsError["code"]) => (error: unknown) =>
  error instanceof SettingsError && error.code === code;

describe("application key regeneration and staged rotation", () => {
  it("regenerates the initial pair explicitly and replays the same operation", async () => {
    await withKeyFixture(false, async (f) => {
      const before = f.settings.view();
      const request = changeRequest(f.settings);
      const generated = await f.settings.regenerateProviderApplicationKey(
        request,
        keyAudit(),
      );
      assert.equal(generated.created, true);
      assert.notEqual(generated.public_key, before.application_public_key);
      assert.equal(
        generated.settings.application_public_key,
        generated.public_key,
      );
      assert.equal(generated.settings.pending_application_key, null);
      assert.equal(
        generated.settings.payment_revision,
        before.payment_revision,
      );
      assert.equal(generated.settings.revision, before.revision + 1);
      const stored = f.store.providerApplicationKey()!;
      const publicKey = createPublicKey({
        key: Buffer.from(generated.public_key, "base64"),
        format: "der",
        type: "spki",
      });
      assert.equal(
        verify(
          "RSA-SHA256",
          Buffer.from("test"),
          publicKey,
          sign("RSA-SHA256", Buffer.from("test"), stored.privateKey),
        ),
        true,
      );
      assert.equal(
        JSON.stringify(generated).includes(stored.privateKeyPem),
        false,
      );
      const replay = await f.settings.regenerateProviderApplicationKey(
        request,
        keyAudit(),
      );
      assert.equal(replay.created, false);
      assert.equal(replay.public_key, generated.public_key);
      assert.equal(replay.settings.revision, generated.settings.revision);
      assert.deepEqual(f.events, []);
      await assert.rejects(
        f.settings.regenerateProviderApplicationKey(
          { ...request, change_id: randomUUID() },
          keyAudit(),
        ),
        errorCode("settings_revision_conflict"),
      );
      await assert.rejects(
        f.settings.regenerateProviderApplicationKey(
          { ...request, base_fingerprint: generated.fingerprint },
          keyAudit(),
        ),
        errorCode("provider_application_key_change_conflict"),
      );
      assert.equal(f.database.integrityCheck().ok, true);
    });
  });

  it("keeps the active private key while encrypting a durable pending replacement", async () => {
    await withKeyFixture(true, async (f) => {
      const before = f.settings.view();
      const activePrivate = f.settings.snapshot().provider!.privateKeyPem;
      const request = changeRequest(f.settings);
      const generated = await f.settings.regenerateProviderApplicationKey(
        request,
        keyAudit(),
      );
      const pending = generated.settings.pending_application_key!;
      assert.equal(pending.change_id, request.change_id);
      assert.equal(pending.public_key, generated.public_key);
      assert.equal(
        generated.settings.application_public_key,
        before.application_public_key,
      );
      assert.equal(
        f.settings.snapshot().provider!.privateKeyPem,
        activePrivate,
      );
      assert.equal(
        generated.settings.payment_revision,
        before.payment_revision,
      );
      assert.deepEqual(f.events, []);
      const change = f.store.applicationKeyChange(request.change_id)!;
      const row = f.database.read((db) =>
        db
          .prepare(
            "SELECT ciphertext, nonce, authentication_tag FROM provider_application_key_changes WHERE change_id = ?",
          )
          .get(request.change_id),
      )!;
      assert.equal(
        Buffer.from(row.ciphertext as Uint8Array).includes(
          Buffer.from(change.key!.privateKeyPem),
        ),
        false,
      );
      assert.equal((row.nonce as Uint8Array).byteLength, 12);
      assert.equal((row.authentication_tag as Uint8Array).byteLength, 16);
      assert.equal(JSON.stringify(generated).includes("PRIVATE KEY"), false);
      const audits = f.database.read((db) =>
        db.prepare("SELECT details_json FROM audit_events").all(),
      );
      assert.equal(
        JSON.stringify(audits).includes(change.key!.privateKeyPem),
        false,
      );
      await f.reopen();
      assert.deepEqual(f.settings.view().pending_application_key, pending);
      assert.equal(
        f.settings.snapshot().provider!.privateKeyPem,
        activePrivate,
      );
      assert.equal(
        (await f.settings.regenerateProviderApplicationKey(request, keyAudit()))
          .created,
        false,
      );
      assert.throws(
        () =>
          new RuntimeSettingsStore(
            f.database,
            Buffer.alloc(32, 0x42),
          ).initialize(),
        /MASTER_KEY/,
      );
      assert.equal(f.database.integrityCheck().ok, true);
    });
  });

  it("requires an explicit non-blank Alipay public key even for direct service callers", async () => {
    await withKeyFixture(true, async (f) => {
      const generated = await f.settings.regenerateProviderApplicationKey(changeRequest(f.settings), keyAudit());
      const before = f.settings.snapshot();
      for (const value of [undefined, "", " \n\t "]) {
        const input = {
          revision: generated.settings.revision,
          change_id: generated.settings.pending_application_key!.change_id,
          ...(value === undefined ? {} : { platform_public_key: value }),
        };
        await assert.rejects(
          f.settings.activateProviderApplicationKey(
            input as Parameters<RuntimeSettingsService["activateProviderApplicationKey"]>[0], keyAudit(),
          ),
          (error: unknown) => error instanceof ZodError && error.issues.some(issue => issue.path[0] === "platform_public_key"),
        );
        assert.deepEqual(f.settings.snapshot(), before);
        assert.deepEqual(f.settings.view(), generated.settings);
        assert.deepEqual(f.events, []);
      }
    });
  });

  it("verifies before pausing and atomically activates the matching pair and latest Alipay public key", async () => {
    await withKeyFixture(true, async (f) => {
      const history = f.ledger.providerIdentityHistory();
      const generated = await f.settings.regenerateProviderApplicationKey(
        changeRequest(f.settings),
        keyAudit(),
      );
      const pending = generated.settings.pending_application_key!;
      const account = generated.settings.provider!.provider_account_key;
      f.hooks.verify = async (provider) => {
        assert.equal(provider.applicationKeyFingerprint, pending.fingerprint);
        assert.equal(provider.publicKeyPem, nextPlatformPem.trim());
        assert.notEqual(
          f.settings.snapshot().provider!.applicationKeyFingerprint,
          pending.fingerprint,
        );
      };
      const request = {
        revision: generated.settings.revision,
        change_id: pending.change_id,
        platform_public_key: nextPlatformPem,
      };
      const saved = await f.settings.activateProviderApplicationKey(
        request,
        keyAudit(),
      );
      assert.deepEqual(f.events, ["verify", "pause", "apply"]);
      assert.equal(saved.application_public_key, pending.public_key);
      assert.equal(saved.pending_application_key, null);
      assert.equal(saved.provider!.provider_account_key, account);
      assert.equal(
        saved.payment_revision,
        generated.settings.payment_revision + 1,
      );
      assert.equal(
        f.settings.snapshot().provider!.publicKeyPem,
        nextPlatformPem.trim(),
      );
      assert.deepEqual(f.ledger.providerIdentityHistory(), history);
      const row = f.database.read((db) =>
        db
          .prepare(
            "SELECT state, ciphertext FROM provider_application_key_changes WHERE change_id = ?",
          )
          .get(pending.change_id),
      )!;
      assert.equal(row.state, "ACTIVATED");
      assert.equal(row.ciphertext, null);
      const replay = await f.settings.activateProviderApplicationKey(
        request,
        keyAudit(),
      );
      assert.deepEqual(replay, saved);
      assert.equal(f.events.filter((event) => event === "verify").length, 1);
      await assert.rejects(
        f.settings.activateProviderApplicationKey(
          { ...request, revision: request.revision + 1 },
          keyAudit(),
        ),
        errorCode("provider_application_key_change_conflict"),
      );
      assert.equal(f.database.integrityCheck().ok, true);
    });
  });

  it("preserves active and pending keys on verification failure and can retry", async () => {
    await withKeyFixture(true, async (f) => {
      const generated = await f.settings.regenerateProviderApplicationKey(
        changeRequest(f.settings),
        keyAudit(),
      );
      const before = f.settings.view();
      const request = {
        platform_public_key: nextPlatformPem,
        revision: before.revision,
        change_id: generated.settings.pending_application_key!.change_id,
      };
      f.hooks.verify = async () => {
        throw new Error("private-sensitive-response-must-not-leak");
      };
      await assert.rejects(
        f.settings.activateProviderApplicationKey(request, keyAudit()),
        (error: unknown) => {
          assert.ok(error instanceof SettingsError);
          assert.equal(
            error.code,
            "provider_application_key_verification_failed",
          );
          assert.equal(error.message.includes("private-sensitive"), false);
          return true;
        },
      );
      assert.deepEqual(f.settings.view(), before);
      assert.deepEqual(f.events, ["verify"]);
      f.hooks.verify = async () => {};
      const saved = await f.settings.activateProviderApplicationKey(
        request,
        keyAudit(),
      );
      assert.equal(saved.application_key_fingerprint, generated.fingerprint);
    });
  });

  it("rejects using the pending application public key as the Alipay public key before verification", async () => {
    await withKeyFixture(true, async (f) => {
      const generated = await f.settings.regenerateProviderApplicationKey(
        changeRequest(f.settings),
        keyAudit(),
      );
      await assert.rejects(
        f.settings.activateProviderApplicationKey(
          {
            revision: generated.settings.revision,
            change_id: generated.settings.pending_application_key!.change_id,
            platform_public_key: generated.public_key,
          },
          keyAudit(),
        ),
        /platform public key/,
      );
      assert.deepEqual(f.events, []);
      assert.deepEqual(f.settings.view(), generated.settings);
    });
  });

  it("serializes competing requests and reuses an identical concurrent generation", async () => {
    await withKeyFixture(true, async (f) => {
      const request = changeRequest(f.settings);
      const [first, second] = await Promise.all([
        f.settings.regenerateProviderApplicationKey(request, keyAudit()),
        f.settings.regenerateProviderApplicationKey(request, keyAudit()),
      ]);
      assert.equal(first.created, true);
      assert.equal(second.created, false);
      assert.equal(first.public_key, second.public_key);
      await assert.rejects(
        f.settings.regenerateProviderApplicationKey(
          changeRequest(f.settings),
          keyAudit(),
        ),
        errorCode("provider_application_key_change_pending"),
      );
      const activate = {
        platform_public_key: nextPlatformPem,
        revision: first.settings.revision,
        change_id: request.change_id,
      };
      const saved = await Promise.all([
        f.settings.activateProviderApplicationKey(activate, keyAudit()),
        f.settings.activateProviderApplicationKey(activate, keyAudit()),
      ]);
      assert.deepEqual(saved[0], saved[1]);
      assert.equal(f.events.filter((event) => event === "verify").length, 1);
    });
  });

  it("blocks provider identity switches but allows timing edits and rejects stale activation", async () => {
    await withKeyFixture(true, async (f) => {
      const generated = await f.settings.regenerateProviderApplicationKey(
        changeRequest(f.settings),
        keyAudit(),
      );
      const input = providerInput(generated.settings.revision);
      await assert.rejects(
        f.settings.saveProvider({ ...input, app_id: "other-app" }, keyAudit()),
        errorCode("provider_application_key_change_pending"),
      );
      const updated = await f.settings.saveProvider(
        { ...input, timeout_milliseconds: 5000 },
        keyAudit(),
      );
      const changeId = generated.settings.pending_application_key!.change_id;
      f.events.length = 0;
      await assert.rejects(
        f.settings.activateProviderApplicationKey(
          { platform_public_key: nextPlatformPem, revision: generated.settings.revision, change_id: changeId },
          keyAudit(),
        ),
        errorCode("settings_revision_conflict"),
      );
      assert.deepEqual(f.events, []);
      f.hooks.verify = async (provider) => {
        assert.equal(provider.timeoutMilliseconds, 5000);
      };
      const saved = await f.settings.activateProviderApplicationKey(
        { platform_public_key: nextPlatformPem, revision: updated.revision, change_id: changeId },
        keyAudit(),
      );
      assert.equal(saved.provider!.timeout_milliseconds, 5000);
    });
  });

  it("discards pending material without replacing the active pair or touching payment runtime", async () => {
    await withKeyFixture(true, async (f) => {
      const before = f.settings.view();
      const generated = await f.settings.regenerateProviderApplicationKey(
        changeRequest(f.settings),
        keyAudit(),
      );
      const request = {
        revision: generated.settings.revision,
        change_id: generated.settings.pending_application_key!.change_id,
      };
      const discarded = await f.settings.discardProviderApplicationKey(
        request,
        keyAudit(),
      );
      assert.equal(discarded.pending_application_key, null);
      assert.equal(
        discarded.application_public_key,
        before.application_public_key,
      );
      assert.equal(discarded.payment_revision, before.payment_revision);
      assert.deepEqual(f.events, []);
      assert.deepEqual(
        await f.settings.discardProviderApplicationKey(request, keyAudit()),
        discarded,
      );
      await assert.rejects(
        f.settings.activateProviderApplicationKey(
          { platform_public_key: nextPlatformPem, ...request, revision: discarded.revision },
          keyAudit(),
        ),
        errorCode("provider_application_key_change_conflict"),
      );
      const record = f.store.applicationKeyChange(request.change_id)!;
      assert.equal(record.key, null);
      assert.equal(record.state, "DISCARDED");
      assert.throws(
        () =>
          f.database.write((db) =>
            db
              .prepare(
                "DELETE FROM provider_application_key_changes WHERE change_id = ?",
              )
              .run(request.change_id),
          ),
        /cannot be deleted/,
      );
      assert.throws(
        () =>
          f.database.write((db) =>
            db
              .prepare(
                "UPDATE provider_application_key_changes SET state = 'ACTIVATED' WHERE change_id = ?",
              )
              .run(request.change_id),
          ),
        /transition/,
      );
      assert.equal(
        (
          await f.settings.regenerateProviderApplicationKey(
            changeRequest(f.settings),
            keyAudit(),
          )
        ).created,
        true,
      );
    });
  });

  it("does not activate a cancelled verification and restores runtime if cancelled while pausing", async () => {
    await withKeyFixture(true, async (f) => {
      const generated = await f.settings.regenerateProviderApplicationKey(
        changeRequest(f.settings),
        keyAudit(),
      );
      const request = {
        platform_public_key: nextPlatformPem,
        revision: generated.settings.revision,
        change_id: generated.settings.pending_application_key!.change_id,
      };
      const cancelled = new AbortController();
      cancelled.abort();
      await assert.rejects(
        f.settings.activateProviderApplicationKey(
          request,
          keyAudit(),
          cancelled.signal,
        ),
        errorCode("provider_application_key_verification_failed"),
      );
      assert.deepEqual(f.events, []);
      const abortOnPause = new AbortController();
      f.hooks.pause = async () => {
        abortOnPause.abort();
      };
      await assert.rejects(
        f.settings.activateProviderApplicationKey(
          request,
          keyAudit(),
          abortOnPause.signal,
        ),
        errorCode("provider_application_key_verification_failed"),
      );
      assert.deepEqual(f.settings.view(), generated.settings);
      assert.deepEqual(f.events, ["verify", "pause", "apply"]);
    });
  });

  it("rechecks the revision after verification and restores the actual current runtime on conflict", async () => {
    await withKeyFixture(true, async (f) => {
      const generated = await f.settings.regenerateProviderApplicationKey(
        changeRequest(f.settings),
        keyAudit(),
      );
      f.hooks.verify = async () => {
        f.store.saveAdvanced(
          {
            revision: generated.settings.revision,
            checkout_key_rotation_days: 30,
            checkout_terminal_observation_seconds: 86400,
          },
          keyAudit(),
        );
      };
      await assert.rejects(
        f.settings.activateProviderApplicationKey(
          {
            platform_public_key: nextPlatformPem,
            revision: generated.settings.revision,
            change_id: generated.settings.pending_application_key!.change_id,
          },
          keyAudit(),
        ),
        errorCode("settings_revision_conflict"),
      );
      assert.equal(
        f.settings.view().application_public_key,
        generated.settings.application_public_key,
      );
      assert.deepEqual(
        f.settings.view().pending_application_key,
        generated.settings.pending_application_key,
      );
      assert.deepEqual(f.events, ["verify", "pause", "apply"]);
      assert.equal(
        f.settings.view().payment_revision,
        generated.settings.payment_revision,
      );
    });
  });

  it("recovers a committed activation after runtime application fails without rotating again", async () => {
    await withKeyFixture(true, async (f) => {
      const generated = await f.settings.regenerateProviderApplicationKey(
        changeRequest(f.settings),
        keyAudit(),
      );
      const request = {
        platform_public_key: nextPlatformPem,
        revision: generated.settings.revision,
        change_id: generated.settings.pending_application_key!.change_id,
      };
      f.hooks.apply = async () => {
        throw new Error("test runtime failure");
      };
      await assert.rejects(
        f.settings.activateProviderApplicationKey(request, keyAudit()),
        AggregateError,
      );
      assert.equal(
        f.settings.view().application_key_fingerprint,
        generated.fingerprint,
      );
      assert.equal(f.settings.view().pending_application_key, null);
      f.hooks.apply = async () => {};
      const recovered = await f.settings.activateProviderApplicationKey(
        request,
        keyAudit(),
      );
      assert.equal(
        recovered.payment_revision,
        generated.settings.payment_revision + 1,
      );
      assert.equal(f.events.filter((event) => event === "verify").length, 1);
    });
  });

  it("preserves the encrypted pending pair through backup and restore", async () => {
    await withKeyFixture(true, async (f) => {
      const generated = await f.settings.regenerateProviderApplicationKey(
        changeRequest(f.settings),
        keyAudit(),
      );
      const backup = join(f.directory, "rotation-backup.sqlite3");
      await f.database.backupDetailed(backup);
      await f.reopen(backup);
      assert.deepEqual(f.settings.view(), generated.settings);
      assert.equal(f.database.integrityCheck().ok, true);
      const activated = await f.settings.activateProviderApplicationKey(
        {
          platform_public_key: nextPlatformPem,
          revision: generated.settings.revision,
          change_id: generated.settings.pending_application_key!.change_id,
        },
        keyAudit(),
      );
      assert.equal(
        activated.application_key_fingerprint,
        generated.fingerprint,
      );
    });
  });

  it("upgrades schema 27 without rewriting active credentials or configuration", async () => {
    await withKeyFixture(true, async (f) => {
      const capture = () =>
        f.database.read((db) => ({
          config: db.prepare("SELECT * FROM runtime_configuration").get(),
          secrets: db
            .prepare("SELECT * FROM runtime_secrets ORDER BY secret_name")
            .all(),
          migrations: db
            .prepare(
              "SELECT * FROM schema_migrations WHERE version <= 27 ORDER BY version",
            )
            .all(),
        }));
      const original = capture();
      f.database.close();
      const previous = new DatabaseSync(f.databasePath);
      try {
        previous.exec(
          `${apiClientCredentialsDowngradeSql()} DROP TABLE provider_application_key_changes; DELETE FROM schema_migrations WHERE version = 28;`,
        );
      } finally {
        previous.close();
      }
      await f.reopen();
      assert.deepEqual(capture(), original);
      assert.equal(f.settings.view().pending_application_key, null);
      assert.equal(f.database.integrityCheck().ok, true);
      assert.ok(
        new RuntimeSettingsStore(
          f.database,
          keyMaster,
        ).providerApplicationKey(),
      );
    });
  });
  it("rolls both active secrets and pending state back if the final write fails", async () => {
    await withKeyFixture(true, async (f) => {
      const generated = await f.settings.regenerateProviderApplicationKey(changeRequest(f.settings), keyAudit());
      const before = f.settings.view();
      const secrets = () => f.database.read(db => db.prepare("SELECT * FROM runtime_secrets ORDER BY secret_name").all());
      const beforeSecrets = secrets();
      f.database.write(db => db.exec(`
        CREATE TRIGGER test_reject_key_activation BEFORE UPDATE ON provider_application_key_changes
        BEGIN SELECT RAISE(ABORT, 'synthetic final write failure'); END;
      `));
      try {
        await assert.rejects(f.settings.activateProviderApplicationKey({
          platform_public_key: nextPlatformPem,
          revision: before.revision, change_id: generated.settings.pending_application_key!.change_id,
        }, keyAudit()), /synthetic final write failure/);
        assert.deepEqual(f.settings.view(), before);
        assert.deepEqual(secrets(), beforeSecrets);
        assert.deepEqual(f.events, ["verify", "pause", "apply"]);
      } finally { f.database.write(db => db.exec("DROP TRIGGER test_reject_key_activation")); }
      assert.equal(f.database.integrityCheck().ok, true);
    });
  });

  it("uses the database revision guard across independent service instances", async () => {
    await withKeyFixture(true, async (f) => {
      const second = new RuntimeSettingsService({ store: f.store });
      const results = await Promise.allSettled([
        f.settings.regenerateProviderApplicationKey(changeRequest(f.settings), keyAudit()),
        second.regenerateProviderApplicationKey(changeRequest(second), keyAudit()),
      ]);
      assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
      const failed = results.find(result => result.status === "rejected") as PromiseRejectedResult;
      assert.ok(errorCode("settings_revision_conflict")(failed.reason));
      assert.equal(f.database.read(db => Number((db.prepare("SELECT COUNT(*) AS count FROM provider_application_key_changes").get() as { count: bigint }).count)), 1);
      assert.ok(f.settings.view().pending_application_key);
      assert.equal(f.database.integrityCheck().ok, true);
    });
  });

});
