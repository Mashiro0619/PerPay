import { createHash } from "node:crypto";

export const COLLECTION_PROFILE_FINGERPRINT_VERSION = 2;
/** QR Code version 40, error correction M, byte-mode payload capacity. */
export const MAX_COLLECTION_CODE_PAYLOAD_BYTES = 2_331;

export function fingerprintCollectionCodeProfile(
  codePayload: string,
  providerAccountKey = "primary",
): {
  readonly payloadFingerprint: string;
  readonly profileFingerprint: string;
} {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(providerAccountKey)) {
    throw new RangeError("collection profile provider account key is invalid");
  }
  const payloadFingerprint = createHash("sha256").update(codePayload, "utf8").digest("hex");
  const profileFingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        `perpay:collection-profile:v${COLLECTION_PROFILE_FINGERPRINT_VERSION}`,
        ["provider_account_key", providerAccountKey],
        ["payload_sha256", payloadFingerprint],
        ["evidence_policy", "UNIQUE_AMOUNT_AUTO"],
      ]),
      "utf8",
    )
    .digest("hex");
  return { payloadFingerprint, profileFingerprint };
}
