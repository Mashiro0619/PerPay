import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

function rules(file: string) {
  return new Set(readFileSync(new URL("../" + file, import.meta.url), "utf8").split(/\r?\n/).map(line => line.trim()));
}

describe("workspace publication exclusions", () => {
  for (const file of [".gitignore", ".dockerignore"]) {
    it(file + " excludes SQLite databases and their sidecars", () => {
      const ignored = rules(file);
      for (const extension of ["sqlite", "sqlite3"]) {
        for (const suffix of ["", "-shm", "-wal", "-journal"]) {
          assert.ok(ignored.has("*." + extension + suffix), file + " must exclude " + extension + suffix);
        }
      }
    });
  }
  it("omits local agent tooling, browser traces and nested dependencies from Docker context", () => {
    const ignored = rules(".dockerignore");
    for (const directory of [".agents/", ".playwright-cli/", ".playwright-mcp/", "/%SystemDrive%/", "**/node_modules/"]) {
      assert.ok(ignored.has(directory), directory + " must not enter the build context");
    }
  });
});
