import assert from "node:assert/strict";
import { globSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const documents = ["README.md", "USAGE.md", "web/README.md", "examples/node-client/README.md", ...globSync("docs/**/*.md", { cwd: root })];
const contents = new Map(documents.map(file => [resolve(root, file), readFileSync(resolve(root, file), "utf8")]));
const withoutFences = (text: string) => text.replace(/^```[^\n]*\n[\s\S]*?^```[ \t]*$/gm, "");

// GitHub-style anchors for the headings used in our documentation, including duplicate headings.
function anchors(text: string): Set<string> {
  const result = new Set<string>();
  const seen = new Map<string, number>();
  for (const match of withoutFences(text).matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const base = match[1]!.replace(/<[^>]*>/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/[*_`]/g, "").trim().toLowerCase().replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "").replace(/\s/g, "-");
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    result.add(base + (count ? "-" + count : ""));
  }
  for (const match of text.matchAll(/\b(?:id|name)="([^"]+)"/g)) result.add(match[1]!);
  return result;
}

function links(file: string, text: string) {
  const result: Array<{ target: string; anchor: string; source: string }> = [];
  for (const match of withoutFences(text).matchAll(/\]\(([^\s)]+)(?:\s+"[^"]*")?\)|\b(?:src|href)="([^"]+)"/g)) {
    const source = match[1] ?? match[2]!;
    if (/^(?:[a-z]+:|\/\/)/i.test(source)) continue;
    const [pathname = "", anchor = ""] = source.split("#");
    result.push({ target: pathname ? resolve(dirname(file), decodeURIComponent(pathname)) : file, anchor: decodeURIComponent(anchor), source });
  }
  return result;
}

const allLinks = [...contents].flatMap(([file, text]) => links(file, text).map(link => ({ ...link, file })));

describe("maintained documentation", () => {
  it("keeps local links, images and heading anchors valid", () => {
    assert.ok(allLinks.length > 0);
    for (const link of allLinks) {
      const label = relative(root, link.file) + " -> " + link.source;
      const target = relative(root, link.target);
      assert.ok(target !== ".." && !target.startsWith(".." + sep), label + " leaves the repository");
      assert.doesNotThrow(() => statSync(link.target), label);
      if (link.anchor && extname(link.target) === ".md") {
        assert.ok(anchors(contents.get(link.target) ?? readFileSync(link.target, "utf8")).has(link.anchor), label + " has no matching heading");
      }
    }
  });

  it("keeps documentation images referenced instead of accumulating unused captures", () => {
    const referenced = new Set(allLinks.map(link => link.target));
    for (const file of globSync(["docs/assets/**/*", "docs/screenshots/**/*"], { cwd: root })) {
      if (/\.(png|jpe?g|svg|webp)$/i.test(file)) assert.ok(referenced.has(resolve(root, file)), file + " is not referenced");
    }
  });

  it("uses real npm scripts and no machine-local paths in maintained guides", () => {
    for (const [file, text] of contents) {
      assert.doesNotMatch(text, /[A-Z]:[\\/]Users[\\/]|codex:\/\/threads\//i, relative(root, file));
      const packageFile = file === resolve(root, "examples/node-client/README.md")
        ? "examples/node-client/package.json" : "package.json";
      const rootScripts = (JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
      const scripts = (JSON.parse(readFileSync(resolve(root, packageFile), "utf8")) as { scripts: Record<string, string> }).scripts;
      for (const match of text.matchAll(/npm run ([\w:-]+)/g)) assert.ok(scripts[match[1]!] || rootScripts[match[1]!], relative(root, file) + ": " + match[0]);
    }
  });
});
