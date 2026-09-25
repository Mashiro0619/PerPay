import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectComposeContract, replaceComposeImage } from "./compose-contract.mjs";
import { releasePolicy } from "./release-policy.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

export function renderReleaseCompose(source, version) {
  const policy = releasePolicy(version);
  const expectedImage = "ghcr.io/mashiro0619/perpay:latest";
  if (inspectComposeContract(source).image !== expectedImage) {
    throw new Error("root Compose app.image must use the latest channel");
  }
  if (!policy.prerelease) return source;
  return "# 预发布版本：固定镜像版本，不跟随稳定版 latest；升级需显式修改三个服务的版本。\n" +
    replaceComposeImage(source, "ghcr.io/mashiro0619/perpay:" + policy.composeImageTag);
}

if (import.meta.main) {
  const outputArgument = process.argv[2];
  if (outputArgument === undefined || outputArgument.length === 0) throw new Error("release Compose output path is required");
  const source = readFileSync(resolve(root, "docker-compose.yml"), "utf8");
  const version = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;
  const rendered = renderReleaseCompose(source, version);
  const output = resolve(root, outputArgument);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, rendered, "utf8");
}
