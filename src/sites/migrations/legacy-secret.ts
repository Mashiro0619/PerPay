import { RuntimeSecretCipher, type EncryptedSecret, type SiteSecretPurpose } from "../../settings/crypto.ts";
import { SiteSecretCipher } from "../crypto.ts";

/** Migration-only conversion: preserves plaintext/version; no legacy read fallback. */
export function reencryptLegacySiteSecret(input: {
  readonly masterKey: Uint8Array;
  readonly instanceId: string;
  readonly clientId: string;
  readonly purpose: SiteSecretPurpose;
  readonly version: number;
  readonly encrypted: EncryptedSecret;
}): EncryptedSecret {
  const legacy = new RuntimeSecretCipher(input.masterKey, input.instanceId);
  const site = new SiteSecretCipher(input.masterKey, input.instanceId);
  const plaintext = legacy.decrypt(input.purpose, input.version, input.encrypted);
  try {
    return site.encrypt(input.clientId, input.purpose, input.version, plaintext);
  } finally {
    plaintext.fill(0);
  }
}
