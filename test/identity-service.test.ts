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
const collectionCodePayload = "https://qr.alipay.com/fkx-test-code-2026";

async function fixture(clock = { now: Date.parse("2026-08-14T12:00:00Z") }) {
  const directory = mkdtempSync(join(tmpdir(), "perpay-identity-"));
  const config = loadConfig({
    PERPAY_ADMIN_USERNAME: "admin",
    PERPAY_INITIAL_ADMIN_PASSWORD: adminPassword,
    PERPAY_API_CLIENT_ID: "default",
    PERPAY_API_SECRET: apiSecret,
    PERPAY_COLLECTION_CODE_PAYLOAD: collectionCodePayload,
    PERPAY_DATA_DIR: directory,
  });
  const database = await AppDatabase.open(config.databasePath);
  const identity = new IdentityService(database, config, () => clock.now);
  await identity.initialize();
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
  it("refuses to initialize a new database without an initial administrator password", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-identity-uninitialized-"));
    const config = loadConfig({
      PERPAY_ADMIN_USERNAME: "admin",
      PERPAY_API_CLIENT_ID: "default",
      PERPAY_API_SECRET: apiSecret,
      PERPAY_COLLECTION_CODE_PAYLOAD: collectionCodePayload,
      PERPAY_DATA_DIR: directory,
    });
    const database = await AppDatabase.open(config.databasePath);
    try {
      const identity = new IdentityService(database, config);
      await assert.rejects(
        identity.initialize(),
        /PERPAY_INITIAL_ADMIN_PASSWORD is required for first initialization/,
      );
      assert.equal(identity.store.read((transaction) => transaction.adminIdentity()), undefined);
      assert.equal(identity.apiClient("default"), undefined);
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("initializes one administrator and the configured API client without storing secrets", async () => {
    const test = await fixture();
    try {
      await test.identity.initialize();
      const admin = test.identity.store.read((transaction) => transaction.adminIdentity());
      assert.equal(admin?.username, "admin");
      assert.notEqual(admin?.passwordHash, adminPassword);
      assert.equal(admin?.passwordHash.includes(adminPassword), false);

      const client = test.identity.apiClient("default");
      assert.equal(client?.secretFingerprint, fingerprintApiSecret(apiSecret));
      assert.equal(client?.secretFingerprint.includes(apiSecret), false);
      assert.equal(test.identity.apiClient("other"), undefined);

      const audit = test.identity.store.read((transaction) => transaction.auditEvents());
      assert.equal(audit.length, 2);
      assert.equal(audit[0]?.previousHash, null);
      assert.equal(audit[1]?.previousHash, audit[0]?.eventHash);
    } finally {
      test.close();
    }
  });

  it("creates an opaque session, enforces CSRF, idle expiry, and logout revocation", async () => {
    const test = await fixture();
    try {
      const login = await test.identity.login("admin", adminPassword, {
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

      const second = await test.identity.login("admin", adminPassword, { sourceAddress: "127.0.0.2" });
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
          test.identity.login("admin", "wrong-password-value", { sourceAddress: "203.0.113.8" }),
          (error: unknown) => error instanceof IdentityError && error.code === "invalid_credentials",
        );
      }
      await assert.rejects(
        test.identity.login("admin", adminPassword, { sourceAddress: "203.0.113.8" }),
        (error: unknown) =>
          error instanceof IdentityError &&
          error.code === "auth_rate_limited" &&
          error.retryAfterSeconds !== undefined,
      );
      assert.equal(
        await test.identity.login("admin", adminPassword, { sourceAddress: "203.0.113.9" }).then(() => true),
        true,
      );
    } finally {
      test.close();
    }
  });

  it("applies the same source limit to repeated step-up failures", async () => {
    const test = await fixture();
    try {
      const login = await test.identity.login("admin", adminPassword, {
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
        test.identity.login("admin", malformedPassword, { sourceAddress: loginSource }),
        (error: unknown) => error instanceof IdentityError && error.code === "invalid_credentials",
      );

      const login = await test.identity.login("admin", adminPassword, {
        sourceAddress: "192.0.2.41",
      });
      const authenticated = test.identity.authenticate(login.sessionToken);
      assert.ok(authenticated);

      const stepUpSource = "192.0.2.42";
      await assert.rejects(
        test.identity.stepUp(authenticated, malformedPassword, { sourceAddress: stepUpSource }),
        (error: unknown) => error instanceof IdentityError && error.code === "invalid_credentials",
      );
      await test.identity.stepUp(authenticated, adminPassword, { sourceAddress: "192.0.2.43" });
      const steppedUp = test.identity.authenticate(login.sessionToken);
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
      const login = await test.identity.login("admin", adminPassword, { sourceAddress: "127.0.0.1" });
      const authenticated = test.identity.authenticate(login.sessionToken);
      assert.ok(authenticated);
      assert.throws(
        () => test.identity.revokeAllSessions(authenticated),
        (error: unknown) => error instanceof IdentityError && error.code === "step_up_required",
      );

      const stepUpExpiresAt = await test.identity.stepUp(authenticated, adminPassword);
      assert.equal(stepUpExpiresAt, test.clock.now + IDENTITY_LIMITS.stepUpMs);
      const steppedUp = test.identity.authenticate(login.sessionToken);
      assert.ok(steppedUp);
      assert.equal(test.identity.isStepUp(steppedUp), true);
      test.clock.now += IDENTITY_LIMITS.stepUpMs + 1;
      assert.equal(test.identity.isStepUp(steppedUp), false);
      await test.identity.stepUp(steppedUp, adminPassword);
      assert.equal(test.identity.isStepUp(steppedUp), true);
      assert.equal(test.identity.revokeAllSessions(steppedUp), 1);
      assert.equal(test.identity.authenticate(login.sessionToken), undefined);
      assert.equal(test.identity.isStepUp(steppedUp), false);
      assert.equal(test.identity.verifyCsrf(steppedUp, login.csrfToken), false);
    } finally {
      test.close();
    }
  });

  it("rechecks session expiry after asynchronous password verification", async () => {
    const test = await fixture();
    try {
      const login = await test.identity.login("admin", adminPassword, {
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

  it("consumes API nonces once per client", async () => {
    const test = await fixture();
    try {
      const nonce = "A".repeat(43);
      const timestamp = Math.floor(test.clock.now / 1000);
      assert.equal(test.identity.consumeApiNonce("default", nonce, timestamp), true);
      assert.equal(test.identity.consumeApiNonce("default", nonce, timestamp), false);
      assert.equal(test.identity.consumeApiNonce("default", "not-a-nonce", timestamp), false);
      assert.equal(test.identity.consumeApiNonce("default", "B".repeat(43), timestamp - 301), false);
      assert.equal(test.identity.consumeApiNonce("default", "C".repeat(43), timestamp + 301), false);
    } finally {
      test.close();
    }
  });

  it("allows only one concurrent password change from the same stepped-up session", async () => {
    const test = await fixture();
    try {
      const login = await test.identity.login("admin", adminPassword, {
        sourceAddress: "192.0.2.10",
      });
      const authenticated = test.identity.authenticate(login.sessionToken);
      assert.ok(authenticated);
      await test.identity.stepUp(authenticated, adminPassword, { sourceAddress: "192.0.2.10" });
      const steppedUp = test.identity.authenticate(login.sessionToken);
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
      assert.equal(test.identity.authenticate(login.sessionToken), undefined);

      const acceptedPasswords = await Promise.all(
        ["next-password-value-one", "next-password-value-two"].map(async (password, index) => {
          try {
            await test.identity.login("admin", password, {
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

  it("restarts without the retired initial password and preserves the administrator password", async () => {
    const test = await fixture();
    try {
      const replacementConfig = loadConfig({
        PERPAY_ADMIN_USERNAME: "admin",
        PERPAY_API_CLIENT_ID: "default",
        PERPAY_API_SECRET: apiSecret,
        PERPAY_COLLECTION_CODE_PAYLOAD: collectionCodePayload,
        PERPAY_DATA_DIR: test.directory,
      });
      const restarted = new IdentityService(test.database, replacementConfig, () => test.clock.now);
      await restarted.initialize();
      const login = await restarted.login("admin", adminPassword, { sourceAddress: "203.0.113.21" });
      assert.ok(restarted.authenticate(login.sessionToken));
    } finally {
      test.close();
    }
  });

  it("rotates the single configured API secret and starts a fresh nonce space", async () => {
    const test = await fixture();
    try {
      const timestamp = Math.floor(test.clock.now / 1000);
      const nonce = Buffer.alloc(32, 4).toString("base64url");
      assert.equal(test.identity.consumeApiNonce("default", nonce, timestamp), true);

      const rotatedSecret = Buffer.alloc(32, 9).toString("base64url");
      const rotatedConfig = loadConfig({
        PERPAY_ADMIN_USERNAME: "admin",
        PERPAY_INITIAL_ADMIN_PASSWORD: adminPassword,
        PERPAY_API_CLIENT_ID: "default",
        PERPAY_API_SECRET: rotatedSecret,
        PERPAY_COLLECTION_CODE_PAYLOAD: collectionCodePayload,
        PERPAY_DATA_DIR: test.directory,
      });
      const rotated = new IdentityService(test.database, rotatedConfig, () => test.clock.now);
      await rotated.initialize();

      assert.equal(test.identity.apiClient("default"), undefined);
      assert.equal(rotated.apiClient("default")?.keyVersion, 2);
      assert.equal(rotated.apiClient("default")?.secretFingerprint, fingerprintApiSecret(rotatedSecret));
      assert.equal(rotated.consumeApiNonce("default", nonce, timestamp), true);
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
