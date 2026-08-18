import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { loadConfig } from "../src/config.ts";

describe("loadConfig", () => {
  const validApiSecret = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
  const validWebhookSecret = Buffer.alloc(32, 61).toString("base64url");
  const validEnvironment = {
    PERPAY_INITIAL_ADMIN_PASSWORD: "a-secure-local-password",
    PERPAY_API_SECRET: validApiSecret,
    PERPAY_COLLECTION_CODE_PAYLOAD: "https://qr.alipay.com/fkx-test-code-2026",
  } as const;
  const applicationKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const platformKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const applicationPrivateKey = applicationKeys.privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  const platformPublicKey = platformKeys.publicKey
    .export({ type: "spki", format: "pem" })
    .toString();

  it("allows the initial administrator password to be retired after initialization", () => {
    const withoutInitialPassword = loadConfig({
      PERPAY_ADMIN_PASSWORD: validEnvironment.PERPAY_INITIAL_ADMIN_PASSWORD,
      PERPAY_API_SECRET: validApiSecret,
      PERPAY_COLLECTION_CODE_PAYLOAD: validEnvironment.PERPAY_COLLECTION_CODE_PAYLOAD,
    });
    assert.equal(withoutInitialPassword.adminPassword, null);
  });

  it("rejects placeholder passwords", () => {
    assert.throws(
      () =>
        loadConfig({
          PERPAY_INITIAL_ADMIN_PASSWORD: "CHANGE_ME_TO_A_LONG_RANDOM_PASSWORD",
          PERPAY_API_SECRET: validApiSecret,
          PERPAY_COLLECTION_CODE_PAYLOAD: validEnvironment.PERPAY_COLLECTION_CODE_PAYLOAD,
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

  it("rejects isolated UTF-16 surrogates in the initial password", () => {
    assert.throws(
      () => loadConfig({
        ...validEnvironment,
        PERPAY_INITIAL_ADMIN_PASSWORD: "long-enough-\ud800-password",
      }),
      /only Unicode scalar values/,
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
          PERPAY_COLLECTION_CODE_PAYLOAD: validEnvironment.PERPAY_COLLECTION_CODE_PAYLOAD,
        }),
      /不能与 PERPAY_INITIAL_ADMIN_PASSWORD 相同/,
    );
  });

  it("validates the collection code payload and bounded order settings", () => {
    for (const payload of [
      "short",
      "😀".repeat(4),
      `valid-code-${"\ud800"}`,
      " CHANGE_ME_TO_COLLECTION_CODE_PAYLOAD",
      "https://qr.alipay.com/code\n",
      "x".repeat(2332),
    ]) {
      assert.throws(
        () => loadConfig({ ...validEnvironment, PERPAY_COLLECTION_CODE_PAYLOAD: payload }),
        /PERPAY_COLLECTION_CODE_PAYLOAD|at most 2331 UTF-8 bytes|control characters|whitespace/,
      );
    }
    assert.equal(
      loadConfig({
        ...validEnvironment,
        PERPAY_COLLECTION_CODE_PAYLOAD: "x".repeat(2331),
      }).collectionCodePayload.length,
      2331,
    );
    assert.throws(
      () => loadConfig({ ...validEnvironment, PERPAY_ORDER_TTL_SECONDS: "59" }),
      /PERPAY_ORDER_TTL_SECONDS/,
    );
    assert.throws(
      () => loadConfig({ ...validEnvironment, PERPAY_AMOUNT_OFFSET_MAX_CENTS: "100" }),
      /PERPAY_AMOUNT_OFFSET_MAX_CENTS/,
    );
    assert.equal(
      loadConfig({
        ...validEnvironment,
        PERPAY_COLLECTION_CODE_PAYLOAD: "😀".repeat(8),
      }).collectionCodePayload,
      "😀".repeat(8),
    );
  });

  it("uses the backup schedule as the bounded application health policy", () => {
    assert.equal(loadConfig(validEnvironment).backupIntervalMilliseconds, 86_400_000);
    for (const [seconds, expectedMilliseconds] of [
      ["3600", 3_600_000],
      ["604800", 604_800_000],
    ] as const) {
      assert.equal(
        loadConfig({
          ...validEnvironment,
          PERPAY_BACKUP_INTERVAL_SECONDS: seconds,
        }).backupIntervalMilliseconds,
        expectedMilliseconds,
      );
    }
    for (const seconds of ["3599", "604801", "3600.5"]) {
      assert.throws(
        () => loadConfig({
          ...validEnvironment,
          PERPAY_BACKUP_INTERVAL_SECONDS: seconds,
        }),
        /PERPAY_BACKUP_INTERVAL_SECONDS/u,
      );
    }
  });

  it("requires live data and backups to use separate directory trees", () => {
    for (const [dataDirectory, backupDirectory] of [
      ["./runtime", "./runtime"],
      ["./runtime", "./runtime/backups"],
      ["./storage/data", "./storage"],
      ["./data", "./data/..backups"],
    ] as const) {
      assert.throws(
        () => loadConfig({
          ...validEnvironment,
          PERPAY_DATA_DIR: dataDirectory,
          PERPAY_BACKUP_DIR: backupDirectory,
        }),
        /PERPAY_DATA_DIR and PERPAY_BACKUP_DIR must be separate/u,
      );
    }
  });

  it("resolves existing parent links before checking storage separation", () => {
    const root = mkdtempSync(join(tmpdir(), "perpay-config-paths-"));
    const actual = join(root, "actual");
    const alias = join(root, "alias");
    mkdirSync(actual);
    symlinkSync(actual, alias, process.platform === "win32" ? "junction" : "dir");
    try {
      assert.throws(
        () => loadConfig({
          ...validEnvironment,
          PERPAY_DATA_DIR: join(alias, "future-data"),
          PERPAY_BACKUP_DIR: join(actual, "future-data", "backups"),
        }),
        /PERPAY_DATA_DIR and PERPAY_BACKUP_DIR must be separate/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

  it("rejects cleartext public URLs outside loopback", () => {
    for (const value of [
      "http://pay.internal",
      "http://192.0.2.10:8080",
      "http://[2001:db8::1]:8080",
    ]) {
      assert.throws(
        () => loadConfig({ ...validEnvironment, PERPAY_PUBLIC_URL: value }),
        /PERPAY_PUBLIC_URL/u,
      );
    }
    for (const value of [
      "http://localhost:8080",
      "http://127.0.0.2:8080",
      "http://[::1]:8080",
    ]) {
      assert.equal(loadConfig({ ...validEnvironment, PERPAY_PUBLIC_URL: value }).secureCookies, false);
    }
  });

  it("requires an explicit trusted proxy for HTTPS deployments", () => {
    assert.throws(
      () => loadConfig({ ...validEnvironment, PERPAY_PUBLIC_URL: "https://pay.local" }),
      /PERPAY_TRUSTED_PROXY_CIDRS/u,
    );
    const configured = loadConfig({
      ...validEnvironment,
      PERPAY_PUBLIC_URL: "https://pay.local",
      PERPAY_TRUSTED_PROXY_CIDRS: "127.0.0.1",
    });
    assert.equal(configured.secureCookies, true);
    assert.deepEqual(configured.trustedProxy.cidrs, ["127.0.0.1"]);
  });

  it("accepts only explicit IP addresses and CIDRs as trusted proxies", () => {
    const configured = loadConfig({
      ...validEnvironment,
      PERPAY_TRUSTED_PROXY_CIDRS: "127.0.0.1, 10.0.0.0/8, 2001:db8::/32",
    });
    assert.deepEqual(configured.trustedProxy.cidrs, [
      "127.0.0.1",
      "10.0.0.0/8",
      "2001:db8::/32",
    ]);

    for (const value of [
      "proxy.internal",
      "127.0.0.1:8080",
      "10.0.0.0/33",
      "0.0.0.0/0",
      "::/0",
      "127.0.0.1,",
    ]) {
      assert.throws(
        () => loadConfig({ ...validEnvironment, PERPAY_TRUSTED_PROXY_CIDRS: value }),
        /PERPAY_TRUSTED_PROXY_CIDRS/,
      );
    }
  });

  it("normalizes valid configuration", () => {
    const config = loadConfig({
      ...validEnvironment,
      PERPAY_HOST: "127.0.0.1",
      PERPAY_PORT: "19080",
      PERPAY_DATA_DIR: "./runtime-test",
      PERPAY_BACKUP_DIR: "./backup-test",
      PERPAY_PUBLIC_URL: "https://pay.local:8443",
      PERPAY_TRUSTED_PROXY_CIDRS: "127.0.0.1",
    });
    assert.equal(config.port, 19080);
    assert.equal(config.host, "127.0.0.1");
    assert.match(config.databasePath, /perpay\.sqlite3$/);
    assert.match(config.backupDir, /backup-test$/);
    assert.equal(config.publicOrigin, "https://pay.local:8443");
    assert.equal(config.secureCookies, true);
    assert.deepEqual(config.trustedProxy.cidrs, ["127.0.0.1"]);
    assert.equal(config.orderTtlSeconds, 300);
    assert.equal(config.amountOffsetMaximumCents, 99);
    assert.equal(config.checkoutKeyRotationMilliseconds, 90 * 24 * 60 * 60 * 1_000);
    assert.equal(config.checkoutTerminalObservationMilliseconds, 24 * 60 * 60 * 1_000);
    assert.equal(config.backupIntervalMilliseconds, 24 * 60 * 60 * 1_000);
    assert.deepEqual(config.alipay, {
      enabled: false,
      endpoint: "https://openapi.alipay.com",
      scanIntervalMilliseconds: 10_000,
      maximumSuccessAgeMilliseconds: 60_000,
    });
    assert.deepEqual(config.webhook, { enabled: false });
  });

  it("requires an isolated secret and one canonical HTTPS DNS origin for notifications", () => {
    const enabled = {
      ...validEnvironment,
      PERPAY_WEBHOOK_ENABLED: "true",
      PERPAY_WEBHOOK_ALLOWED_ORIGIN: "https://Hooks.PerPay.dev:8443",
      PERPAY_WEBHOOK_SECRET: validWebhookSecret,
      PERPAY_WEBHOOK_TIMEOUT_MILLISECONDS: "7000",
      PERPAY_WEBHOOK_MAX_ATTEMPTS: "9",
      PERPAY_WEBHOOK_RETRY_BASE_SECONDS: "3",
      PERPAY_WEBHOOK_RETRY_MAX_SECONDS: "600",
    } as const;
    const config = loadConfig(enabled);
    assert.equal(config.webhook.enabled, true);
    if (!config.webhook.enabled) throw new Error("notifications should be enabled");
    assert.equal(config.webhook.allowedOrigin, "https://hooks.perpay.dev:8443");
    assert.equal(config.webhook.secret, validWebhookSecret);
    assert.equal(config.webhook.timeoutMilliseconds, 7_000);
    assert.equal(config.webhook.maximumAttempts, 9);
    assert.equal(config.webhook.retryBaseMilliseconds, 3_000);
    assert.equal(config.webhook.retryMaximumMilliseconds, 600_000);
    assert.match(config.webhook.allowedOriginFingerprint, /^[0-9a-f]{64}$/);
    assert.match(config.webhook.signingKeyFingerprint, /^[0-9a-f]{64}$/);

    assert.throws(
      () => loadConfig({ ...validEnvironment, PERPAY_WEBHOOK_ENABLED: "true" }),
      /PERPAY_WEBHOOK_ALLOWED_ORIGIN.*PERPAY_WEBHOOK_SECRET/,
    );
    assert.throws(
      () => loadConfig({ ...enabled, PERPAY_WEBHOOK_SECRET: validApiSecret }),
      /不能复用管理员密码或 API 密钥/,
    );
    assert.throws(
      () => loadConfig({ ...enabled, PERPAY_WEBHOOK_SECRET: "too-short" }),
      /恰好 32 字节/,
    );
    assert.throws(
      () => loadConfig({ ...enabled, PERPAY_WEBHOOK_RETRY_BASE_SECONDS: "601" }),
      /不能小于 PERPAY_WEBHOOK_RETRY_BASE_SECONDS/,
    );

    for (const origin of [
      "http://hooks.perpay.dev",
      "https://user@hooks.perpay.dev",
      "https://hooks.perpay.dev/path",
      "https://hooks.perpay.dev?mode=1",
      "https://hooks.perpay.dev?",
      "https://hooks.perpay.dev#",
      "https://127.0.0.1",
      "https://hooks.perpay.dev.",
      " https://hooks.perpay.dev",
      "https://example.com",
      `https://${"a".repeat(64)}.perpay.dev`,
      `https://${Array.from({ length: 5 }, () => "a".repeat(63)).join(".")}`,
    ]) {
      assert.throws(
        () => loadConfig({ ...enabled, PERPAY_WEBHOOK_ALLOWED_ORIGIN: origin }),
        /PERPAY_WEBHOOK_ALLOWED_ORIGIN/,
      );
    }
  });

  it("requires strong RSA platform configuration only when collection is enabled", () => {
    assert.throws(
      () => loadConfig({ ...validEnvironment, PERPAY_ALIPAY_ENABLED: "true" }),
      /PERPAY_ALIPAY_APP_ID.*PERPAY_ALIPAY_PRIVATE_KEY.*PERPAY_ALIPAY_PUBLIC_KEY/,
    );

    const config = loadConfig({
      ...validEnvironment,
      PERPAY_ALIPAY_ENABLED: "true",
      PERPAY_ALIPAY_APP_ID: "2026000000000000",
      PERPAY_ALIPAY_PRIVATE_KEY: applicationPrivateKey,
      PERPAY_ALIPAY_PUBLIC_KEY: platformPublicKey,
      PERPAY_ALIPAY_ENDPOINT: "https://openapi-sandbox.dl.alipaydev.com",
      PERPAY_ALIPAY_TIMEOUT_MILLISECONDS: "9000",
      PERPAY_ALIPAY_SCAN_INTERVAL_SECONDS: "15",
      PERPAY_ALIPAY_MAX_SUCCESS_AGE_SECONDS: "45",
    });
    assert.equal(config.alipay.enabled, true);
    if (!config.alipay.enabled) throw new Error("provider collection should be enabled");
    assert.equal(config.alipay.privateKey.type, "private");
    assert.equal(config.alipay.alipayPublicKey.type, "public");
    assert.equal(config.alipay.timeoutMilliseconds, 9_000);
    assert.equal(config.alipay.scanIntervalMilliseconds, 15_000);
    assert.equal(config.alipay.maximumSuccessAgeMilliseconds, 45_000);
    assert.match(config.alipay.applicationKeyFingerprint, /^[0-9a-f]{64}$/);
    assert.match(config.alipay.alipayKeyFingerprint, /^[0-9a-f]{64}$/);

    assert.throws(
      () => loadConfig({
        ...validEnvironment,
        PERPAY_ALIPAY_ENABLED: "true",
        PERPAY_ALIPAY_APP_ID: "2026000000000000",
        PERPAY_ALIPAY_PRIVATE_KEY: applicationPrivateKey,
        PERPAY_ALIPAY_PUBLIC_KEY: platformPublicKey,
        PERPAY_ALIPAY_SCAN_INTERVAL_SECONDS: "15",
        PERPAY_ALIPAY_MAX_SUCCESS_AGE_SECONDS: "29",
      }),
      /PERPAY_ALIPAY_MAX_SUCCESS_AGE_SECONDS/u,
    );

    const disabled = loadConfig({
      ...validEnvironment,
      PERPAY_ALIPAY_ENABLED: "false",
      PERPAY_ALIPAY_SCAN_INTERVAL_SECONDS: "60",
      PERPAY_ALIPAY_MAX_SUCCESS_AGE_SECONDS: "10",
    });
    assert.equal(disabled.alipay.enabled, false);
    assert.equal(disabled.alipay.scanIntervalMilliseconds, 60_000);
    assert.equal(disabled.alipay.maximumSuccessAgeMilliseconds, 10_000);
  });

  it("accepts the unarmored key format supplied by the platform tools", () => {
    const unarmored = (pem: string): string => pem
      .replace(/-----BEGIN [^-]+-----|-----END [^-]+-----|\s/g, "");
    const config = loadConfig({
      ...validEnvironment,
      PERPAY_ALIPAY_ENABLED: "true",
      PERPAY_ALIPAY_APP_ID: "2026000000000000",
      PERPAY_ALIPAY_PRIVATE_KEY: unarmored(applicationPrivateKey),
      PERPAY_ALIPAY_PUBLIC_KEY: unarmored(platformPublicKey),
    });
    assert.equal(config.alipay.enabled, true);
  });

  it("rejects arbitrary endpoints, placeholder IDs, and weak provider keys", () => {
    const weakPrivateKey = generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString();
    const enabled = {
      ...validEnvironment,
      PERPAY_ALIPAY_ENABLED: "true",
      PERPAY_ALIPAY_APP_ID: "2026000000000000",
      PERPAY_ALIPAY_PRIVATE_KEY: applicationPrivateKey,
      PERPAY_ALIPAY_PUBLIC_KEY: platformPublicKey,
    } as const;
    assert.throws(
      () => loadConfig({ ...enabled, PERPAY_ALIPAY_ENDPOINT: "https://openapi.alipay.com:444" }),
      /PERPAY_ALIPAY_ENDPOINT/,
    );
    assert.throws(
      () => loadConfig({ ...enabled, PERPAY_ALIPAY_APP_ID: "CHANGE_ME_APP_ID" }),
      /PERPAY_ALIPAY_APP_ID.*示例值/,
    );
    assert.throws(
      () => loadConfig({ ...enabled, PERPAY_ALIPAY_PRIVATE_KEY: weakPrivateKey }),
      /至少需要 2048 位 RSA/,
    );
    assert.throws(
      () => loadConfig({ ...enabled, PERPAY_ALIPAY_PUBLIC_KEY: applicationPrivateKey }),
      /PERPAY_ALIPAY_PUBLIC_KEY 不能包含私钥/,
    );
    assert.throws(
      () => loadConfig({
        ...enabled,
        PERPAY_ALIPAY_PUBLIC_KEY: applicationKeys.publicKey
          .export({ type: "spki", format: "pem" })
          .toString(),
      }),
      /PERPAY_ALIPAY_PUBLIC_KEY 不能填写应用公钥/,
    );
    assert.throws(
      () => loadConfig({ ...enabled, PERPAY_ALIPAY_APP_ID: "unsafe,app" }),
      /PERPAY_ALIPAY_APP_ID/,
    );
  });
});
