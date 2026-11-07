import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { DATABASE_COMPATIBILITY } from "../src/version.ts";

const source = readFileSync(new URL("../scripts/validation/run-linux-validation.mjs", import.meta.url), "utf8");

async function runPhase(phase, maximum) {
  // Execute the runner's actual orchestration without starting its Docker CLI.
  // The fake fixture rejects a schema flag that does not match its image, just
  // as upgrade-fixture does before reading the isolated database.
  const start = source.indexOf("async function upgrade() {");
  const end = source.indexOf("async function recovery(", start);
  assert.ok(start >= 0 && end > start, "upgrade and storage phases must remain inspectable");
  const schemaDeclaration = source.match(/^const candidateSchema = .+;$/m)?.[0] ?? "";
  const calls = [];
  const report = { images: { rc1: { id: "rc1" }, candidate: { id: "candidate" } } };
  const context = {
    DATABASE_COMPATIBILITY: { ...DATABASE_COMPATIBILITY, maximum },
    report,
    group: async name => ({ name, data: name + "-data", backups: name + "-backups", state: name + "-state", secrets: name + "-secrets" }),
    fixture: async (image, volumes, label, ...args) => {
      if (args[0] === "verify") assert.equal(args.find(value => value.startsWith("--schema=")),
        `--schema=${image === "rc1" ? 38 : maximum}`, "verification image schema mismatch");
      calls.push({ kind: "fixture", image, label, args });
      return { ok: true };
    },
    backup: async (image, volumes, label) => {
      calls.push({ kind: "backup", image, label });
      return { label, schema: image === "rc1" ? 38 : maximum };
    },
    restore: async (image, volumes, label, saved) => { calls.push({ kind: "restore", image, label, schema: saved.schema }); },
    application: async (image, volumes, label, checkpoint) => { calls.push({ kind: "application", image, label, checkpoint }); },
  };
  runInNewContext(`${schemaDeclaration}\n${source.slice(start, end)}\nglobalThis.runPhase = ${phase};`, context);
  await context.runPhase();
  return { calls, report };
}

test("upgrade verifies the declared candidate schema before and after restore while keeping the exact RC1 baseline", async () => {
  for (const maximum of [DATABASE_COMPATIBILITY.maximum, DATABASE_COMPATIBILITY.maximum + 1]) {
    const { calls, report } = await runPhase("upgrade", maximum);
    const verifies = calls.filter(call => call.kind === "fixture" && call.args[0] === "verify");
    assert.deepEqual(verifies.map(call => [call.image, call.args.find(value => value.startsWith("--schema="))]),
      [["rc1", "--schema=38"], ["candidate", `--schema=${maximum}`], ["candidate", `--schema=${maximum}`], ["rc1", "--schema=38"]]);
    assert.deepEqual(calls.filter(call => call.kind === "restore").map(call => call.schema), [maximum, 38]);
    assert.equal(report.backups.beforeUpgrade.schema, 38);
    assert.equal(report.backups.afterUpgrade.schema, maximum);
    assert.ok(calls.some(call => call.kind === "application" && call.image === "rc1" && call.checkpoint === "base"));
    assert.ok(calls.some(call => call.label === `verify-restored${maximum}`));
  }
});

test("storage validates and restores the declared candidate schema without changing the historical data seed", async () => {
  for (const maximum of [DATABASE_COMPATIBILITY.maximum, DATABASE_COMPATIBILITY.maximum + 1]) {
    const { calls, report } = await runPhase("storage", maximum);
    assert.deepEqual(calls[0], { kind: "fixture", image: "rc1", label: "rc1-storage-seed", args: ["seed", "--storage-history"] });
    const verifies = calls.filter(call => call.kind === "fixture" && call.args[0] === "verify");
    assert.deepEqual(verifies.map(call => call.args.find(value => value.startsWith("--schema="))), [`--schema=${maximum}`, `--schema=${maximum}`]);
    assert.ok(verifies.every(call => call.image === "candidate" && call.args.includes("--checkpoint=base")));
    assert.equal(calls.find(call => call.kind === "restore").schema, maximum);
    assert.equal(report.backups.storage.schema, maximum);
    assert.ok(calls.some(call => call.label === `storage-restored${maximum}`));
  }
});
