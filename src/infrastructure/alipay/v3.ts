// SPDX-License-Identifier: MIT
import { createPrivateKey, createPublicKey, KeyObject, type KeyLike } from "node:crypto";
import { AlipayProviderError } from "./errors.ts";

// Keep these imports exercised in environments that pass raw PEM strings while
// making malformed keys fail at the adapter boundary rather than in a request.
export function validateV3Keys(privateKey: KeyObject | string, publicKey: KeyObject | string): void {
  try {
    requireRsaKey(privateKey, "private");
    requireRsaKey(publicKey, "public");
  } catch (error) {
    throw new AlipayProviderError({
      kind: "configuration",
      code: "configuration_invalid",
      message: "provider key configuration is invalid",
      cause: error,
    });
  }
}

export function requireRsaKey(key: KeyLike | string, expectedType: "private" | "public"): KeyObject {
  if (key instanceof KeyObject && key.type !== expectedType) {
    throw new TypeError(`key is not a ${expectedType} key`);
  }
  if (
    expectedType === "public" &&
    typeof key === "string" &&
    /-----BEGIN (?:RSA )?PRIVATE KEY-----/.test(key)
  ) {
    throw new TypeError("a private key cannot be used as the provider public key");
  }
  const parsed = key instanceof KeyObject
    ? key
    : expectedType === "private" ? createPrivateKey(key) : createPublicKey(key);
  if (parsed.type !== expectedType || parsed.asymmetricKeyType !== "rsa") {
    throw new TypeError(`key must be an RSA ${expectedType} key`);
  }
  const modulusLength = parsed.asymmetricKeyDetails?.modulusLength;
  if (modulusLength === undefined || modulusLength < 2_048) {
    throw new TypeError("RSA keys must use a modulus of at least 2048 bits");
  }
  return parsed;
}
