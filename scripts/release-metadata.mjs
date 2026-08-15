import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const versionSource = readFileSync(resolve(root, "src/version.ts"), "utf8");
const compatibility = /DATABASE_COMPATIBILITY\s*=\s*Object\.freeze\(\{\s*minimum:\s*(\d+),\s*maximum:\s*(\d+),?\s*\}\)/u.exec(
  versionSource,
);

if (typeof packageJson.version !== "string" || compatibility === null) {
  throw new Error("release metadata is incomplete");
}

process.stdout.write(`version=${packageJson.version}\n`);
process.stdout.write(`database_minimum=${compatibility[1]}\n`);
process.stdout.write(`database_maximum=${compatibility[2]}\n`);
