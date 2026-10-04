import { BlockList, isIP, SocketAddress } from "node:net";
import type { TrustedProxyPolicy } from "./trusted-proxy.ts";
const canonicalPrefixPattern = /^(?:0|[1-9][0-9]*)$/;
const ipv4MappedPattern = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;
export function createIpPolicy(
  entries: readonly string[],
  preserveMappedIpv6Prefixes = false,
): TrustedProxyPolicy {
  const blockList = new BlockList();
  for (const entry of entries) {
    const separator = entry.lastIndexOf("/");
    const addressText = separator === -1 ? entry : entry.slice(0, separator);
    const prefixText =
      separator === -1 ? undefined : entry.slice(separator + 1);
    // Administrator IPv6 CIDRs retain IPv6 prefix widths, even in dotted mapped notation.
    // The default preserves the historical trusted-proxy configuration behavior.
    const address = preserveMappedIpv6Prefixes && prefixText !== undefined && isIP(addressText) === 6
      ? SocketAddress.parse(`[${addressText}]:0`)?.address
      : normalizeIpAddress(addressText);
    if (
      address === undefined ||
      (separator !== -1 && entry.indexOf("/") !== separator)
    ) {
      throw new Error(`IP policy contains an invalid address: ${entry}`);
    }
    const family = isIP(address);
    const maximumPrefix = family === 4 ? 32 : 128;
    const prefix =
      prefixText === undefined
        ? maximumPrefix
        : canonicalPrefixPattern.test(prefixText)
          ? Number(prefixText)
          : Number.NaN;
    if (!Number.isSafeInteger(prefix) || prefix < 1 || prefix > maximumPrefix) {
      throw new Error(`IP policy contains an invalid prefix: ${entry}`);
    }
    blockList.addSubnet(address, prefix, family === 4 ? "ipv4" : "ipv6");
  }

  const cidrs = Object.freeze([...entries]);
  return Object.freeze({
    cidrs,
    isTrusted(address: string): boolean {
      const normalized = normalizeIpAddress(address);
      if (normalized === undefined) return false;
      return blockList.check(
        normalized,
        isIP(normalized) === 4 ? "ipv4" : "ipv6",
      );
    },
  });
}

export function normalizeIpAddress(
  value: string | undefined,
): string | undefined {
  if (value === undefined || value.length === 0) return undefined;
  const mapped = ipv4MappedPattern.exec(value);
  if (mapped && isIP(mapped[1]!) === 4) return mapped[1]!;
  const family = isIP(value);
  if (family === 4) return SocketAddress.parse(`${value}:0`)?.address;
  if (family === 6) return SocketAddress.parse(`[${value}]:0`)?.address;
  return undefined;
}
