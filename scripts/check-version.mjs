import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectComposeContract } from "./compose-contract.mjs";
import { isReleaseVersion } from "../src/shared/release-version.ts";

export function inspectVersionFiles(root, requestedTag) {
  const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const packageVersion = packageJson.version;
  const errors = [];

  if (!isReleaseVersion(packageVersion)) {
    errors.push("package.json version must be a canonical release version (X.Y.Z or X.Y.Z-prerelease, without +build)");
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

  const compose = readFileSync(resolve(root, "docker-compose.yml"), "utf8");
  let composeImage;
  try {
    composeImage = inspectComposeContract(compose).image;
  } catch (error) {
    errors.push(`docker-compose.yml structure is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  const expectedComposeImage = "ghcr.io/mashiro0619/perpay:latest";
  if (composeImage !== expectedComposeImage) {
    errors.push(`docker-compose.yml image=${composeImage ?? "<missing>"} must be ${expectedComposeImage}`);
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

  if (requestedTag !== undefined) {
    if (requestedTag !== `v${packageVersion}`) {
      errors.push(`release tag=${requestedTag} does not match package.json=${packageVersion}`);
    }
  }

  return { version: packageVersion, errors };
}

if (import.meta.main) {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const { version, errors } = inspectVersionFiles(root, process.argv[2]);
  if (errors.length > 0) {
    for (const error of errors) process.stderr.write(`version check: ${error}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`version check: ${version}\n`);
  }
}
