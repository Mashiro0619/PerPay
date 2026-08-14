import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadConfig } from "../src/config.ts";

describe("loadConfig", () => {
  const validApiSecret = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
  const validEnvironment = {
    PERPAY_INITIAL_ADMIN_PASSWORD: "a-secure-local-password",
    PERPAY_API_SECRET: validApiSecret,
  } as const;

  it("requires the initial administrator password and does not accept the old variable", () => {
    assert.throws(() => loadConfig({}), /PERPAY_INITIAL_ADMIN_PASSWORD/);
    assert.throws(
      () =>
        loadConfig({
          PERPAY_ADMIN_PASSWORD: validEnvironment.PERPAY_INITIAL_ADMIN_PASSWORD,
          PERPAY_API_SECRET: validApiSecret,
        }),
      /PERPAY_INITIAL_ADMIN_PASSWORD/,
    );
  });

  it("rejects placeholder passwords", () => {
    assert.throws(
      () =>
        loadConfig({
          PERPAY_INITIAL_ADMIN_PASSWORD: "CHANGE_ME_TO_A_LONG_RANDOM_PASSWORD",
          PERPAY_API_SECRET: validApiSecret,
        }),
      /PERPAY_API_SECRET|不能使用示例值/,
    );
  });

  it("enforces the initial password UTF-8 byte limit", () => {
    const maximumLengthPassword = "😀".repeat(256);
    assert.equal(Buffer.byteLength(maximumLengthPassword, "utf8"), 1024);
    assert.equal(
      loadConfig({
        ...validEnvironment,
        PERPAY_INITIAL_ADMIN_PASSWORD: maximumLengthPassword,
      }).adminPassword,
      maximumLengthPassword,
    );

    assert.throws(
      () =>
        loadConfig({
          ...validEnvironment,
          PERPAY_INITIAL_ADMIN_PASSWORD: `${maximumLengthPassword}a`,
        }),
      /at most 1024 UTF-8 bytes/,
    );
  });

  it("requires a canonical unpadded base64url encoding of exactly 32 API secret bytes", () => {
    assert.throws(
      () =>
        loadConfig({
          PERPAY_INITIAL_ADMIN_PASSWORD: validEnvironment.PERPAY_INITIAL_ADMIN_PASSWORD,
        }),
      /PERPAY_API_SECRET/,
    );

    for (const invalidSecret of [
      "too-short",
      Buffer.alloc(31).toString("base64url"),
      Buffer.alloc(33).toString("base64url"),
      `${validApiSecret}=`,
      `${validApiSecret.slice(0, -1)}9`,
    ]) {
      assert.throws(
        () => loadConfig({ ...validEnvironment, PERPAY_API_SECRET: invalidSecret }),
        /canonical unpadded base64url encoding of exactly 32 bytes/,
      );
    }

    assert.equal(loadConfig(validEnvironment).apiSecret, validApiSecret);
  });

  it("rejects placeholder and reused API secrets", () => {
    assert.throws(
      () =>
        loadConfig({
          ...validEnvironment,
          PERPAY_API_SECRET: `example${"A".repeat(36)}`,
        }),
      /PERPAY_API_SECRET 不能使用示例值/,
    );
    assert.throws(
      () =>
        loadConfig({
          PERPAY_INITIAL_ADMIN_PASSWORD: validApiSecret,
          PERPAY_API_SECRET: validApiSecret,
        }),
      /不能与 PERPAY_INITIAL_ADMIN_PASSWORD 相同/,
    );
  });

  it("accepts only an origin as the public URL", () => {
    assert.throws(
      () => loadConfig({ ...validEnvironment, PERPAY_PUBLIC_URL: "https://pay.example.com/path" }),
      /只能包含 origin/,
    );
    assert.throws(
      () => loadConfig({ ...validEnvironment, PERPAY_PUBLIC_URL: "ftp://pay.local" }),
      /只支持 http 或 https/,
    );
  });

  it("normalizes valid configuration", () => {
    const config = loadConfig({
      ...validEnvironment,
      PERPAY_HOST: "127.0.0.1",
      PERPAY_PORT: "19080",
      PERPAY_DATA_DIR: "./runtime-test",
      PERPAY_TIMEZONE: "Asia/Shanghai",
      PERPAY_PUBLIC_URL: "https://pay.local:8443",
    });
    assert.equal(config.port, 19080);
    assert.equal(config.host, "127.0.0.1");
    assert.match(config.databasePath, /perpay\.sqlite3$/);
    assert.equal(config.publicOrigin, "https://pay.local:8443");
    assert.equal(config.secureCookies, true);
  });
});
