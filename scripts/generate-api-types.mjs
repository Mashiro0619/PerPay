import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "@hey-api/openapi-ts";
import YAML from "yaml";

const specification = YAML.parse(await readFile(new URL("../openapi.yaml", import.meta.url), "utf8"));
specification.components.parameters.AdminOrigin.required = false;
specification.paths = Object.fromEntries(Object.entries(specification.paths).filter(([path]) => path.startsWith("/api/admin/")));
const output = fileURLToPath(new URL("../web/src/api/generated/", import.meta.url));
const checking = process.argv.includes("--check");
const temporary = await mkdtemp(join(tmpdir(), "perpay-api-types-"));

try {
  await createClient({
    input: specification,
    output: { path: temporary, postProcess: [] },
    plugins: ["@hey-api/typescript", "@hey-api/client-fetch", "@hey-api/sdk"],
    logs: { level: "silent" },
  });
  for (const file of await readdir(temporary, { recursive: true, withFileTypes: true })) {
    if (!file.isFile() || !file.name.endsWith(".ts")) continue;
    const source = join(file.parentPath, file.name);
    const relative = source.slice(temporary.length + 1);
    const target = join(output, relative);
    const declarations = (await readFile(source, "utf8"))
      .replace(/\/\*\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/\n\s*\n/g, "\n");
    if (checking) {
      if (await readFile(target, "utf8") !== declarations) {
        throw new Error("API 类型已过期，请运行 npm run api:types 并提交生成的文件。");
      }
    } else {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, declarations, "utf8");
    }
  }
} finally {
  if (dirname(resolve(temporary)) !== resolve(tmpdir()) || !basename(temporary).startsWith("perpay-api-types-")) {
    throw new Error("临时目录不在预期边界内。");
  }
  await rm(temporary, { recursive: true, force: true });
}
