import { BlockList, isIP, SocketAddress } from "node:net";

const MAX_TRUSTED_PROXY_CONFIG_BYTES = 4 * 1024;
const MAX_FORWARDED_FOR_BYTES = 4 * 1024;
const MAX_FORWARDED_HOPS = 32;
const canonicalPrefixPattern = /^(?:0|[1-9][0-9]*)$/;
const ipv4MappedPattern = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

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
  const blockList = new BlockList();
  for (const entry of entries) {
    const separator = entry.lastIndexOf("/");
    const addressText = separator === -1 ? entry : entry.slice(0, separator);
    const prefixText = separator === -1 ? undefined : entry.slice(separator + 1);
    const address = normalizeIpAddress(addressText);
    if (address === undefined || (separator !== -1 && entry.indexOf("/") !== separator)) {
      throw new Error(`PERPAY_TRUSTED_PROXY_CIDRS contains an invalid address: ${entry}`);
    }
    const family = isIP(address);
    const maximumPrefix = family === 4 ? 32 : 128;
    const prefix = prefixText === undefined
      ? maximumPrefix
      : canonicalPrefixPattern.test(prefixText)
        ? Number(prefixText)
        : Number.NaN;
    if (!Number.isSafeInteger(prefix) || prefix < 1 || prefix > maximumPrefix) {
      throw new Error(`PERPAY_TRUSTED_PROXY_CIDRS contains an invalid prefix: ${entry}`);
    }
    blockList.addSubnet(address, prefix, family === 4 ? "ipv4" : "ipv6");
  }

  const cidrs = Object.freeze([...entries]);
  return Object.freeze({
    cidrs,
    isTrusted(address: string): boolean {
      const normalized = normalizeIpAddress(address);
      if (normalized === undefined) return false;
      return blockList.check(normalized, isIP(normalized) === 4 ? "ipv4" : "ipv6");
    },
  });
}

function normalizeIpAddress(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) return undefined;
  const mapped = ipv4MappedPattern.exec(value);
  if (mapped && isIP(mapped[1]!) === 4) return mapped[1]!;
  const family = isIP(value);
  if (family === 4) return SocketAddress.parse(`${value}:0`)?.address;
  if (family === 6) return SocketAddress.parse(`[${value}]:0`)?.address;
  return undefined;
}
