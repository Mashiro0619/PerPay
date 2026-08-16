import assert from "node:assert/strict";
import { createHash, scryptSync } from "node:crypto";
import { describe, it } from "node:test";

import {
  PasswordInputError,
  digestToken,
  hashPassword,
  issueCsrfToken,
  issueSessionToken,
  tokenMatchesDigest,
  verifyPassword,
} from "../src/identity/crypto.ts";

describe("password hashing", () => {
  it("hashes and verifies a password with the fixed versioned scrypt profile", async () => {
    const password = "correct horse battery staple";
    const encodedHash = await hashPassword(password);

    assert.match(
      encodedHash,
      /^\$perpay\$scrypt\$v=1\$N=65536,r=8,p=2,dk=32\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/,
    );
    assert.equal(encodedHash.includes(password), false);
    assert.equal(await verifyPassword(password, encodedHash), true);
    assert.equal(await verifyPassword("definitely wrong", encodedHash), false);
  });

  it("uses an independent random salt for each hash", async () => {
    const [first, second] = await Promise.all([
      hashPassword("same password"),
      hashPassword("same password"),
    ]);

    assert.notEqual(first, second);
  });

  it("continues to verify the existing v1 hash format for well-formed passwords", async () => {
    const password = "existing-\u{1f512}-password";
    const salt = Buffer.from("00112233445566778899aabbccddeeff", "hex");
    const derivedKey = scryptSync(Buffer.from(password, "utf8"), salt, 32, {
      N: 65_536,
      r: 8,
      p: 2,
      maxmem: 96 * 1024 * 1024,
    });
    const encodedHash = [
      "",
      "perpay",
      "scrypt",
      "v=1",
      "N=65536,r=8,p=2,dk=32",
      salt.toString("base64url"),
      derivedKey.toString("base64url"),
    ].join("$");
    derivedKey.fill(0);

    assert.equal(await verifyPassword(password, encodedHash), true);
  });

  it("rejects malformed, non-canonical, and excessive work-factor hashes", async () => {
    const valid = await hashPassword("parser fixture password");
    const malformed = [
      "",
      "not-a-password-hash",
      valid.replace("v=1", "v=2"),
      valid.replace("N=65536", "N=131072"),
      valid.replace("N=65536", "N=065536"),
      valid.replace("r=8,p=2", "p=2,r=8"),
      valid.replace("dk=32", "dk=64"),
      `${valid}$extra`,
      valid.replace(/\$[A-Za-z0-9_-]{22}\$/, "$AA$"),
      `${"x".repeat(257)}`,
    ];

    for (const encodedHash of malformed) {
      assert.equal(
        await verifyPassword("parser fixture password", encodedHash),
        false,
        `must reject ${encodedHash.slice(0, 80)}`,
      );
    }
  });

  it("rejects empty and excessively large password inputs", async () => {
    await assert.rejects(hashPassword(""), PasswordInputError);
    await assert.rejects(hashPassword("x".repeat(1025)), PasswordInputError);
    await assert.rejects(verifyPassword("", "invalid"), PasswordInputError);
  });

  it("rejects isolated UTF-16 surrogates instead of normalizing distinct passwords", async () => {
    const replacementHash = await hashPassword("valid-\u{1f512}-\ufffd-password");
    assert.equal(await verifyPassword("valid-\u{1f512}-\ufffd-password", replacementHash), true);

    for (const malformed of ["\ud800", "\udfff", "prefix-\ud800-suffix"]) {
      await assert.rejects(hashPassword(malformed), PasswordInputError);
      await assert.rejects(verifyPassword(malformed, replacementHash), PasswordInputError);
    }
  });
});

describe("opaque identity tokens", () => {
  it("issues unique 256-bit session and CSRF tokens", () => {
    const sessions = new Set<string>();
    const csrfTokens = new Set<string>();

    for (let index = 0; index < 256; index += 1) {
      const session = issueSessionToken();
      const csrf = issueCsrfToken();
      assert.match(session.token, /^ps1_[A-Za-z0-9_-]{43}$/);
      assert.match(csrf.token, /^pc1_[A-Za-z0-9_-]{43}$/);
      sessions.add(session.token);
      csrfTokens.add(csrf.token);
    }

    assert.equal(sessions.size, 256);
    assert.equal(csrfTokens.size, 256);
  });

  it("returns only a SHA-256 digest suitable for persistence", () => {
    const issued = issueSessionToken();
    const independentlyCalculated = createHash("sha256")
      .update(issued.token, "ascii")
      .digest("hex");

    assert.match(issued.digest, /^[0-9a-f]{64}$/);
    assert.equal(issued.digest, independentlyCalculated);
    assert.equal(digestToken(issued.token), issued.digest);
    assert.equal(issued.digest.includes(issued.token), false);
  });

  it("compares token digests in constant-time compatible buffers", () => {
    const session = issueSessionToken();
    const otherSession = issueSessionToken();

    assert.equal(tokenMatchesDigest(session.token, session.digest), true);
    assert.equal(tokenMatchesDigest(otherSession.token, session.digest), false);
    assert.equal(tokenMatchesDigest(session.token, "A".repeat(64)), false);
    assert.equal(tokenMatchesDigest("malformed", session.digest), false);
    assert.throws(() => digestToken("malformed"), TypeError);
  });
});
