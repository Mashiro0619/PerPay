import { createIpPolicy, normalizeIpAddress } from "./ip-policy.ts";

const MAX_TRUSTED_PROXY_CONFIG_BYTES = 4 * 1024;
const MAX_FORWARDED_FOR_BYTES = 4 * 1024;
const MAX_FORWARDED_HOPS = 32;

export interface TrustedProxyPolicy {
  readonly cidrs: readonly string[];
  isTrusted(address: string): boolean;
}

export class ForwardedAddressError extends Error {
  constructor() {
    super("trusted proxy supplied an invalid X-Forwarded-For header");
    this.name = "ForwardedAddressError";
  }
}

export function parseTrustedProxyPolicy(value: string): TrustedProxyPolicy {
  if (Buffer.byteLength(value, "utf8") > MAX_TRUSTED_PROXY_CONFIG_BYTES) {
    throw new Error("PERPAY_TRUSTED_PROXY_CIDRS is too large");
  }
  if (value === "") return createPolicy([]);

  const entries = value.split(",").map((entry) => entry.trim());
  if (entries.some((entry) => entry === "")) {
    throw new Error("PERPAY_TRUSTED_PROXY_CIDRS contains an empty entry");
  }
  return createPolicy(entries);
}

export function resolveForwardedClientAddress(
  policy: TrustedProxyPolicy,
  peerAddress: string | undefined,
  forwardedFor: string | undefined,
): string {
  const peer = normalizeIpAddress(peerAddress) ?? "unknown";
  if (!policy.isTrusted(peer) || forwardedFor === undefined) return peer;
  if (
    forwardedFor.length === 0 ||
    Buffer.byteLength(forwardedFor, "utf8") > MAX_FORWARDED_FOR_BYTES
  ) {
    throw new ForwardedAddressError();
  }

  const parts = forwardedFor.split(",");
  if (parts.length === 0 || parts.length > MAX_FORWARDED_HOPS) {
    throw new ForwardedAddressError();
  }
  const addresses = parts.map((part) => {
    const address = normalizeIpAddress(part.trim());
    if (address === undefined) throw new ForwardedAddressError();
    return address;
  });

  for (let index = addresses.length - 1; index >= 0; index -= 1) {
    const address = addresses[index]!;
    if (!policy.isTrusted(address)) return address;
  }
  return addresses[0]!;
}

function createPolicy(entries: readonly string[]): TrustedProxyPolicy {
  try {
    return createIpPolicy(entries);
  } catch (error) {
    throw new Error(
      (error as Error).message.replace(
        "IP policy",
        "PERPAY_TRUSTED_PROXY_CIDRS",
      ),
    );
  }
}
