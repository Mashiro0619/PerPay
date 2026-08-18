import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import { loadConfig } from "../src/config.ts";

const MASTER_KEY = "0123456789abcdef".repeat(4);

describe("deployment configuration", () => {
  it("loads the minimal deployment configuration with port 6190 defaults", () => {
    const config = loadConfig({ PERPAY_MASTER_KEY: MASTER_KEY });

    assert.equal(config.host, "0.0.0.0");
    assert.equal(config.port, 6190);
    assert.equal(config.publicOrigin, "http://localhost:6190");
    assert.equal(config.secureCookies, false);
    assert.deepEqual(config.trustedProxy.cidrs, []);
    assert.deepEqual(config.masterKey, Buffer.from(MASTER_KEY, "hex"));
    assert.equal(config.masterKey.byteLength, 32);
    assert.equal(config.backupIntervalMilliseconds, 86_400_000);
    assert.match(config.databasePath, /perpay\.sqlite3$/u);
    assert.deepEqual(Object.keys(config).sort(), [
      "backupDir",
      "backupIntervalMilliseconds",
      "dataDir",
      "databasePath",
      "host",
      "masterKey",
      "port",
      "publicOrigin",
      "secureCookies",
      "trustedProxy",
    ]);
  });

  it("requires a canonical 32-byte hexadecimal master key", () => {
    assert.throws(() => loadConfig({}), /PERPAY_MASTER_KEY/u);
    for (const value of [
      "0".repeat(62),
      "0".repeat(66),
      "g".repeat(64),
      "CHANGE_ME_TO_64_HEX_CHARACTERS",
    ]) {
      assert.throws(
        () => loadConfig({ PERPAY_MASTER_KEY: value }),
        /PERPAY_MASTER_KEY/u,
      );
    }

    const uppercase = MASTER_KEY.toUpperCase();
    assert.deepEqual(
      loadConfig({ PERPAY_MASTER_KEY: uppercase }).masterKey,
      Buffer.from(uppercase, "hex"),
    );
  });

  it("accepts only an IP address or localhost as the listener host", () => {
    assert.throws(
      () => loadConfig({ PERPAY_MASTER_KEY: MASTER_KEY, PERPAY_HOST: "pay.example.test" }),
      /PERPAY_HOST/u,
    );
    assert.equal(
      loadConfig({ PERPAY_MASTER_KEY: MASTER_KEY, PERPAY_HOST: "127.0.0.1" }).host,
      "127.0.0.1",
    );
  });

  it("keeps data and backup storage separate", () => {
    const config = loadConfig({
      PERPAY_MASTER_KEY: MASTER_KEY,
      PERPAY_DATA_DIR: "./runtime-data",
      PERPAY_BACKUP_DIR: "./runtime-backups",
    });
    assert.equal(config.dataDir, resolve("./runtime-data"));
    assert.equal(config.backupDir, resolve("./runtime-backups"));
    assert.equal(config.databasePath, resolve("./runtime-data/perpay.sqlite3"));

    assert.throws(
      () => loadConfig({
        PERPAY_MASTER_KEY: MASTER_KEY,
        PERPAY_DATA_DIR: "./runtime-data",
        PERPAY_BACKUP_DIR: "./runtime-data/backups",
      }),
      /must be separate/u,
    );
  });

  it("allows plain HTTP only for loopback public origins", () => {
    for (const origin of [
      "http://localhost:6190",
      "http://127.0.0.2:6190",
      "http://[::1]:6190",
    ]) {
      assert.equal(
        loadConfig({ PERPAY_MASTER_KEY: MASTER_KEY, PERPAY_PUBLIC_URL: origin }).publicOrigin,
        origin,
      );
    }
    assert.throws(
      () => loadConfig({
        PERPAY_MASTER_KEY: MASTER_KEY,
        PERPAY_PUBLIC_URL: "http://192.0.2.10:6190",
      }),
      /plain HTTP/u,
    );
  });

  it("requires an explicit trusted proxy for HTTPS", () => {
    assert.throws(
      () => loadConfig({
        PERPAY_MASTER_KEY: MASTER_KEY,
        PERPAY_PUBLIC_URL: "https://pay.example.test",
      }),
      /trusted proxy/u,
    );

    const config = loadConfig({
      PERPAY_MASTER_KEY: MASTER_KEY,
      PERPAY_PUBLIC_URL: "https://pay.example.test:8443",
      PERPAY_TRUSTED_PROXY_CIDRS: "127.0.0.1,10.0.0.0/8",
    });
    assert.equal(config.publicOrigin, "https://pay.example.test:8443");
    assert.equal(config.secureCookies, true);
    assert.deepEqual(config.trustedProxy.cidrs, ["127.0.0.1", "10.0.0.0/8"]);
  });

  it("rejects public URLs with credentials, paths, queries, or fragments", () => {
    for (const value of [
      "ftp://localhost:6190",
      "http://user:password@localhost:6190",
      "http://localhost:6190/path",
      "http://localhost:6190/?query=1",
      "http://localhost:6190/#fragment",
    ]) {
      assert.throws(
        () => loadConfig({ PERPAY_MASTER_KEY: MASTER_KEY, PERPAY_PUBLIC_URL: value }),
        /PERPAY_PUBLIC_URL/u,
      );
    }
  });

  it("validates the configured port and backup interval", () => {
    const config = loadConfig({
      PERPAY_MASTER_KEY: MASTER_KEY,
      PERPAY_PORT: "26190",
      PERPAY_BACKUP_INTERVAL_SECONDS: "7200",
    });
    assert.equal(config.port, 26190);
    assert.equal(config.backupIntervalMilliseconds, 7_200_000);

    assert.throws(
      () => loadConfig({ PERPAY_MASTER_KEY: MASTER_KEY, PERPAY_PORT: "0" }),
      /PERPAY_PORT/u,
    );
    assert.throws(
      () => loadConfig({
        PERPAY_MASTER_KEY: MASTER_KEY,
        PERPAY_BACKUP_INTERVAL_SECONDS: "3599",
      }),
      /PERPAY_BACKUP_INTERVAL_SECONDS/u,
    );
  });
});
