import { mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = resolve(projectRoot, "web-dist");
const temporaryDirectory = `${outputDirectory}.tmp-${process.pid}`;

rmSync(temporaryDirectory, { recursive: true, force: true });
mkdirSync(temporaryDirectory, { recursive: true });

try {
  await build({
    absWorkingDir: projectRoot,
    bundle: true,
    charset: "utf8",
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
    },
    entryNames: "[name]",
    entryPoints: {
      admin: "web/admin/main.tsx",
    },
    format: "iife",
    jsx: "automatic",
    legalComments: "eof",
    logLevel: "info",
    minify: true,
    outdir: temporaryDirectory,
    platform: "browser",
    sourcemap: false,
    target: ["es2022"],
    treeShaking: true,
  });

  const adminBundle = resolve(temporaryDirectory, "admin.js");
  if (statSync(adminBundle).size === 0) {
    throw new Error("the admin browser bundle is empty");
  }

  rmSync(outputDirectory, { recursive: true, force: true });
  renameSync(temporaryDirectory, outputDirectory);
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
