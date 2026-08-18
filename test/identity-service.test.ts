import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { loadConfig } from "../src/config.ts";
import { AppDatabase } from "../src/database/database.ts";
import { appendAuditEvent } from "../src/database/identity-store.ts";
import { PasswordInputError } from "../src/identity/crypto.ts";
import { IDENTITY_LIMITS, IdentityError, IdentityService, fingerprintApiSecret } from "../src/identity/service.ts";

const adminPassword = "a-secure-local-password";
const apiSecret = Buffer.alloc(32, 7).toString("base64url");
const masterKey = "0123456789abcdef".repeat(4);

async function fixture(
  clock = { now: Date.parse("2026-08-14T12:00:00Z") },
  setup = true,
) {
  const directory = mkdtempSync(join(tmpdir(), "perpay-identity-"));
  const config = loadConfig({
    PERPAY_MASTER_KEY: masterKey,
    PERPAY_DATA_DIR: directory,
  });
  const database = await AppDatabase.open(config.databasePath);
  const identity = new IdentityService(database, () => clock.now);
  await identity.initialize();
  if (setup) {
    await identity.setupAdmin(adminPassword, { sourceAddress: "127.0.0.1" });
    identity.store.transaction((transaction) => {
      transaction.syncApiClient("default", fingerprintApiSecret(apiSecret), clock.now);
    });
  }
  return {
    directory,
    database,
    config,
    identity,
    clock,
    close() {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

describe("IdentityService", () => {
  it("starts with an uninitialized administrator and keeps login closed", async () => {
    const test = await fixture(undefined, false);
    try {
      await test.identity.initialize();
      assert.equal(test.identity.isInitialized(), false);
      assert.equal(
        test.identity.store.read((transaction) => transaction.adminIdentity()),
        undefined,
      );
      await assert.rejects(
        test.identity.login(adminPassword),
        (error: unknown) =>
          error instanceof IdentityError && error.code === "identity_not_initialized",
      );
    } finally {
      test.close();
    }
  });

  it("allows exactly one concurrent first-time setup and permanently closes setup", async () => {
    const test = await fixture(undefined, false);
    try {
      const sources = ["192.0.2.10", "192.0.2.11"] as const;
      const competing = new IdentityService(test.database, () => test.clock.now + 1);
      const results = await Promise.allSettled([
        test.identity.setupAdmin(adminPassword, {
          requestId: "setup-one",
          sourceAddress: sources[0],
        }),
        competing.setupAdmin("another-secure-password", {
          requestId: "setup-two",
          sourceAddress: sources[1],
        }),
      ]);
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      const rejectedIndex = results.findIndex((result) => result.status === "rejected");
      const fulfilledIndex = results.findIndex((result) => result.status === "fulfilled");
      const rejected = results[rejectedIndex];
      assert.ok(rejected);
      assert.equal(rejected.status, "rejected");
      assert.ok(rejected.reason instanceof IdentityError);
      assert.equal(rejected.reason.code, "identity_already_initialized");

      const losingLimit = test.identity.store.read((transaction) =>
        transaction.authLimit(test.identity.sourceHash(sources[rejectedIndex]!))
      );
      assert.equal(losingLimit?.failureCount, 1);
      assert.equal(
        test.identity.store.read((transaction) =>
          transaction.authLimit(test.identity.sourceHash(sources[fulfilledIndex]!))
        ),
        undefined,
      );

      assert.equal(test.identity.isInitialized(), true);
      const admin = test.identity.store.read((transaction) => transaction.adminIdentity());
      assert.equal(admin?.username, "admin");
      assert.ok(admin?.passwordHash.startsWith("$perpay$scrypt$"));

      const audit = test.identity.store.read((transaction) => transaction.auditEvents());
      assert.equal(audit.length, 1);
      assert.equal(audit[0]?.previousHash, null);
      const closedSource = "192.0.2.12";
      await assert.rejects(
        test.identity.setupAdmin("\ud800".repeat(12), { sourceAddress: closedSource }),
        (error: unknown) =>
          error instanceof IdentityError && error.code === "identity_already_initialized",
      );
      assert.equal(
        test.identity.store.read((transaction) =>
          transaction.authLimit(test.identity.sourceHash(closedSource))
        ),
        undefined,
      );
    } finally {
      test.close();
    }
  });

  it("persists a setup attempt before password hashing and clears it after success", async () => {
    const test = await fixture(undefined, false);
    try {
      const sourceAddress = "192.0.2.20";
      const sourceHash = test.identity.sourceHash(sourceAddress);
      await assert.rejects(
        test.identity.setupAdmin("\ud800".repeat(12), { sourceAddress }),
        (error: unknown) => error instanceof PasswordInputError,
      );
      assert.equal(
        test.identity.store.read((transaction) => transaction.authLimit(sourceHash))?.failureCount,
        1,
      );

      await test.identity.setupAdmin(adminPassword, { sourceAddress });
      assert.equal(
        test.identity.store.read((transaction) => transaction.authLimit(sourceHash)),
        undefined,
      );
    } finally {
      test.close();
    }
  });

  it("counts a same-source concurrent setup loser after the winner clears its own attempt", async () => {
    const test = await fixture(undefined, false);
    try {
      const sourceAddress = "192.0.2.22";
      const sourceHash = test.identity.sourceHash(sourceAddress);
      const competing = new IdentityService(test.database, () => test.clock.now + 1);
      const results = await Promise.allSettled([
        test.identity.setupAdmin(adminPassword, { sourceAddress }),
        competing.setupAdmin("another-secure-password", { sourceAddress }),
      ]);
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(results.filter((result) => result.status === "rejected").length, 1);
      assert.equal(
        test.identity.store.read((transaction) => transaction.authLimit(sourceHash))?.failureCount,
        1,
      );
    } finally {
      test.close();
    }
  });

  it("keeps the persisted setup attempt when the identity transaction rolls back", async () => {
    const test = await fixture(undefined, false);
    const sourceAddress = "192.0.2.21";
    const sourceHash = test.identity.sourceHash(sourceAddress);
    try {
      test.database.write((connection) => connection.exec(`
        CREATE TRIGGER injected_setup_identity_failure
        BEFORE INSERT ON admin_identity
        BEGIN
          SELECT RAISE(ABORT, 'injected setup identity failure');
        END;
      `));
      await assert.rejects(
        test.identity.setupAdmin(adminPassword, { sourceAddress }),
        /injected setup identity failure/,
      );
      assert.equal(test.identity.isInitialized(), false);
      assert.equal(
        test.identity.store.read((transaction) => transaction.authLimit(sourceHash))?.failureCount,
        1,
      );

      test.database.write((connection) =>
        connection.exec("DROP TRIGGER injected_setup_identity_failure"));
      await test.identity.setupAdmin(adminPassword, { sourceAddress });
      assert.equal(
        test.identity.store.read((transaction) => transaction.authLimit(sourceHash)),
        undefined,
      );
    } finally {
      test.database.write((connection) =>
        connection.exec("DROP TRIGGER IF EXISTS injected_setup_identity_failure"));
      test.close();
    }
  });

  it("creates an opaque session, enforces CSRF, idle expiry, and logout revocation", async () => {
    const test = await fixture();
    try {
      const login = await test.identity.login(adminPassword, {
        requestId: "request-login",
        sourceAddress: "127.0.0.1",
      });
      assert.match(login.sessionToken, /^ps1_[A-Za-z0-9_-]{43}$/);
      assert.match(login.csrfToken, /^pc1_[A-Za-z0-9_-]{43}$/);

      const authenticated = test.identity.authenticate(login.sessionToken);
      assert.ok(authenticated);
      assert.equal(test.identity.verifyCsrf(authenticated, login.csrfToken), true);
      assert.equal(test.identity.verifyCsrf(authenticated, "pc1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"), false);

      test.identity.logout(authenticated, { requestId: "request-logout" });
      assert.equal(test.identity.authenticate(login.sessionToken), undefined);
      assert.equal(test.identity.verifyCsrf(authenticated, login.csrfToken), false);

      const second = await test.identity.login(adminPassword, { sourceAddress: "127.0.0.2" });
      test.clock.now += IDENTITY_LIMITS.sessionIdleMs + 1;
      assert.equal(test.identity.authenticate(second.sessionToken), undefined);
    } finally {
      test.close();
    }
  });

  it("rate limits repeated login failures by a salted source hash", async () => {
    const test = await fixture();
    try {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await assert.rejects(
          test.identity.login("wrong-password-value", { sourceAddress: "203.0.113.8" }),
          (error: unknown) => error instanceof IdentityError && error.code === "invalid_credentials",
        );
      }
      await assert.rejects(
        test.identity.login(adminPassword, { sourceAddress: "203.0.113.8" }),
        (error: unknown) =>
          error instanceof IdentityError &&
          error.code === "auth_rate_limited" &&
          error.retryAfterSeconds !== undefined,
      );
      assert.equal(
        await test.identity.login(adminPassword, { sourceAddress: "203.0.113.9" }).then(() => true),
        true,
      );
    } finally {
      test.close();
    }
  });

  it("applies the same source limit to repeated step-up failures", async () => {
    const test = await fixture();
    try {
      const login = await test.identity.login(adminPassword, {
        sourceAddress: "198.51.100.4",
      });
      const authenticated = test.identity.authenticate(login.sessionToken);
      assert.ok(authenticated);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await assert.rejects(
          test.identity.stepUp(authenticated, "wrong-password-value", {
            sourceAddress: "198.51.100.4",
          }),
          (error: unknown) => error instanceof IdentityError && error.code === "invalid_credentials",
        );
      }
      await assert.rejects(
        test.identity.stepUp(authenticated, adminPassword, { sourceAddress: "198.51.100.4" }),
        (error: unknown) => error instanceof IdentityError && error.code === "auth_rate_limited",
      );
    } finally {
      test.close();
    }
  });

  it("counts and audits malformed existing credential inputs", async () => {
    const test = await fixture();
    try {
      const malformedPassword = "malformed-\ud800-password";
      const loginSource = "192.0.2.40";
      await assert.rejects(
        test.identity.login(malformedPassword, { sourceAddress: loginSource }),
        (error: unknown) => error instanceof IdentityError && error.code === "invalid_credentials",
      );

      const login = await test.identity.login(adminPassword, {
        sourceAddress: "192.0.2.41",
      });
      const authenticated = test.identity.authenticate(login.sessionToken);
      assert.ok(authenticated);

      const stepUpSource = "192.0.2.42";
      await assert.rejects(
        test.identity.stepUp(authenticated, malformedPassword, { sourceAddress: stepUpSource }),
        (error: unknown) => error instanceof IdentityError && error.code === "invalid_credentials",
      );
      const stepUp = await test.identity.stepUp(authenticated, adminPassword, {
        sourceAddress: "192.0.2.43",
      });
      const steppedUp = test.identity.authenticate(stepUp.sessionToken);
      assert.ok(steppedUp);

      const changeSource = "192.0.2.44";
      await assert.rejects(
        test.identity.changePassword(
          steppedUp,
          malformedPassword,
          "next-well-formed-password",
          { sourceAddress: changeSource },
        ),
        (error: unknown) => error instanceof IdentityError && error.code === "invalid_credentials",
      );

      const malformedNewPasswordSource = "192.0.2.45";
      await assert.rejects(
        test.identity.changePassword(
          steppedUp,
          adminPassword,
          malformedPassword,
          { sourceAddress: malformedNewPasswordSource },
        ),
        PasswordInputError,
      );
      const malformedNewPasswordSourceHash = test.identity.sourceHash(malformedNewPasswordSource);
      assert.equal(
        test.identity.store.read((transaction) =>
          transaction.authLimit(malformedNewPasswordSourceHash),
        ),
        undefined,
      );

      for (const source of [loginSource, stepUpSource, changeSource]) {
        const sourceHash = test.identity.sourceHash(source);
        const limit = test.identity.store.read((transaction) => transaction.authLimit(sourceHash));
        assert.equal(limit?.failureCount, 1);
      }
      const failedActions = test.database.read((connection) =>
        connection.prepare(
          "SELECT action FROM audit_events WHERE outcome = 'FAILURE' ORDER BY sequence",
        ).all() as Array<{ action: string }>,
      ).map((event) => event.action);
      assert.deepEqual(failedActions, ["admin.login", "admin.step_up", "admin.password_change"]);
    } finally {
      test.close();
    }
  });

  it("requires recent step-up before revoking every session", async () => {
    const test = await fixture();
    try {
      const login = await test.identity.login(adminPassword, { sourceAddress: "127.0.0.1" });
      const authenticated = test.identity.authenticate(login.sessionToken);
      assert.ok(authenticated);
      assert.throws(
        () => test.identity.revokeAllSessions(authenticated),
        (error: unknown) => error instanceof IdentityError && error.code === "step_up_required",
      );

      const firstStepUp = await test.identity.stepUp(authenticated, adminPassword);
      assert.equal(firstStepUp.stepUpExpiresAt, test.clock.now + IDENTITY_LIMITS.stepUpMs);
      assert.equal(firstStepUp.absoluteExpiresAt, login.absoluteExpiresAt);
      assert.notEqual(firstStepUp.sessionToken, login.sessionToken);
      assert.notEqual(firstStepUp.csrfToken, login.csrfToken);
      assert.equal(test.identity.authenticate(login.sessionToken), undefined);
      assert.equal(test.identity.verifyCsrf(authenticated, login.csrfToken), false);
      const steppedUp = test.identity.authenticate(firstStepUp.sessionToken);
      assert.ok(steppedUp);
      assert.equal(test.identity.isStepUp(steppedUp), true);
      assert.equal(test.identity.verifyCsrf(steppedUp, firstStepUp.csrfToken), true);
      test.clock.now += IDENTITY_LIMITS.stepUpMs + 1;
      assert.equal(test.identity.isStepUp(steppedUp), false);
      const secondStepUp = await test.identity.stepUp(steppedUp, adminPassword);
      assert.equal(secondStepUp.absoluteExpiresAt, login.absoluteExpiresAt);
      assert.equal(test.identity.authenticate(firstStepUp.sessionToken), undefined);
      const refreshed = test.identity.authenticate(secondStepUp.sessionToken);
      assert.ok(refreshed);
      assert.equal(test.identity.isStepUp(refreshed), true);
      assert.equal(test.identity.revokeAllSessions(refreshed), 1);
      assert.equal(test.identity.authenticate(secondStepUp.sessionToken), undefined);
      assert.equal(test.identity.isStepUp(refreshed), false);
      assert.equal(test.identity.verifyCsrf(refreshed, secondStepUp.csrfToken), false);
    } finally {
      test.close();
    }
  });

  it("rechecks session expiry after asynchronous password verification", async () => {
    const test = await fixture();
    try {
      const login = await test.identity.login(adminPassword, {
        sourceAddress: "192.0.2.30",
      });
      const authenticated = test.identity.authenticate(login.sessionToken);
      assert.ok(authenticated);
      const pending = test.identity.stepUp(authenticated, adminPassword, {
        sourceAddress: "192.0.2.30",
      });
      test.clock.now += IDENTITY_LIMITS.sessionIdleMs + 1;
      await assert.rejects(
        pending,
        (error: unknown) => error instanceof IdentityError && error.code === "session_invalid",
      );
    } finally {
      test.close();
    }
  });

  it("reserves password work capacity for authenticated operations during anonymous login load", async () => {
    const test = await fixture();
    try {
      const login = await test.identity.login(adminPassword, {
        sourceAddress: "192.0.2.50",
      });
      const authenticated = test.identity.authenticate(login.sessionToken);
      assert.ok(authenticated);

      const anonymousAttempts = [51, 52, 53].map((suffix) =>
        test.identity.login("wrong-password-value", {
          sourceAddress: `192.0.2.${suffix}`,
        })
      );
      const stepUp = test.identity.stepUp(authenticated, adminPassword, {
        sourceAddress: "192.0.2.54",
      });
      const [anonymousResults, replacement] = await Promise.all([
        Promise.allSettled(anonymousAttempts),
        stepUp,
      ]);

      const rejectedCodes = anonymousResults
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => (result.reason as IdentityError).code)
        .sort();
      assert.deepEqual(rejectedCodes, [
        "invalid_credentials",
        "password_work_busy",
        "password_work_busy",
      ]);
      const elevated = test.identity.authenticate(replacement.sessionToken);
      assert.ok(elevated);
      assert.equal(test.identity.isStepUp(elevated), true);
    } finally {
      test.close();
    }
  });

  it("consumes API nonces once per client", async () => {
    const test = await fixture();
    try {
      const nonce = "A".repeat(43);
      const generationBoundNonce = Buffer.alloc(32, 4).toString("base64url");
      const timestamp = Math.floor(test.clock.now / 1000);
      const credential = test.identity.apiClient("default");
      assert.ok(credential);
      assert.equal(
        test.identity.consumeApiNonce(
          "default",
          generationBoundNonce,
          timestamp,
          credential.keyVersion + 1,
          credential.secretFingerprint,
          test.clock.now,
        ),
        false,
      );
      assert.equal(
        test.identity.consumeApiNonce(
          "default",
          generationBoundNonce,
          timestamp,
          credential.keyVersion,
          credential.secretFingerprint,
          test.clock.now,
        ),
        true,
      );
      assert.equal(
        test.identity.consumeApiNonce(
          "default",
          nonce,
          timestamp,
          credential.keyVersion,
          credential.secretFingerprint,
          test.clock.now,
        ),
        true,
      );
      assert.equal(
        test.identity.consumeApiNonce(
          "default",
          nonce,
          timestamp,
          credential.keyVersion,
          credential.secretFingerprint,
          test.clock.now,
        ),
        false,
      );
      assert.equal(
        test.identity.consumeApiNonce(
          "default",
          "not-a-nonce",
          timestamp,
          credential.keyVersion,
          credential.secretFingerprint,
          test.clock.now,
        ),
        false,
      );
      assert.equal(
        test.identity.consumeApiNonce(
          "default",
          "B".repeat(43),
          timestamp - 301,
          credential.keyVersion,
          credential.secretFingerprint,
          test.clock.now,
        ),
        false,
      );
      assert.equal(
        test.identity.consumeApiNonce(
          "default",
          "C".repeat(43),
          timestamp + 301,
          credential.keyVersion,
          credential.secretFingerprint,
          test.clock.now,
        ),
        false,
      );
    } finally {
      test.close();
    }
  });

  it("allows only one concurrent password change from the same stepped-up session", async () => {
    const test = await fixture();
    try {
      const login = await test.identity.login(adminPassword, {
        sourceAddress: "192.0.2.10",
      });
      const authenticated = test.identity.authenticate(login.sessionToken);
      assert.ok(authenticated);
      const stepUp = await test.identity.stepUp(authenticated, adminPassword, {
        sourceAddress: "192.0.2.10",
      });
      const steppedUp = test.identity.authenticate(stepUp.sessionToken);
      assert.ok(steppedUp);

      const results = await Promise.allSettled([
        test.identity.changePassword(steppedUp, adminPassword, "next-password-value-one", {
          sourceAddress: "192.0.2.11",
        }),
        test.identity.changePassword(steppedUp, adminPassword, "next-password-value-two", {
          sourceAddress: "192.0.2.12",
        }),
      ]);
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      const rejected = results.find((result) => result.status === "rejected");
      assert.ok(rejected && rejected.status === "rejected");
      assert.equal(rejected.reason instanceof IdentityError, true);
      assert.equal((rejected.reason as IdentityError).code, "step_up_required");
      assert.equal(test.identity.authenticate(stepUp.sessionToken), undefined);

      const acceptedPasswords = await Promise.all(
        ["next-password-value-one", "next-password-value-two"].map(async (password, index) => {
          try {
            await test.identity.login(password, {
              sourceAddress: `192.0.2.${20 + index}`,
            });
            return password;
          } catch {
            return undefined;
          }
        }),
      );
      assert.equal(acceptedPasswords.filter((password) => password !== undefined).length, 1);
    } finally {
      test.close();
    }
  });

  it("rejects an identical replacement password without changing identity or session state", async () => {
    const test = await fixture();
    try {
      const login = await test.identity.login(adminPassword, {
        sourceAddress: "198.51.100.60",
      });
      const authenticated = test.identity.authenticate(login.sessionToken);
      assert.ok(authenticated);
      const stepUp = await test.identity.stepUp(authenticated, adminPassword, {
        sourceAddress: "198.51.100.60",
      });
      const elevated = test.identity.authenticate(stepUp.sessionToken);
      assert.ok(elevated);

      const before = {
        identity: test.identity.store.read((transaction) => transaction.adminIdentity()),
        audit: test.identity.store.read((transaction) => transaction.auditEvents()),
      };
      await assert.rejects(
        test.identity.changePassword(
          elevated,
          adminPassword,
          adminPassword,
          { sourceAddress: "198.51.100.60" },
        ),
        (error: unknown) => error instanceof IdentityError && error.code === "password_unchanged",
      );

      assert.deepEqual(
        test.identity.store.read((transaction) => transaction.adminIdentity()),
        before.identity,
      );
      assert.deepEqual(
        test.identity.store.read((transaction) => transaction.auditEvents()),
        before.audit,
      );
      const stillElevated = test.identity.authenticate(stepUp.sessionToken);
      assert.ok(stillElevated);
      assert.equal(test.identity.isStepUp(stillElevated), true);
      assert.equal(test.identity.verifyCsrf(stillElevated, stepUp.csrfToken), true);
    } finally {
      test.close();
    }
  });

  it("restarts without any bootstrap password and preserves the administrator password", async () => {
    const test = await fixture();
    try {
      const replacementConfig = loadConfig({
        PERPAY_MASTER_KEY: masterKey,
        PERPAY_DATA_DIR: test.directory,
      });
      assert.equal(replacementConfig.databasePath, test.config.databasePath);
      const restarted = new IdentityService(test.database, () => test.clock.now);
      await restarted.initialize();
      assert.equal(restarted.isInitialized(), true);
      const login = await restarted.login(adminPassword, { sourceAddress: "203.0.113.21" });
      assert.ok(restarted.authenticate(login.sessionToken));
    } finally {
      test.close();
    }
  });

  it("refuses startup when the persisted audit chain has been altered", async () => {
    const test = await fixture();
    try {
      test.database.write((connection) => {
        const trigger = connection.prepare(
          `SELECT sql FROM sqlite_schema
            WHERE type = 'trigger' AND name = 'audit_events_no_update'`,
        ).get() as { sql: string } | undefined;
        assert.ok(trigger?.sql);
        connection.exec("DROP TRIGGER audit_events_no_update");
        connection
          .prepare("UPDATE audit_events SET details_json = ? WHERE sequence = 1")
          .run('{"tampered":true}');
        connection.exec(trigger.sql);
      });
      const integrity = test.database.integrityCheck();
      assert.equal(integrity.schema, "ok");
      assert.ok(integrity.domainViolations >= 1);
      assert.equal(integrity.ok, false);
      await assert.rejects(test.identity.initialize(), /audit event hash verification failed/);
    } finally {
      test.close();
    }
  });

  it("detects a deleted audit tail through the database checkpoint and rejects its backup", async () => {
    const test = await fixture();
    try {
      test.database.write((connection) => {
        const trigger = connection.prepare(
          `SELECT sql FROM sqlite_schema
            WHERE type = 'trigger' AND name = 'audit_events_no_delete'`,
        ).get() as { sql: string } | undefined;
        assert.ok(trigger?.sql);
        connection.exec("DROP TRIGGER audit_events_no_delete");
        const deleted = connection.prepare(
          "DELETE FROM audit_events WHERE sequence = (SELECT MAX(sequence) FROM audit_events)",
        ).run();
        assert.equal(Number(deleted.changes), 1);
        connection.exec(trigger.sql);
      });

      const integrity = test.database.integrityCheck();
      assert.equal(integrity.schema, "ok");
      assert.equal(integrity.foreignKeyViolations, 0);
      assert.ok(integrity.domainViolations >= 1);
      assert.equal(integrity.ok, false);
      await assert.rejects(
        test.identity.initialize(),
        /audit chain anchor verification failed/,
      );
      await assert.rejects(
        test.database.backupDetailed(join(test.directory, "tampered-audit.sqlite3")),
        /backup verification failed/,
      );
    } finally {
      test.close();
    }
  });

  it("enforces the audit checkpoint transition and rolls back a failed append", async () => {
    const test = await fixture();
    try {
      const before = test.database.read((connection) => ({
        events: Number((connection.prepare(
          "SELECT COUNT(*) AS count FROM audit_events",
        ).get() as { count: bigint | number }).count),
        anchor: { ...(connection.prepare(
          `SELECT event_count, last_sequence, last_event_hash
             FROM audit_chain_state WHERE singleton_key = 1`,
        ).get() as Record<string, unknown>) },
      }));

      assert.throws(
        () => test.database.write((connection) => connection.exec(
          `INSERT INTO audit_chain_state(
             singleton_key, event_count, last_sequence, last_event_hash
           ) VALUES (1, 0, NULL, NULL)`,
        )),
        /audit chain state is a singleton/,
      );
      assert.throws(
        () => test.database.write((connection) =>
          connection.exec("DELETE FROM audit_chain_state WHERE singleton_key = 1")),
        /audit chain state cannot be deleted/,
      );
      assert.throws(
        () => test.database.write((connection) =>
          connection.exec("UPDATE audit_chain_state SET event_count = event_count")),
        /audit chain state transition is invalid/,
      );

      test.database.write((connection) => connection.exec(`
        CREATE TRIGGER injected_audit_checkpoint_failure
        BEFORE UPDATE ON audit_chain_state
        BEGIN
          SELECT RAISE(ABORT, 'injected audit checkpoint failure');
        END;
      `));
      try {
        assert.throws(
          () => test.database.write((connection) => appendAuditEvent(connection, {
            occurredAt: test.clock.now + 1,
            actorType: "SYSTEM",
            action: "audit.checkpoint.failure_probe",
            outcome: "FAILURE",
            details: { injected: true },
          })),
          /injected audit checkpoint failure/,
        );
      } finally {
        test.database.write((connection) =>
          connection.exec("DROP TRIGGER injected_audit_checkpoint_failure"));
      }

      const after = test.database.read((connection) => ({
        events: Number((connection.prepare(
          "SELECT COUNT(*) AS count FROM audit_events",
        ).get() as { count: bigint | number }).count),
        anchor: { ...(connection.prepare(
          `SELECT event_count, last_sequence, last_event_hash
             FROM audit_chain_state WHERE singleton_key = 1`,
        ).get() as Record<string, unknown>) },
      }));
      assert.deepEqual(after, before);
      assert.equal(test.database.integrityCheck().ok, true);
    } finally {
      test.close();
    }
  });
});
