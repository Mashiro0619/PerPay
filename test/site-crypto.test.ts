import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import { RuntimeSecretCipher } from "../src/settings/crypto.ts";
import { SiteSecretCipher } from "../src/sites/crypto.ts";
import { reencryptLegacySiteSecret } from "../src/sites/migrations/legacy-secret.ts";

const masterKey = randomBytes(32);
const instanceId = "site-crypto-test-instance";
const cipher = () => new SiteSecretCipher(masterKey, instanceId);

describe("website-bound secrets", () => {
  it("round trips both purposes without altering plaintext", () => {
    for (const purpose of ["api_secret", "webhook_secret"] as const) {
      const encrypted = cipher().encrypt("site_a", purpose, 3, "test-only-secret");
      assert.equal(cipher().decrypt("site_a", purpose, 3, encrypted).toString(), "test-only-secret");
    }
  });
  it("rejects changes in website, purpose, version, instance or master key", () => {
    const encrypted = cipher().encrypt("site_a", "api_secret", 3, "test-only-secret");
    assert.throws(() => cipher().decrypt("site_b", "api_secret", 3, encrypted));
    assert.throws(() => cipher().decrypt("site_a", "webhook_secret", 3, encrypted));
    assert.throws(() => cipher().decrypt("site_a", "api_secret", 4, encrypted));
    assert.throws(() => new SiteSecretCipher(masterKey, "other-instance").decrypt("site_a", "api_secret", 3, encrypted));
    assert.throws(() => new SiteSecretCipher(randomBytes(32), instanceId).decrypt("site_a", "api_secret", 3, encrypted));
  });
  it("does not fall back to legacy AAD even for default", () => {
    const legacy = new RuntimeSecretCipher(masterKey, instanceId);
    const encrypted = legacy.encrypt("api_secret", 1, "test-only-secret");
    assert.throws(() => cipher().decrypt("default", "api_secret", 1, encrypted));
    const modern = cipher().encrypt("default", "api_secret", 1, "test-only-secret");
    assert.throws(() => legacy.decrypt("api_secret", 1, modern));
  });
  it("rejects separator injection and invalid secret versions", () => {
    const encrypted = cipher().encrypt("site_a", "api_secret", 1, "test-only-secret");
    for (const id of ["site:a", "site_a\u0000api_secret", "", " a "]) {
      assert.throws(() => cipher().encrypt(id, "api_secret", 1, "test-only-secret"));
      assert.throws(() => cipher().decrypt(id, "api_secret", 1, encrypted));
    }
    for (const version of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => cipher().encrypt("site_a", "api_secret", version, "test-only-secret"));
      assert.throws(() => cipher().decrypt("site_a", "api_secret", version, encrypted));
    }
  });
  it("uses fresh authenticated ciphertext and rejects tampering", () => {
    const first = cipher().encrypt("site_a", "api_secret", 1, "test-only-secret");
    const second = cipher().encrypt("site_a", "api_secret", 1, "test-only-secret");
    assert.notDeepEqual(first.nonce, second.nonce);
    for (const field of ["nonce", "ciphertext", "authenticationTag"] as const) {
      const changed = Buffer.from(first[field]);
      changed[0] = changed[0]! ^ 1;
      assert.throws(() => cipher().decrypt("site_a", "api_secret", 1, { ...first, [field]: changed }));
    }
  });
  it("converts legacy secrets without rotating plaintext or version", () => {
    const legacy = new RuntimeSecretCipher(masterKey, instanceId);
    for (const purpose of ["api_secret", "webhook_secret"] as const) {
      const encrypted = legacy.encrypt(purpose, 7, "preserved-test-secret");
      const before = Buffer.from(encrypted.ciphertext);
      const converted = reencryptLegacySiteSecret({ masterKey, instanceId, clientId: "default", purpose, version: 7, encrypted });
      assert.equal(cipher().decrypt("default", purpose, 7, converted).toString(), "preserved-test-secret");
      assert.deepEqual(encrypted.ciphertext, before);
      assert.throws(() => cipher().decrypt("site_b", purpose, 7, converted));
      assert.throws(() => legacy.decrypt(purpose, 7, converted));
    }
  });
  it("fails conversion with the wrong master key without modifying evidence", () => {
    const encrypted = new RuntimeSecretCipher(masterKey, instanceId).encrypt("webhook_secret", 2, "test-only-secret");
    const before = Buffer.from(encrypted.ciphertext);
    assert.throws(() => reencryptLegacySiteSecret({ masterKey: randomBytes(32), instanceId, clientId: "default", purpose: "webhook_secret", version: 2, encrypted }));
    assert.deepEqual(encrypted.ciphertext, before);
  });
});
