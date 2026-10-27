// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const normalizeNewlines = (value: string) => value.replace(/\r\n/g, "\n");
const notice = normalizeNewlines(readFileSync(new URL("../NOTICE", import.meta.url), "utf8"));

describe("third-party frontend notices", () => {
  for (const name of ["class-variance-authority", "jsqr", "lucide-react"]) {
    it(`includes the installed ${name} version and its complete license`, () => {
      const packageRoot = new URL(`../node_modules/${name}/`, import.meta.url);
      const metadata = JSON.parse(readFileSync(new URL("package.json", packageRoot), "utf8")) as { name: string; version: string };
      const license = normalizeNewlines(readFileSync(new URL("LICENSE", packageRoot), "utf8")).trimEnd();
      assert.equal(metadata.name, name);
      assert.ok(license.length > 0);
      const heading = `Third-party package: ${name}@${metadata.version}`;
      assert.equal(notice.split(heading).length, 2, `${heading} must appear exactly once`);
      const section = notice.slice(notice.indexOf(heading)).split("\nThird-party package: ", 1)[0]!;
      assert.ok(section.includes(license), `${heading} must retain its entire installed LICENSE, including any appendix or additional notices`);
    });
  }

  it("ships NOTICE with the runtime image", () => {
    const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
    assert.match(dockerfile, /^COPY(?:\s+--\S+)*\s+LICENSE\s+NOTICE\s+\.\/\s*$/m);
  });
});
