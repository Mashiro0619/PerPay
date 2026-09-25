import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parse } from "yaml";
import { compareReleaseVersions, isReleaseVersion, isPrereleaseVersion, isStableReleaseVersion, parseReleaseVersion, RELEASE_VERSION_PATTERN } from "../src/shared/release-version.ts";

describe("canonical release versions", () => {
  const precedence = [
    "1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2",
    "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0-rc.2", "1.0.0-rc.10", "1.0.0", "1.0.1-alpha.1", "1.0.1", "2.0.0",
  ];
  it("implements SemVer prerelease precedence, not lexical or release-date ordering", () => {
    for (const [i, first] of precedence.entries()) for (const [j, second] of precedence.entries()) {
      assert.equal(compareReleaseVersions(first, second), i < j ? -1 : i > j ? 1 : 0, first + " vs " + second);
    }
    assert.equal(compareReleaseVersions("1.0.0-1", "1.0.0-alpha"), -1);
    assert.equal(compareReleaseVersions("1.0.0-Alpha", "1.0.0-alpha"), -1);
    assert.equal(compareReleaseVersions("1.0.0-9007199254740992", "1.0.0-9007199254740993"), -1);
    assert.equal(compareReleaseVersions("1.9007199254740992.0", "1.9007199254740993.0"), -1);
  });

  it("accepts canonical identifiers without weakening release URL or container tag boundaries", () => {
    for (const version of [...precedence, "0.0.0", "1.2.3-0", "1.2.3-01a", "1.2.3-x-y.1", "1.2.3--"]) {
      assert.equal(isReleaseVersion(version), true, version);
      assert.ok(parseReleaseVersion(version));
      assert.equal(isStableReleaseVersion(version), !version.includes("-"));
      assert.equal(isPrereleaseVersion(version), version.includes("-"));
    }
    for (const version of [undefined, null, 1, {}, "", "v1.2.3", "1.2", "01.2.3", "1.02.3", "1.2.03", "1.2.3-", "1.2.3-rc.", "1.2.3-alpha..1", "1.2.3-01", "1.2.3-rc.01", "1.2.3-rc_1", "1.2.3+build", "1.2.3-rc.1+build", "1.2.3\n", " 1.2.3", "1.2.3-中文", "1.2.3-rc/1", "1.2.3-rc%2f1", "1.2.3-" + "a".repeat(59)]) {
      assert.equal(isReleaseVersion(version), false, String(version));
      assert.equal(parseReleaseVersion(version), null);
      assert.equal(isPrereleaseVersion(version), false);
    }
  });

  it("keeps the OpenAPI version and official release URL constraints aligned", () => {
    const api = parse(readFileSync(new URL("../openapi.yaml", import.meta.url), "utf8"));
    const schema = api.components.schemas.OfficialUpdate.properties;
    for (const field of [schema.current_version, schema.latest_version]) {
      assert.equal(field.pattern, RELEASE_VERSION_PATTERN);
      assert.equal(field.maxLength, 64);
    }
    const urlPattern = new RegExp(schema.release_url.pattern);
    assert.equal(urlPattern.test("https://github.com/Mashiro0619/PerPay/releases/tag/v1.2.3-rc.1"), true);
    assert.equal(urlPattern.test("https://github.com/other/project/releases/tag/v1.2.3-rc.1"), false);
    assert.equal(urlPattern.test("https://github.com/Mashiro0619/PerPay/releases/tag/v1.2.3-rc.01"), false);
  });
});
