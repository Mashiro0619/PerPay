import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { releasePolicy } from "./release-policy.mjs";

export function readReleaseMetadata(root) {
  const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const versionSource = readFileSync(resolve(root, "src/version.ts"), "utf8");
  const compatibility = /DATABASE_COMPATIBILITY\s*=\s*Object\.freeze\(\{\s*minimum:\s*(\d+),\s*maximum:\s*(\d+),?\s*\}\)/u.exec(versionSource);
  if (typeof packageJson.version !== "string" || compatibility === null) throw new Error("release metadata is incomplete");
  const policy = releasePolicy(packageJson.version);
  return {
    version: policy.version,
    prerelease: String(policy.prerelease),
    compose_image_tag: policy.composeImageTag,
    database_minimum: compatibility[1],
    database_maximum: compatibility[2],
  };
}

if (import.meta.main) {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  for (const [key, value] of Object.entries(readReleaseMetadata(root))) process.stdout.write(key + "=" + value + "\n");
}
