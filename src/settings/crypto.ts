import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import type { RuntimeSecretName } from "./model.ts";

const CIPHER_VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const GUARD_PLAINTEXT = Buffer.from("perpay:master-key-guard:v1", "utf8");

export interface EncryptedSecret {
  readonly cipherVersion: typeof CIPHER_VERSION;
  readonly nonce: Buffer;
  readonly ciphertext: Buffer;
  readonly authenticationTag: Buffer;
}

export class RuntimeSecretCipher {
  readonly #key: Buffer;

  constructor(masterKey: Uint8Array, instanceId: string) {
    if (masterKey.byteLength !== 32) throw new RangeError("master key must contain exactly 32 bytes");
    this.#key = Buffer.from(hkdfSync(
      "sha256",
      masterKey,
      Buffer.from(instanceId, "utf8"),
      Buffer.from("perpay:runtime-settings:aes-256-gcm:v1", "utf8"),
      32,
    ));
  }

  encrypt(name: RuntimeSecretName | "master_key_guard", version: number, plaintext: string | Buffer): EncryptedSecret {
    if (!Number.isSafeInteger(version) || version < 1) throw new RangeError("secret version is invalid");
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(this.#aad(name, version));
    const ciphertext = Buffer.concat([
      cipher.update(typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext),
      cipher.final(),
    ]);
    return {
      cipherVersion: CIPHER_VERSION,
      nonce,
      ciphertext,
      authenticationTag: cipher.getAuthTag(),
    };
  }

  decrypt(name: RuntimeSecretName | "master_key_guard", version: number, encrypted: EncryptedSecret): Buffer {
    if (encrypted.cipherVersion !== CIPHER_VERSION) {
      throw new Error(`unsupported runtime secret cipher version ${encrypted.cipherVersion}`);
    }
    if (encrypted.nonce.byteLength !== NONCE_BYTES || encrypted.authenticationTag.byteLength !== TAG_BYTES) {
      throw new Error("encrypted runtime secret shape is invalid");
    }
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.#key, encrypted.nonce, {
        authTagLength: TAG_BYTES,
      });
      decipher.setAAD(this.#aad(name, version));
      decipher.setAuthTag(encrypted.authenticationTag);
      return Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]);
    } catch (error) {
      throw new Error(`runtime secret ${name} could not be decrypted`, { cause: error });
    }
  }

  createGuard(): EncryptedSecret {
    return this.encrypt("master_key_guard", 1, GUARD_PLAINTEXT);
  }

  verifyGuard(encrypted: EncryptedSecret): void {
    try {
      const actual = this.decrypt("master_key_guard", 1, encrypted);
      if (
        actual.byteLength === GUARD_PLAINTEXT.byteLength &&
        timingSafeEqual(actual, GUARD_PLAINTEXT)
      ) {
        return;
      }
    } catch {
      // Authentication failure and a mismatched guard have the same operator action.
    }
    throw new Error("PERPAY_MASTER_KEY does not match this database or its key guard is damaged");
  }

  fingerprint(): string {
    return createHash("sha256")
      .update("perpay:master-key-fingerprint:v1\0", "utf8")
      .update(this.#key)
      .digest("hex");
  }

  #aad(name: string, version: number): Buffer {
    return Buffer.from(`perpay:runtime-secret:v1\0${name}\0${version}`, "utf8");
  }
}
