import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { parse } from "yaml";
import { acquireDatabaseMaintenanceLock } from "../src/database/maintenance-lock.ts";
import { migrations } from "../src/database/migrations.ts";
import { APP_VERSION, DATABASE_COMPATIBILITY } from "../src/version.ts";

const maintenance = readFileSync(new URL("../docs/maintenance.md", import.meta.url), "utf8");
const usage = readFileSync(new URL("../USAGE.md", import.meta.url), "utf8");
const repositoryRoot = resolve(import.meta.dirname, "..");
const compose = parse(readFileSync(new URL("../docker-compose.yml", import.meta.url), "utf8")) as {
  services: Record<string, { entrypoint: string[] }>;
};

function documentedCommand(action: string) {
  const commands = [...maintenance.matchAll(/^docker compose[^\r\n]+/gm)]
    .map(([line]) => line.split(/\s+/))
    .filter((tokens) => tokens.includes(action));
  assert.equal(commands.length, 1, `expected one documented ${action} command`);
  const tokens = commands[0]!;
  const run = tokens.indexOf("run");
  assert.ok(run > 1, "maintenance examples must use docker compose run");
  let index = run + 1;
  let entrypoint: string[] | undefined;
  while (tokens[index]?.startsWith("--")) {
    const option = tokens[index++];
    if (option === "--entrypoint") {
      const executable = tokens[index++];
      assert.ok(executable);
      entrypoint = [executable];
    } else {
      assert.ok(option === "--rm" || option === "--no-deps", `unsupported example option: ${option}`);
    }
  }
  const serviceName = tokens[index++];
  assert.ok(serviceName);
  const service = compose.services[serviceName];
  assert.ok(service, `unknown compose service: ${serviceName}`);
  entrypoint ??= service.entrypoint;
  assert.ok(Array.isArray(entrypoint));
  assert.equal(entrypoint[0], "node");
  const [script, ...args] = [...entrypoint.slice(1), ...tokens.slice(index)];
  assert.ok(script);
  assert.match(script, /^dist\/(?:backup\/runner|database\/maintenance)\.js$/);
  // Execute the source counterpart of the resolved build entrypoint, without requiring a stale server build.
  return { script: resolve(repositoryRoot, script.replace(/^dist\//, "src/").replace(/\.js$/, ".ts")), args };
}

function lockDirectories(context: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "perpay-maintenance-docs-"));
  context.after(() => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(directory.includes("perpay-maintenance-docs-"));
    rmSync(directory, { recursive: true, force: true });
  });
  const data = join(directory, "data"), backups = join(directory, "backups");
  mkdirSync(data); mkdirSync(backups);
  return { data, backups, secrets: join(directory, "secrets") };
}

function inspectFromDocumentation(action: string, directories: ReturnType<typeof lockDirectories>) {
  const command = documentedCommand(action);
  assert.deepEqual(command.args, [action]);
  const result = spawnSync(process.execPath, [command.script, ...command.args], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      PERPAY_DATA_DIR: directories.data,
      PERPAY_BACKUP_DIR: directories.backups,
      PERPAY_SECRETS_DIR: directories.secrets,
      PERPAY_MASTER_KEY: "invalid-for-lock-inspection-test",
    },
    encoding: "utf8", windowsHide: true, timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

describe("maintenance documentation version contract", () => {
  it("keeps the current release notes and maintenance version aligned with the build", () => {
    const notes = readFileSync(new URL(`../docs/releases/v${APP_VERSION}.md`, import.meta.url), "utf8");
    assert.ok(notes.includes(`# PerPay ${APP_VERSION}`));
    const current = readFileSync(new URL("../docs/releases/unreleased.md", import.meta.url), "utf8");
    assert.ok(current.includes(APP_VERSION));
    assert.ok(current.includes(`(v${APP_VERSION}.md)`));
    assert.ok(maintenance.includes("当前源码版本为 `" + APP_VERSION + "`"));
    assert.ok(notes.includes(`ghcr.io/mashiro0619/perpay:${APP_VERSION}`));
    // Compatibility details live in the maintenance guide linked by release notes.
    // The migration catalog and supported range are checked below.
    assert.ok(notes.includes(`https://github.com/Mashiro0619/PerPay/blob/v${APP_VERSION}/docs/maintenance.md#固定版本与回滚`));
    assert.doesNotMatch(notes, /\]\(\.\.?\//, "GitHub Release notes must not contain relative document links");
    assert.ok(notes.includes("PERPAY_MASTER_KEY"));
    assert.ok(maintenance.includes("docker compose stop app backup"));
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
    assert.ok(usage.includes("POST /api/admin/v1/sites"));
    assert.ok(usage.includes("PUT /api/admin/v1/sites/:clientId"));
    assert.ok(usage.includes("POST /api/admin/v1/sites/:clientId/secrets/webhook_secret/actions/view"));
    assert.ok(usage.includes("PUT /api/admin/v1/settings/collection-policy"));
    assert.ok(usage.includes("系统设置 → 查账设置"));
    assert.ok(usage.includes("最小间隔 ≤ 活跃间隔 ≤ 常规间隔"));
    assert.equal(usage.includes("PUT /api/admin/v1/settings/notifications"), false);
    assert.equal(usage.includes("实例设置 → 支付宝接入 → 账单采集"), false);
  });

  it("runs the documented database lock inspection through the configured entrypoint", (context) => {
    const directories = lockDirectories(context);
    const lock = acquireDatabaseMaintenanceLock(join(directories.data, "perpay.sqlite3"), "interrupted-admin-recovery", Date.now());
    try {
      const before = readFileSync(lock.path);
      const output = inspectFromDocumentation("inspect-maintenance-lock", directories);
      assert.equal(output.token, lock.token);
      assert.equal(output.operation, "interrupted-admin-recovery");
      assert.equal(typeof output.createdAt, "string");
      assert.deepEqual(readFileSync(lock.path), before);
      assert.equal(documentedCommand("clear-stale-maintenance-lock").script,
        documentedCommand("inspect-maintenance-lock").script);
    } finally { lock.release(); }
  });

  it("matches the documented publication eligibility field to the configured CLI output", (context) => {
    const directories = lockDirectories(context);
    const lock = acquireDatabaseMaintenanceLock(join(directories.backups, ".perpay-source-publication"), "interrupted-backup", Date.now() - 8 * 60 * 60 * 1000);
    try {
      const before = readFileSync(lock.path);
      const output = inspectFromDocumentation("inspect-publication-lock", directories);
      assert.equal(output.status, "stale");
      assert.equal((output.record as Record<string, unknown>).token, lock.token);
      assert.equal(output.cleanup_eligible, true);
      const publicationSection = maintenance.split("### 备份发布锁")[1]?.split(/^## /m)[0];
      assert.ok(publicationSection);
      const field = /`(cleanup(?:_[a-z]+|[A-Z][A-Za-z]*)): true`/.exec(publicationSection)?.[1];
      assert.ok(field, "publication cleanup must name its required CLI eligibility field");
      assert.equal(output[field], true, `documented eligibility field ${field} is missing from the CLI output`);
      assert.deepEqual(readFileSync(lock.path), before);
      assert.equal(documentedCommand("clear-stale-publication-lock").script,
        documentedCommand("inspect-publication-lock").script);
    } finally { lock.release(); }
  });
});
