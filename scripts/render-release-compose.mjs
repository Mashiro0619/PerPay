import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectComposeContract } from "./compose-contract.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const outputArgument = process.argv[2];

if (outputArgument === undefined || outputArgument.length === 0) {
  throw new Error("release Compose output path is required");
}

const source = readFileSync(resolve(root, "docker-compose.yml"), "utf8");
const expectedImage = "ghcr.io/mashiro0619/perpay:latest";
if (inspectComposeContract(source).image !== expectedImage) {
  throw new Error("root Compose app.image must use the latest channel");
}

const output = resolve(root, outputArgument);
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, source, "utf8");
