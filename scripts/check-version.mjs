import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectComposeContract } from "./compose-contract.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const packageVersion = packageJson.version;
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const errors = [];

if (typeof packageVersion !== "string" || !versionPattern.test(packageVersion)) {
  errors.push("package.json version must be a stable semantic version");
}

const packageLock = JSON.parse(readFileSync(resolve(root, "package-lock.json"), "utf8"));
if (packageLock.version !== packageVersion) {
  errors.push(`package-lock.json version=${packageLock.version ?? "<missing>"} does not match package.json=${packageVersion}`);
}
if (packageLock.packages?.[""]?.version !== packageVersion) {
  errors.push(
    `package-lock.json root package version=${packageLock.packages?.[""]?.version ?? "<missing>"} ` +
      `does not match package.json=${packageVersion}`,
  );
}

const versionSource = readFileSync(resolve(root, "src/version.ts"), "utf8");
const sourceVersion = /APP_VERSION\s*=\s*["']([^"']+)["']/u.exec(versionSource)?.[1];
if (sourceVersion !== packageVersion) {
  errors.push(`src/version.ts APP_VERSION=${sourceVersion ?? "<missing>"} does not match package.json=${packageVersion}`);
}
const compatibility = /DATABASE_COMPATIBILITY\s*=\s*Object\.freeze\(\{\s*minimum:\s*(\d+),\s*maximum:\s*(\d+),?\s*\}\)/u.exec(
  versionSource,
);
const databaseMinimum = compatibility?.[1];
const databaseMaximum = compatibility?.[2];
if (databaseMinimum === undefined || databaseMaximum === undefined) {
  errors.push("src/version.ts DATABASE_COMPATIBILITY is invalid");
}

const releaseNotesPath = resolve(root, "docs", "releases", `v${packageVersion}.md`);
if (!existsSync(releaseNotesPath)) {
  errors.push(`versioned release notes are missing: docs/releases/v${packageVersion}.md`);
} else {
  const releaseNotes = readFileSync(releaseNotesPath, "utf8");
  for (const heading of ["## Schema migration", "## Upgrade and rollback risk", "## Operational notes"]) {
    if (releaseNotes.split(heading).length !== 2) {
      errors.push(`versioned release notes must contain exactly one ${heading} section`);
    }
  }
  if (releaseNotes.length < 400) {
    errors.push("versioned release notes must describe migration and operational risk in detail");
  }
  if (
    databaseMinimum !== undefined &&
    databaseMaximum !== undefined &&
    !releaseNotes.includes(
      `Supported database schema range: \`${databaseMinimum}..${databaseMaximum}\`.`,
    )
  ) {
    errors.push(
      `versioned release notes must declare database schema range ${databaseMinimum}..${databaseMaximum}`,
    );
  }
}

const compose = readFileSync(resolve(root, "docker-compose.yml"), "utf8");
let composeImage;
try {
  composeImage = inspectComposeContract(compose).image;
} catch (error) {
  errors.push(`docker-compose.yml structure is invalid: ${error instanceof Error ? error.message : String(error)}`);
}
const imageVersion = typeof composeImage === "string"
  ? /^ghcr\.io\/mashiro0619\/perpay:([^\s@]+)$/u.exec(composeImage)?.[1]
  : undefined;
if (imageVersion !== packageVersion) {
  errors.push(`docker-compose.yml image tag=${imageVersion ?? "<missing>"} does not match package.json=${packageVersion}`);
}

const dockerfile = readFileSync(resolve(root, "Dockerfile"), "utf8");
const buildVersion = /^ARG APP_VERSION=(.+)$/mu.exec(dockerfile)?.[1]?.trim();
if (buildVersion !== packageVersion) {
  errors.push(`Dockerfile APP_VERSION=${buildVersion ?? "<missing>"} does not match package.json=${packageVersion}`);
}
if (!/^FROM \$\{NODE_IMAGE\} AS runtime\s*\r?\nARG APP_VERSION$/mu.test(dockerfile)) {
  errors.push("Dockerfile runtime stage must import APP_VERSION");
}
if (!/org\.opencontainers\.image\.version="\$\{APP_VERSION\}"/u.test(dockerfile)) {
  errors.push("Dockerfile OCI version label must use APP_VERSION");
}

const requestedTag = process.argv[2];
if (requestedTag !== undefined) {
  if (requestedTag !== `v${packageVersion}`) {
    errors.push(`release tag=${requestedTag} does not match package.json=${packageVersion}`);
  }
}

if (errors.length > 0) {
  for (const error of errors) process.stderr.write(`version check: ${error}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`version check: ${packageVersion}\n`);
}
