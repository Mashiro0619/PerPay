import { parseReleaseVersion } from "../src/shared/release-version.ts";

/** All release downloads stay pinned; stable releases also promote the latest channel. */
export function releasePolicy(version) {
  const parsed = parseReleaseVersion(version);
  if (!parsed) throw new Error("release version must be canonical X.Y.Z or X.Y.Z-prerelease (without +build)");
  const prerelease = parsed.prerelease.length > 0;
  return Object.freeze({
    version,
    prerelease,
    composeImageTag: version,
    promoteLatest: !prerelease,
  });
}
