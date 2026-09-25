import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { inspectVersionFiles } from "../scripts/check-version.mjs";
import { readReleaseMetadata } from "../scripts/release-metadata.mjs";
import { renderReleaseCompose } from "../scripts/render-release-compose.mjs";
import { releasePolicy } from "../scripts/release-policy.mjs";
import { inspectComposeContract } from "../scripts/compose-contract.mjs";
import { queryGhcrVersionTag } from "../scripts/registry-manifest-status.mjs";

const compose = readFileSync(new URL("../docker-compose.yml", import.meta.url), "utf8");
const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");

function withVersionFiles(version, run) {
  const root = mkdtempSync(join(tmpdir(), "perpay-release-policy-"));
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ version }));
    writeFileSync(join(root, "package-lock.json"), JSON.stringify({ version, packages: { "": { version } } }));
    writeFileSync(join(root, "src/version.ts"), 'export const APP_VERSION = ' + JSON.stringify(version) + ';\nexport const DATABASE_COMPATIBILITY = Object.freeze({ minimum: 24, maximum: 26 });\n');
    writeFileSync(join(root, "Dockerfile"), dockerfile.replace(/^ARG APP_VERSION=.+$/m, () => "ARG APP_VERSION=" + version));
    writeFileSync(join(root, "docker-compose.yml"), compose);
    return run(root);
  } finally {
    const target = realpathSync(root);
    assert.equal(resolve(target), resolve(root));
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith("perpay-release-policy-"));
    rmSync(target, { recursive: true, force: true });
  }
}

for (const version of ["0.3.0-alpha.1", "0.3.0-beta.2", "0.3.0-rc.10", "0.3.0"]) {
  test("validates matching package, image and tag versions for " + version, () => {
    withVersionFiles(version, root => {
      assert.deepEqual(inspectVersionFiles(root, "v" + version), { version, errors: [] });
      assert.notEqual(inspectVersionFiles(root, "v9.0.0").errors.length, 0);
      const pre = version.includes("-");
      assert.deepEqual(readReleaseMetadata(root), {
        version, prerelease: String(pre), compose_image_tag: pre ? version : "latest", database_minimum: "24", database_maximum: "26",
      });
      const rendered = renderReleaseCompose(compose, version);
      const expectedTag = pre ? version : "latest";
      assert.equal(inspectComposeContract(rendered).image, "ghcr.io/mashiro0619/perpay:" + expectedTag);
      assert.equal(rendered.split("image: ghcr.io/mashiro0619/perpay:" + expectedTag).length - 1, 3);
      assert.equal(releasePolicy(version).promoteLatest, !pre);
      if (!pre) assert.equal(rendered, compose);
      else assert.match(rendered, /固定镜像版本/u);
    });
  });
}

for (const version of ["0.3.0-rc.01", "0.3.0-rc.", "0.3.0+build", "0.3.0-rc.1+build", "0.3.0;echo", "v0.3.0"]) {
  test("rejects noncanonical or non-publishable version " + version, () => {
    withVersionFiles(version, root => {
      assert.ok(inspectVersionFiles(root).errors.some(error => error.includes("canonical release version")));
      assert.throws(() => readReleaseMetadata(root));
      assert.throws(() => renderReleaseCompose(compose, version));
    });
  });
}

test("prerelease support does not relax cross-file version consistency", () => {
  for (const file of ["package-lock.json", "src/version.ts", "Dockerfile"]) {
    withVersionFiles("0.3.0-rc.1", root => {
      const target = join(root, file);
      writeFileSync(target, readFileSync(target, "utf8").replaceAll("0.3.0-rc.1", "0.3.0-rc.2"));
      assert.ok(inspectVersionFiles(root, "v0.3.0-rc.1").errors.some(error => error.includes("does not match")));
    });
  }
});

test("registry requests accept prerelease tags without relaxing repository and reference safety", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(String(url));
    assert.equal(options.method, "HEAD");
    assert.equal(options.redirect, "error");
    return new Response(null, { status: 200 });
  };
  assert.equal(await queryGhcrVersionTag("ghcr.io/mashiro0619/perpay", "0.3.0-rc.1", fetchImpl), "exists");
  assert.equal(calls[0], "https://ghcr.io/v2/mashiro0619/perpay/manifests/0.3.0-rc.1");
  for (const version of ["0.3.0-rc.01", "0.3.0-rc/1", "0.3.0-rc%2f1", "0.3.0+build"]) {
    await assert.rejects(queryGhcrVersionTag("ghcr.io/mashiro0619/perpay", version, fetchImpl));
  }
  assert.equal(calls.length, 1);
});
