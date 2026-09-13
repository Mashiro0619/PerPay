import { isIP } from "node:net";

/** Shared /64 budgets prevent cheap IPv6 interface-address rotation. */
export function aggregateRateLimitSource(sourceAddress: string): string {
  if (isIP(sourceAddress) !== 6) return sourceAddress;
  const groups = parseIpv6Groups(sourceAddress);
  if (groups === undefined) return sourceAddress;
  if (
    groups.slice(0, 5).every((group) => group === 0) &&
    groups[5] === 0xffff
  ) {
    return [
      groups[6]! >> 8,
      groups[6]! & 0xff,
      groups[7]! >> 8,
      groups[7]! & 0xff,
    ].join(".");
  }
  return `${groups.slice(0, 4).map((group) => group.toString(16)).join(":")}::/64`;
}

function parseIpv6Groups(address: string): readonly number[] | undefined {
  const halves = address.split("::");
  if (halves.length > 2) return undefined;
  const left = parseIpv6Half(halves[0] ?? "");
  const right = parseIpv6Half(halves[1] ?? "");
  if (left === undefined || right === undefined) return undefined;
  if (halves.length === 1) return left.length === 8 ? left : undefined;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return undefined;
  return [...left, ...Array.from({ length: missing }, () => 0), ...right];
}

function parseIpv6Half(value: string): readonly number[] | undefined {
  if (value === "") return [];
  const groups: number[] = [];
  for (const part of value.split(":")) {
    if (part.includes(".")) {
      const octets = part.split(".").map(Number);
      if (
        octets.length !== 4 ||
        octets.some((octet) => !Number.isSafeInteger(octet) || octet < 0 || octet > 255)
      ) {
        return undefined;
      }
      groups.push((octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!);
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/i.test(part)) return undefined;
    groups.push(Number.parseInt(part, 16));
  }
  return groups;
}
