import {
  RuntimeSecretCipher,
  type EncryptedSecret,
  type SiteCipherSecretName,
  type SiteSecretPurpose,
} from "../settings/crypto.ts";
import { siteClientIdSchema } from "./model.ts";

function secretName(clientId: string, purpose: SiteSecretPurpose): SiteCipherSecretName {
  siteClientIdSchema.parse(clientId);
  if (purpose !== "api_secret" && purpose !== "webhook_secret") {
    throw new RangeError("website secret purpose is invalid");
  }
  return `site:${clientId}:${purpose}`;
}

function checkVersion(version: number): void {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new RangeError("website secret version is invalid");
  }
}

/** Reuses the instance cipher with a separate, website-bound AAD namespace. */
export class SiteSecretCipher {
  readonly #cipher: RuntimeSecretCipher;

  constructor(masterKey: Uint8Array, instanceId: string) {
    this.#cipher = new RuntimeSecretCipher(masterKey, instanceId);
  }

  encrypt(clientId: string, purpose: SiteSecretPurpose, version: number, plaintext: string | Buffer): EncryptedSecret {
    checkVersion(version);
    return this.#cipher.encrypt(secretName(clientId, purpose), version, plaintext);
  }

  decrypt(clientId: string, purpose: SiteSecretPurpose, version: number, encrypted: EncryptedSecret): Buffer {
    checkVersion(version);
    return this.#cipher.decrypt(secretName(clientId, purpose), version, encrypted);
  }
}
