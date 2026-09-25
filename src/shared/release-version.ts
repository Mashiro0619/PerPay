/** Canonical release versions: SemVer core/prerelease, without Docker-incompatible +build metadata. */
export const MAX_RELEASE_VERSION_LENGTH = 64;
const NUMERIC_IDENTIFIER = "(?:0|[1-9][0-9]*)";
const PRERELEASE_IDENTIFIER = "(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)";
export const RELEASE_VERSION_PATTERN =
  "^" + NUMERIC_IDENTIFIER + "\\." + NUMERIC_IDENTIFIER + "\\." + NUMERIC_IDENTIFIER +
  "(?:-" + PRERELEASE_IDENTIFIER + "(?:\\." + PRERELEASE_IDENTIFIER + ")*)?$";
const releasePattern = new RegExp(RELEASE_VERSION_PATTERN);

export interface ReleaseVersion {
  readonly core: readonly bigint[];
  readonly prerelease: readonly string[];
}

export function parseReleaseVersion(value: unknown): ReleaseVersion | null {
  if (typeof value !== "string" || value.length > MAX_RELEASE_VERSION_LENGTH ||
      value.trim() !== value || !releasePattern.test(value)) return null;
  const separator = value.indexOf("-");
  const core = separator === -1 ? value : value.slice(0, separator);
  const prerelease = separator === -1 ? [] : value.slice(separator + 1).split(".");
  return { core: core.split(".").map(BigInt), prerelease };
}

export function isReleaseVersion(value: unknown): value is string {
  return parseReleaseVersion(value) !== null;
}

export function isStableReleaseVersion(value: unknown): value is string {
  const parsed = parseReleaseVersion(value);
  return parsed !== null && parsed.prerelease.length === 0;
}

export function isPrereleaseVersion(value: unknown): boolean {
  return (parseReleaseVersion(value)?.prerelease.length ?? 0) > 0;
}

export function compareReleaseVersions(left: string, right: string): -1 | 0 | 1 {
  const first = parseReleaseVersion(left), second = parseReleaseVersion(right);
  if (!first || !second) throw new Error("Invalid release version");
  for (let index = 0; index < 3; index += 1) {
    if (first.core[index]! < second.core[index]!) return -1;
    if (first.core[index]! > second.core[index]!) return 1;
  }
  if (first.prerelease.length === 0) return second.prerelease.length === 0 ? 0 : 1;
  if (second.prerelease.length === 0) return -1;
  for (let index = 0; index < Math.max(first.prerelease.length, second.prerelease.length); index += 1) {
    const a = first.prerelease[index], b = second.prerelease[index];
    if (a === b) continue;
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    const aNumeric = /^[0-9]+$/.test(a), bNumeric = /^[0-9]+$/.test(b);
    if (aNumeric && bNumeric) return BigInt(a) < BigInt(b) ? -1 : 1;
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a < b ? -1 : 1;
  }
  return 0;
}
