import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectComposeContract, replaceComposeImage } from "./compose-contract.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const digest = process.argv[2];
const outputArgument = process.argv[3];

if (!/^sha256:[0-9a-f]{64}$/u.test(digest ?? "")) {
  throw new Error("release image digest must be a lowercase SHA-256 digest");
}
if (outputArgument === undefined || outputArgument.length === 0) {
  throw new Error("release Compose output path is required");
}

const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const source = readFileSync(resolve(root, "docker-compose.yml"), "utf8");
const expectedImage = `ghcr.io/mashiro0619/perpay:${packageJson.version}`;
if (inspectComposeContract(source).image !== expectedImage) {
  throw new Error("root Compose app.image does not match the package version");
}

const rendered = replaceComposeImage(source, `${expectedImage}@${digest}`);
const output = resolve(root, outputArgument);
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, rendered, "utf8");
