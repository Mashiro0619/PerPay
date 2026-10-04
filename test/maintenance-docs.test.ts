import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { migrations } from "../src/database/migrations.ts";
import { APP_VERSION, DATABASE_COMPATIBILITY } from "../src/version.ts";

const maintenance = readFileSync(new URL("../docs/maintenance.md", import.meta.url), "utf8");
const usage = readFileSync(new URL("../USAGE.md", import.meta.url), "utf8");

describe("maintenance documentation version contract", () => {
  it("keeps the current release notes and maintenance version aligned with the build", () => {
    const notes = readFileSync(new URL(`../docs/releases/v${APP_VERSION}.md`, import.meta.url), "utf8");
    assert.ok(notes.includes(`# PerPay ${APP_VERSION}`));
    const current = readFileSync(new URL("../docs/releases/unreleased.md", import.meta.url), "utf8");
    assert.ok(current.includes(APP_VERSION));
    assert.ok(current.includes(`最新数据库 schema 为 **${DATABASE_COMPATIBILITY.maximum}**`));
    assert.ok(current.includes(`运行兼容范围为 **${DATABASE_COMPATIBILITY.minimum}—${DATABASE_COMPATIBILITY.maximum}**`));
    assert.ok(maintenance.includes("基于 `" + APP_VERSION + "`"));
    assert.ok(current.includes(`迁移 24—${DATABASE_COMPATIBILITY.maximum}`));
    assert.ok(current.includes(`迁移 27—${DATABASE_COMPATIBILITY.maximum}`));
    assert.ok(current.includes(`不能将 schema ${DATABASE_COMPATIBILITY.maximum} 数据库`));
  });

  it("documents the current migration catalog and runtime compatibility rather than an old release", () => {
    const latest = Math.max(...migrations.map((migration) => migration.version));
    const documented = /最新数据库 schema 为 (\d+)，运行兼容范围为 (\d+)—(\d+)/.exec(maintenance);
    assert.ok(documented, "maintenance must state the current schema and runtime compatibility");
    assert.equal(Number(documented[1]), latest);
    assert.equal(Number(documented[2]), DATABASE_COMPATIBILITY.minimum);
    assert.equal(Number(documented[3]), DATABASE_COMPATIBILITY.maximum);
    assert.equal(latest, DATABASE_COMPATIBILITY.maximum);
  });

  it("keeps the integration guide's schema reference aligned with the upgrade guide", () => {
    const documented = /当前最新 schema 为 (\d+)/.exec(usage);
    assert.ok(documented);
    assert.equal(Number(documented[1]), DATABASE_COMPATIBILITY.maximum);
    assert.ok(usage.includes("docs/maintenance.md#固定版本与回滚"));
  });
});
