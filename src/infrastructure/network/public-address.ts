import { BlockList, isIP } from "node:net";

const blockedIpv4Addresses = createBlockedIpv4AddressList();
const blockedIpv6Addresses = createBlockedIpv6AddressList();
const globallyRoutedIpv6Addresses = new BlockList();
globallyRoutedIpv6Addresses.addSubnet("2000::", 3, "ipv6");

const dnsLabelPattern = /^(?:[a-z0-9]|[a-z0-9][a-z0-9-]{0,61}[a-z0-9])$/i;

export function isValidWebhookDnsHostname(hostname: string): boolean {
  if (
    hostname.length === 0 ||
    hostname.endsWith(".") ||
    Buffer.byteLength(hostname, "utf8") > 253 ||
    isIP(hostname) !== 0
  ) {
    return false;
  }
  return hostname.split(".").every((label) =>
    Buffer.byteLength(label, "utf8") <= 63 && dnsLabelPattern.test(label)
  );
}

/**
 * Conservative public-address policy for user-configurable outbound targets.
 *
 * Unlike a fixed provider gateway, a webhook hostname is user-controlled. A
 * resolution is therefore accepted only when every address is globally
 * routable. The policy intentionally rejects the complete IANA 2001::/23
 * special-purpose block instead of maintaining narrow anycast exceptions.
 */
export function isPublicWebhookAddress(address: string, family: number): boolean {
  if (isIP(address) !== family) return false;
  if (family === 4) return !blockedIpv4Addresses.check(address, "ipv4");
  if (family !== 6) return false;
  return globallyRoutedIpv6Addresses.check(address, "ipv6") &&
    !blockedIpv6Addresses.check(address, "ipv6");
}

function createBlockedIpv4AddressList(): BlockList {
  const blocked = new BlockList();
  for (const [network, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ] as const) {
    blocked.addSubnet(network, prefix, "ipv4");
  }
  return blocked;
}

function createBlockedIpv6AddressList(): BlockList {
  const blocked = new BlockList();
  for (const [network, prefix] of [
    ["2001::", 23],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["3fff::", 20],
  ] as const) {
    blocked.addSubnet(network, prefix, "ipv6");
  }
  return blocked;
}
