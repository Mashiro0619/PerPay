import { parseReleaseVersion } from "../src/shared/release-version.ts";

/** Stable releases alone own latest; preview downloads must stay pinned to their version. */
export function releasePolicy(version) {
  const parsed = parseReleaseVersion(version);
  if (!parsed) throw new Error("release version must be canonical X.Y.Z or X.Y.Z-prerelease (without +build)");
  const prerelease = parsed.prerelease.length > 0;
  return Object.freeze({
    version,
    prerelease,
    composeImageTag: prerelease ? version : "latest",
    promoteLatest: !prerelease,
  });
}
