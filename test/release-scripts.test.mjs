import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";

import { inspectComposeContract, replaceComposeImage } from "../scripts/compose-contract.mjs";
import {
  queryGhcrManifestDigest,
  queryGhcrVersionTag,
} from "../scripts/registry-manifest-status.mjs";

const validCompose = readFileSync(new URL("../docker-compose.yml", import.meta.url), "utf8");
const releaseWorkflowText = readFileSync(
  new URL("../.github/workflows/release.yml", import.meta.url),
  "utf8",
);
const validationWorkflowText = readFileSync(
  new URL("../.github/workflows/container-validation.yml", import.meta.url),
  "utf8",
);
const ciWorkflowText = readFileSync(
  new URL("../.github/workflows/ci.yml", import.meta.url),
  "utf8",
);
const releaseNotesText = readFileSync(
  new URL("../docs/releases/v0.1.0.md", import.meta.url),
  "utf8",
);
const dockerfileText = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
const noticeText = readFileSync(new URL("../NOTICE", import.meta.url), "utf8");

test("Compose contract accepts the default services and profile-gated maintenance topology", () => {
  const contract = inspectComposeContract(validCompose);
  assert.equal(contract.image, "ghcr.io/mashiro0619/perpay:0.1.0");

  const digest = `sha256:${"a".repeat(64)}`;
  const rendered = replaceComposeImage(validCompose, `${contract.image}@${digest}`);
  const renderedContract = inspectComposeContract(rendered);
  assert.equal(renderedContract.image, `${contract.image}@${digest}`);
  assert.equal(rendered.match(/perpay:0\.1\.0@sha256:a{64}/gu)?.length, 3);

  const parsed = parse(validCompose);
  assert.equal(parsed["x-perpay-backup-interval-seconds"], "86400");
  assert.equal(parsed.services.app.environment.PERPAY_BACKUP_INTERVAL_SECONDS, "86400");
  assert.equal(parsed.services.backup.environment.PERPAY_BACKUP_INTERVAL_SECONDS, "86400");
  assert.equal(parsed.services.backup.environment.PERPAY_BACKUP_KEEP_COUNT, "7");
  assert.equal(parsed.services.backup.healthcheck.interval, "5m");
  assert.equal(parsed.services.backup.healthcheck.timeout, "10s");
  assert.deepEqual(parsed.services.app.volumes, [
    "perpay-data:/data",
    "perpay-backups:/backups:ro",
  ]);
  assert.deepEqual(parsed.services.backup.volumes, [
    "perpay-data:/data:ro",
    "perpay-backups:/backups",
  ]);
  assert.deepEqual(parsed.services.maintenance.profiles, ["maintenance"]);
  assert.deepEqual(parsed.services.maintenance.volumes, [
    "perpay-data:/data",
    "perpay-backups:/backups",
  ]);
});

test("versioned release notes match the current database compatibility", () => {
  assert.match(releaseNotesText, /database schema 13/u);
  assert.match(releaseNotesText, /Supported database schema range: `13\.\.13`\./u);
});

test("Compose contract rejects duplicate keys, unexpected services, and renamed projects", () => {
  assert.throws(
    () => inspectComposeContract(`${validCompose}\nservices:\n  app: {}\n`),
    /duplicate|unique|exactly the app, backup, and maintenance services/u,
  );
  assert.throws(
    () => inspectComposeContract(validCompose.replace("  app:\n", "  worker:\n")),
    /exactly the app, backup, and maintenance services/u,
  );
  assert.throws(
    () => inspectComposeContract(validCompose.replace("name: perpay", "name: perpay-prod")),
    /project name must retain the official template value/u,
  );
});

test("Compose release template rejects locally filled configuration", () => {
  for (const [placeholder, configured] of [
    ["CHANGE_ME_TO_A_LONG_RANDOM_PASSWORD", "a-private-administrator-password"],
    ["http://localhost:8080", "https://pay.example.test"],
    ["CHANGE_ME_TO_A_43_CHARACTER_BASE64URL_SECRET", "A".repeat(43)],
    ["CHANGE_ME_TO_COLLECTION_CODE_PAYLOAD", "https://qr.example.test/private"],
    ["CHANGE_ME_TO_ALIPAY_APP_ID", "2026000000000000"],
    ["CHANGE_ME_TO_ALIPAY_APPLICATION_PRIVATE_KEY", "PRIVATE_KEY_MATERIAL"],
    ["CHANGE_ME_TO_ALIPAY_PLATFORM_PUBLIC_KEY", "PLATFORM_PUBLIC_KEY_MATERIAL"],
    ["https://CHANGE_ME_TO_YOUR_WEBHOOK_HOST", "https://hooks.example.test"],
    ["CHANGE_ME_TO_ANOTHER_43_CHARACTER_BASE64URL_SECRET", "B".repeat(43)],
  ]) {
    assert.throws(
      () => inspectComposeContract(validCompose.replace(placeholder, configured)),
      /must retain its release template value/u,
    );
  }
  assert.throws(
    () => inspectComposeContract(validCompose.replace(
      '&perpay-backup-interval-seconds "86400"',
      '&perpay-backup-interval-seconds "7200"',
    )),
    /backup interval extension must retain its anchored template value/u,
  );
});

test("Compose contract rejects privilege and volume-boundary escapes", () => {
  for (const fragment of [
    "    privileged: true\n",
    "    build: .\n",
    "    command: [node]\n",
    "    cap_add: [SYS_ADMIN]\n",
    "    network_mode: host\n",
    "    env_file: /tmp/host-secrets\n",
  ]) {
    assert.throws(() => inspectComposeContract(
      validCompose.replace("    image:", `${fragment}    image:`),
    ));
  }
  for (const mutated of [
    validCompose.replace("perpay-data:/data", "/:/data"),
    validCompose.replace("perpay-backups:/backups:ro", "perpay-backups:/backups"),
    validCompose.replace("perpay-data:/data:ro", "perpay-data:/data"),
    validCompose.replace("  perpay-backups:\n", "  external-backups: {}\n"),
    validCompose.replace('    user: "1000:1000"', '    user: "0:0"'),
    validCompose.replace("    read_only: true", "    read_only: false"),
    validCompose.replace("      - ALL", "      - NET_RAW"),
    validCompose.replace(/      PERPAY_API_SECRET:.*\n/u, ""),
  ]) {
    assert.throws(() => inspectComposeContract(mutated));
  }
  assert.throws(() => inspectComposeContract(validCompose.replace(
    "  backup:\n",
    "  backup:\n    privileged: true\n",
  )));
});

test("render-release-compose writes a digest-pinned file without changing the source", () => {
  const outputDirectory = mkdtempSync(join(tmpdir(), "perpay-release-compose-"));
  try {
    const output = join(outputDirectory, "docker-compose.yml");
    const result = spawnSync(process.execPath, [
      "scripts/render-release-compose.mjs",
      `sha256:${"b".repeat(64)}`,
      output,
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(output, "utf8"), /perpay:0\.1\.0@sha256:b{64}/u);
  } finally {
    rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test("the application image contains only the pinned Node runtime and application", () => {
  assert.match(
    dockerfileText,
    /node:24\.19\.0-alpine3\.24@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43/u,
  );
  assert.doesNotMatch(dockerfileText, /GO_IMAGE|RESTIC|golang|--from=restic|third_party/iu);
  assert.match(dockerfileText, /org\.opencontainers\.image\.licenses="Apache-2\.0"/u);
  assert.match(dockerfileText, /mkdir -p \/data \/backups/u);
  assert.match(dockerfileText, /VOLUME \["\/data", "\/backups"\]/u);
  assert.match(dockerfileText, /http:\/\/127\.0\.0\.1:8080\/healthz/u);
  assert.doesNotMatch(dockerfileText, /\/readyz/u);
  assert.doesNotMatch(noticeText, /restic|Go toolchain|golang/iu);
  assert.equal(existsSync(new URL("../third_party/restic/LICENSE", import.meta.url)), false);
});

test("release builds, scans, fixes, verifies, and publishes one version image", () => {
  const workflow = parse(releaseWorkflowText);
  assert.deepEqual(Object.keys(workflow.jobs), ["verify", "publish"]);
  assert.equal(workflow.jobs.verify["timeout-minutes"], 30);
  assert.equal(workflow.jobs.publish["timeout-minutes"], 60);
  assert.equal(workflow.permissions.contents, "read");
  assert.deepEqual(workflow.jobs.publish.permissions, {
    contents: "write",
    packages: "write",
  });
  assert.equal(workflow.concurrency.group, "release-${{ github.ref }}");
  assert.equal(workflow.jobs.publish.environment, undefined);

  const verifySteps = workflow.jobs.verify.steps;
  assert.ok(verifySteps.some((step) => step.name === "Verify version and release commit"));
  const gates = verifySteps.find((step) => step.name === "Run release checks");
  assert.match(gates?.run ?? "", /npm run typecheck/u);
  assert.match(gates?.run ?? "", /npm test/u);
  assert.match(gates?.run ?? "", /npm run build/u);
  assert.match(gates?.run ?? "", /npm audit --audit-level=high/u);

  const publishSteps = workflow.jobs.publish.steps;
  const builds = publishSteps.filter((step) => step.uses?.includes("docker/build-push-action@"));
  assert.equal(builds.length, 2);
  assert.deepEqual(builds.map((step) => step.with.platforms).sort(), [
    "linux/amd64",
    "linux/arm64",
  ]);
  for (const build of builds) {
    assert.equal(build.with.push, true);
    assert.match(build.with.outputs, /push-by-digest=true/u);
    assert.equal(build.with.provenance, false);
  }

  const scans = publishSteps.filter((step) => step.uses?.includes("aquasecurity/trivy-action@"));
  assert.equal(scans.length, 2);
  for (const scan of scans) {
    assert.equal(scan.with.version, "v0.70.0");
    assert.equal(scan.with.cache, false);
    assert.equal(scan.with.severity, "HIGH,CRITICAL");
    assert.equal(scan.with["exit-code"], 1);
  }

  const fixedImage = publishSteps.find(
    (step) => step.name === "Publish or verify the fixed version image",
  );
  assert.ok(fixedImage);
  assert.match(fixedImage.run, /registry-manifest-status\.mjs/u);
  assert.match(fixedImage.run, /both existing platform manifests are byte-identical/u);
  assert.match(fixedImage.run, /tag_state/u);
  assert.match(fixedImage.run, /docker buildx imagetools create/u);

  const buildsRun = builds.every((step) => step.if === undefined);
  assert.equal(buildsRun, true);
  assert.doesNotMatch(releaseWorkflowText, /DOCKER_CONFIG=.*imagetools inspect/u);
  assert.match(releaseWorkflowText, /--digest/u);

  const render = publishSteps.find(
    (step) => step.name === "Render and validate the digest-pinned release Compose",
  );
  assert.match(render?.run ?? "", /render-release-compose\.mjs/u);
  assert.match(render?.run ?? "", /config --quiet/u);
  assert.match(render?.run ?? "", /--profile maintenance -f .*config --images/u);

  const smoke = publishSteps.find(
    (step) => step.name === "Exercise Linux Compose, backup, restore, and persistence",
  );
  for (const required of [
    "compose up -d --wait --wait-timeout 900 app",
    "compose config --services",
    "compose_with_maintenance config --services",
    "compose_with_maintenance config --images",
    "http://127.0.0.1:8080/healthz",
    "value.status!=='not_ready'",
    "node dist/backup/runner.js run-once",
    "node dist/backup/runner.js list-backups",
    "node dist/backup/runner.js health",
    "compose stop backup",
    "compose stop app",
    "compose run --rm --no-deps maintenance",
    "--confirm-replace-current-database",
    "compose down --remove-orphans",
  ]) {
    assert.equal(smoke?.run.includes(required), true, `missing release smoke command: ${required}`);
  }

  const publish = publishSteps.find((step) => step.name === "Publish the GitHub Release");
  assert.match(publish?.run ?? "", /gh release create/u);
  assert.match(publish?.run ?? "", /--latest=false/u);
  assert.doesNotMatch(releaseWorkflowText, /attest-build-provenance|\.sbom|:latest|candidate|bootstrap/iu);
  assert.equal(
    [...releaseWorkflowText.matchAll(/secrets\.([A-Za-z0-9_]+)/gu)].every(
      (match) => match[1] === "GITHUB_TOKEN",
    ),
    true,
  );
  assert.equal(existsSync(new URL("../.github/release-allowed-signers", import.meta.url)), false);
});

test("daily CI is one bounded Linux Node job", () => {
  const workflow = parse(ciWorkflowText);
  assert.deepEqual(Object.keys(workflow.jobs), ["check"]);
  assert.equal(workflow.jobs.check["runs-on"], "ubuntu-24.04");
  assert.equal(workflow.jobs.check["timeout-minutes"], 20);
  const commands = workflow.jobs.check.steps.map((step) => step.run).filter(Boolean);
  assert.deepEqual(commands, [
    "npm ci --ignore-scripts",
    "npm run check",
    "npm audit --audit-level=high",
  ]);
  assert.doesNotMatch(ciWorkflowText, /windows|docker build|trivy|compose up/iu);
});

test("container validation is manual and exercises the real deployment lifecycle", () => {
  const workflow = parse(validationWorkflowText);
  assert.deepEqual(workflow.on, { workflow_dispatch: null });
  assert.deepEqual(Object.keys(workflow.jobs), ["validate"]);
  assert.equal(workflow.jobs.validate["runs-on"], "ubuntu-24.04");
  const steps = workflow.jobs.validate.steps;
  assert.ok(steps.some((step) => step.run?.includes("docker build")));
  assert.ok(steps.some((step) => step.uses?.includes("aquasecurity/trivy-action@")));
  const smoke = steps.find(
    (step) => step.name === "Exercise Compose, backup, restore, and persistence",
  );
  for (const required of [
    "compose config --quiet",
    "compose config --services",
    "compose_with_maintenance config --services",
    "compose_with_maintenance config --images",
    "http://127.0.0.1:8080/healthz",
    "node dist/backup/runner.js run-once",
    "node dist/backup/runner.js list-backups",
    "node dist/backup/runner.js health",
    "compose run --rm --no-deps maintenance",
    "--confirm-replace-current-database",
    "compose down --volumes --remove-orphans",
  ]) {
    assert.equal(smoke?.run.includes(required), true, `missing manual smoke command: ${required}`);
  }
});

test("registry status accepts only authoritative manifest 200 and 404 responses", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(null, {
      status: calls.length === 1 ? 401 : 200,
      headers: calls.length === 1
        ? {
            "www-authenticate":
              'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:mashiro0619/perpay:pull"',
          }
        : undefined,
    });
  };
  const tokenFetch = async (url, options) => {
    if (String(url).startsWith("https://ghcr.io/token?")) {
      return new Response(JSON.stringify({ token: "a".repeat(32) }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return fetchImpl(url, options);
  };
  assert.equal(
    await queryGhcrVersionTag("ghcr.io/mashiro0619/perpay", "0.1.0", tokenFetch),
    "exists",
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.method, "HEAD");
  assert.equal(calls[1].options.headers.Authorization, `Bearer ${"a".repeat(32)}`);

  assert.equal(
    await queryGhcrVersionTag("ghcr.io/mashiro0619/perpay", "0.1.0", async () =>
      new Response(null, { status: 404 })),
    "missing",
  );
  await assert.rejects(
    () => queryGhcrVersionTag("ghcr.io/mashiro0619/perpay", "0.1.0", async () =>
      new Response(null, { status: 403 })),
    /unexpected HTTP 403/u,
  );
});

test("registry digest lookup requires a canonical public digest header", async () => {
  assert.equal(
    await queryGhcrManifestDigest("ghcr.io/mashiro0619/perpay", "0.1.0", async () =>
      new Response(null, {
        status: 200,
        headers: { "docker-content-digest": `sha256:${"c".repeat(64)}` },
      })),
    `sha256:${"c".repeat(64)}`,
  );
  await assert.rejects(
    () => queryGhcrManifestDigest("ghcr.io/mashiro0619/perpay", "0.1.0", async () =>
      new Response(null, { status: 200 })),
    /canonical SHA-256 digest/u,
  );
  await assert.rejects(
    () => queryGhcrManifestDigest("ghcr.io/mashiro0619/perpay", "0.1.0", async () =>
      new Response(null, { status: 404 })),
    /unexpected HTTP 404/u,
  );
});

test("registry status rejects malformed authentication and input boundaries", async () => {
  await assert.rejects(
    () => queryGhcrVersionTag("ghcr.io/mashiro0619/perpay", "0.1.0", async () =>
      new Response(null, {
        status: 401,
        headers: {
          "www-authenticate":
            'Bearer realm="https://evil.invalid/token",service="ghcr.io",scope="repository:mashiro0619/perpay:pull"',
        },
      })),
    /unexpected Bearer/u,
  );
  await assert.rejects(
    () => queryGhcrVersionTag("docker.io/mashiro0619/perpay", "0.1.0", async () =>
      new Response(null, { status: 404 })),
    /lowercase ghcr\.io repository/u,
  );
  await assert.rejects(
    () => queryGhcrVersionTag("ghcr.io/mashiro0619/perpay", "latest", async () =>
      new Response(null, { status: 404 })),
    /stable semantic version/u,
  );
});
