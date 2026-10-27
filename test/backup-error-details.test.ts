// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { backupErrorDetails } from "../src/backup/error-details.ts";
import { BackupCycleError } from "../src/backup/runner.ts";

const syntheticKey = "5a".repeat(32);
const syntheticPem = "-----BEGIN PRIVATE KEY-----\nsynthetic-private-material\n-----END PRIVATE KEY-----";
const syntheticResponse = '{"payer":"synthetic-private-payer","password":"synthetic-password"}';

describe("safe backup failure details", () => {
  it("unwraps a cycle error to report file permission failures without paths", () => {
    const cause = Object.assign(new Error(`EACCES: permission denied, open '/secret/${syntheticKey}'`), {
      code: "EACCES", path: `/secret/${syntheticKey}`,
    });
    const details = backupErrorDetails(new BackupCycleError("database_backup", cause));
    assert.equal(details.error_type, "BackupCycleError");
    assert.equal(details.error_code, "EACCES");
    assert.match(details.message, /permissions/i);
    assert.equal(JSON.stringify(details).includes(syntheticKey), false);
    assert.equal(JSON.stringify(details).includes("/secret/"), false);
  });

  it("keeps actionable SHA-256, key guard and live-writer rejection reasons", () => {
    for (const message of [
      "operational backup SHA-256 does not match the expected value",
      "PERPAY_MASTER_KEY does not match this database or its key guard is damaged",
      "application database is still owned; stop the app service before restore",
    ]) {
      assert.equal(backupErrorDetails(new BackupCycleError("restore", new Error(message))).message, message);
    }
    const isolation = backupErrorDetails(new Error("application database is unreadable; explicit isolation is required after stopping all writers"));
    assert.match(isolation.message, /stop.*writers/);
    assert.match(isolation.message, /--quarantine-unreadable-current/);
  });

  it("retains the recovery barrier instruction after interrupted isolation or publication", () => {
    const message = "unreadable database isolation or publication failed; preserve original files, quarantine directory, and maintenance lock before recovery";
    const error = new Error(message, { cause: Object.assign(new Error(syntheticKey), { code: "EIO" }) });
    const details = backupErrorDetails(new BackupCycleError("restore", error));
    assert.ok(details.message.startsWith(message));
    assert.equal(details.error_code, "EIO");
    assert.equal(details.message.includes(syntheticKey), false);
  });

  it("preserves the rebuild-state instructions for missing or damaged backup state", () => {
    for (const state of ["missing", "damaged"]) {
      const message = `backup state is ${state}; repeat restore with --rebuild-state after checking the selected backup`;
      const details = backupErrorDetails(new BackupCycleError("restore", new Error(message)));
      assert.equal(details.message, message);
    }
  });

  it("reports configuration field names without echoing the invalid values", () => {
    const error = new Error(`backup configuration validation failed: Invalid input ${syntheticKey}\n at PERPAY_BACKUP_KEEP_COUNT`);
    const details = backupErrorDetails(error);
    assert.match(details.message, /PERPAY_BACKUP_KEEP_COUNT/);
    assert.equal(details.message.includes(syntheticKey), false);
    const missingKey = "backup restore configuration validation failed: secrets/master-key is missing";
    const cause = Object.assign(new Error(`/secrets/${syntheticKey}`), { code: "ENOENT" });
    const missingDetails = backupErrorDetails(new Error(missingKey, { cause }));
    assert.ok(missingDetails.message.startsWith(missingKey));
    assert.equal(missingDetails.message.includes(syntheticKey), false);
  });

  it("preserves cleanup context and known causes from aggregate failures", () => {
    const error = new AggregateError([
      new Error("backup SHA-256 does not match the expected value"),
      Object.assign(new Error(`EPERM: rename '${syntheticKey}'`), { code: "EPERM" }),
    ], "database restore failed during cleanup");
    const details = backupErrorDetails(error);
    assert.equal(details.error_type, "AggregateError");
    assert.match(details.message, /cleanup/);
    assert.match(details.message, /SHA-256/);
    assert.match(details.message, /permissions/i);
    assert.equal(details.error_code, "EPERM");
    assert.equal(details.message.includes(syntheticKey), false);
  });

  it("classifies SQLite damage and busy errors without native error text", () => {
    for (const [errcode, expected] of [[26, /corrupt|not a database/i], [11, /corrupt|not a database/i], [5, /busy/i]] as const) {
      const details = backupErrorDetails(Object.assign(new Error(syntheticResponse), { code: "ERR_SQLITE_ERROR", errcode }));
      assert.match(details.message, expected);
      assert.equal(details.error_code, "ERR_SQLITE_ERROR");
      assert.equal(details.message.includes("synthetic-private-payer"), false);
    }
  });

  it("distinguishes missing files, disk capacity and invalid commands", () => {
    assert.match(backupErrorDetails(Object.assign(new Error(syntheticKey), { code: "ENOENT" })).message, /does not exist|missing/i);
    assert.match(backupErrorDetails(Object.assign(new Error(syntheticKey), { code: "ENOSPC" })).message, /space|storage/i);
    assert.match(backupErrorDetails(new Error("usage: backup-runner <run-once|restore>")).message, /command|arguments/i);
  });

  it("preserves local restore parameter validation instructions", () => {
    for (const message of [
      "expected backup SHA-256 must be 64 lowercase hexadecimal characters",
      "backup name is invalid",
      "operational backup name is invalid",
    ]) assert.equal(backupErrorDetails(new TypeError(message)).message, message);
  });

  it("never returns arbitrary messages, names, codes, credentials or upstream payloads", () => {
    for (const message of [syntheticKey, syntheticPem, syntheticResponse, "https://synthetic-user:synthetic-password@upstream.example/raw"]) {
      const error = Object.assign(new Error(message), { name: message, code: message, request: { body: message } });
      const serialized = JSON.stringify(backupErrorDetails(error));
      assert.equal(serialized.includes(message), false);
      assert.equal(serialized.includes("synthetic-"), false);
      assert.equal(serialized.includes(syntheticKey), false);
      assert.equal(backupErrorDetails(error).error_code, undefined);
    }
  });

  it("does not echo sensitive JSON parser excerpts", () => {
    const details = backupErrorDetails(new SyntaxError(`Unexpected token near '${syntheticResponse}'`));
    assert.equal(details.error_type, "SyntaxError");
    assert.match(details.message, /JSON|metadata/);
    assert.equal(details.message.includes("synthetic-private-payer"), false);
  });

  it("bounds cyclic aggregate causes while retaining a reachable diagnostic", () => {
    const error = new AggregateError([], "unknown aggregate");
    Object.defineProperty(error, "cause", { value: error });
    error.errors.push(error, Object.assign(new Error(syntheticKey), { code: "ENOSPC" }));
    const details = backupErrorDetails(error);
    assert.equal(details.error_code, "ENOSPC");
    assert.ok(details.message.length <= 1024);
    assert.equal(details.message.includes(syntheticKey), false);
  });

  it("does not invoke arbitrary accessors or stringify thrown values", () => {
    let reads = 0;
    const error = new Error("synthetic unknown failure");
    for (const key of ["message", "name", "cause", "code", "errors"]) {
      Object.defineProperty(error, key, { get() { reads++; throw new Error(syntheticKey); } });
    }
    assert.doesNotThrow(() => backupErrorDetails(error));
    assert.equal(reads, 0);
    assert.doesNotThrow(() => backupErrorDetails({ toString() { throw new Error(syntheticKey); } }));
  });

  const hostileProxies = [
    ["revoked", () => {
      const { proxy, revoke } = Proxy.revocable(new Error(syntheticResponse), {});
      revoke();
      return proxy;
    }],
    ["throwing getPrototypeOf", () => new Proxy(new Error(syntheticResponse), {
      getPrototypeOf() {
        throw new Error(`${syntheticKey}\n${syntheticPem}\n${syntheticResponse}\n/secret/synthetic-private-trap`);
      },
    })],
  ] as const;
  const proxyLocations = [
    ["top level", (proxy: Error) => proxy],
    ["cause", (proxy: Error) => Object.assign(new Error("backup SHA-256 does not match the expected value", { cause: proxy }), { code: "EACCES" })],
    ["nested aggregate child", (proxy: Error) => new AggregateError([
      new AggregateError([proxy], "database restore failed during cleanup"),
    ], "database restore failed while releasing maintenance locks")],
    ["nested aggregate cause", (proxy: Error) => new AggregateError([
      new AggregateError([new Error(syntheticPem, { cause: proxy })], "database restore failed during cleanup"),
    ], "database restore failed while releasing maintenance locks")],
  ] as const;
  for (const [proxyKind, createProxy] of hostileProxies) {
    for (const [location, wrap] of proxyLocations) {
      it(`returns fixed safe details for a ${proxyKind} Proxy at ${location}`, () => {
        assertFixedFallback(wrap(createProxy()));
      });
    }
  }

  it("returns fixed safe details when an aggregate errors array is a revoked Proxy", () => {
    const { proxy, revoke } = Proxy.revocable([new Error(syntheticResponse)], {});
    const error = Object.assign(new AggregateError([], "database restore failed during cleanup"), {
      errors: proxy, code: "ENOSPC",
    });
    revoke();
    assertFixedFallback(error);
  });
});

function assertFixedFallback(error: unknown): void {
  const details = backupErrorDetails(error);
  assert.deepEqual(details, {
    message: "Backup operation failed; inspect the reported stage and local service configuration.",
    error_type: "unknown_error",
  });
  const serialized = JSON.stringify(details);
  for (const secret of [syntheticKey, syntheticPem, syntheticResponse, "synthetic-", "/secret/"]) {
    assert.equal(serialized.includes(secret), false);
  }
}
