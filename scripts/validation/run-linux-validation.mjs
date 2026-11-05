// SPDX-License-Identifier: MIT
// Runs only disposable, labelled Docker resources. Images must already be built.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const scripts = dirname(fileURLToPath(import.meta.url));
const owner = "perpay-linux-upgrade-validation";
const scenarios = ["payment-before-commit", "payment-after-commit", "webhook-after-claim", "webhook-before-ack-commit",
  "spool-after-publish", "spool-before-import-commit", "spool-after-import-commit"];
const options = Object.fromEntries(process.argv.slice(2).map(argument => {
  const match = /^--([a-z][a-z0-9-]*)=(.+)$/.exec(argument);
  assert.ok(match, "Use --name=value options"); return [match[1], match[2]];
}));
for (const key of Object.keys(options)) assert.ok(["rc1-image", "candidate-image", "output", "phase", "scenarios"].includes(key), "Unknown option");
const phase = options.phase ?? "all";
assert.ok(["all", "upgrade", "recovery"].includes(phase), "Unknown phase");
const selectedScenarios = options.scenarios?.split(",") ?? scenarios;
assert.ok(selectedScenarios.length && selectedScenarios.every(value => scenarios.includes(value)), "Unknown scenario");
assert.ok(options["candidate-image"] && (phase === "recovery" || options["rc1-image"]), "Provide prebuilt image names");
const runId = "perpay-validation-" + new Date().toISOString().replace(/\D/g, "").slice(0, 14) + "-" + randomUUID().slice(0, 8);
const output = resolve(options.output ?? ".scratch/linux-validation", runId);
mkdirSync(output, { recursive: true });
const masterKey = randomBytes(32).toString("hex");
const environment = { ...process.env, PERPAY_MASTER_KEY: masterKey, PERPAY_UPGRADE_ISOLATED: "1", PERPAY_UPGRADE_RUN_ID: runId };
const resources = { owner, runId, containers: [], volumes: [] };
const report = { owner, runId, phase, platform: "linux", startedAt: new Date().toISOString(), images: {}, checks: [] };
writeFileSync(resolve(output, "private-run.json"), JSON.stringify({ masterKey, runId }) + "\n", { mode: 0o600, flag: "wx" });
const persist = () => writeFileSync(resolve(output, "resources.json"), JSON.stringify(resources, null, 2) + "\n");
const log = (event, data = {}) => process.stdout.write(JSON.stringify({ event, runId, ...data }) + "\n");

async function docker(arguments_, { allowedFailure = false, timeout = 180_000 } = {}) {
  const child = spawn("docker", arguments_, { env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
  const timer = setTimeout(() => child.kill(), timeout);
  const code = await new Promise((done, reject) => { child.once("error", reject); child.once("close", done); }).finally(() => clearTimeout(timer));
  if (code !== 0 && !allowedFailure) {
    // Fixture failures must never dump private configuration or command environment.
    writeFileSync(resolve(output, "last-command-error.log"), stderr + "\n" + stdout, { mode: 0o600 });
    throw new Error(`Docker ${arguments_[0]} failed (${code}); inspect private local log`);
  }
  return { code, stdout, stderr };
}
function lastJson(stdout) {
  const values = stdout.trim().split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  assert.ok(values.length, "Command did not produce JSON evidence"); return values.at(-1);
}
async function image(name, expectedVersion) {
  const data = JSON.parse((await docker(["image", "inspect", name])).stdout)[0];
  assert.equal(data.Os, "linux"); assert.equal(data.Architecture, "amd64");
  assert.equal(data.Config.Labels?.["org.opencontainers.image.version"], expectedVersion);
  assert.match(data.Config.Labels?.["org.opencontainers.image.revision"] ?? "", /^[a-f0-9]{40}$/);
  return { id: data.Id, version: expectedVersion, revision: data.Config.Labels["org.opencontainers.image.revision"], architecture: data.Architecture };
}
const labels = ["--label", `com.perpay.validation.owner=${owner}`, "--label", `com.perpay.validation.run=${runId}`];
async function group(suffix, scenario) {
  assert.match(suffix, /^[a-z0-9-]+$/);
  const volumes = {};
  for (const role of ["data", "backups", "secrets", "state"]) {
    const name = `${runId}-${suffix}-${role}`;
    assert.notEqual((await docker(["volume", "inspect", name], { allowedFailure: true })).code, 0, "Refusing existing volume");
    await docker(["volume", "create", ...labels, name]);
    volumes[role] = name; resources.volumes.push(name); persist();
  }
  const marker = { kind: owner, run_id: runId, data_dir: "/data", backup_dir: "/backups", ...(scenario ? { scenario } : {}) };
  await run(report.images.candidate.id, volumes, `initialize-${suffix}`, ["node", "-e", `
    const fs = require('node:fs');
    const paths = ['/data','/backups','/run/perpay-secrets','/validation-state'];
    for (const path of paths) { fs.mkdirSync(path, {recursive:true}); fs.chmodSync(path, 0o700); }
    fs.writeFileSync('/validation-state/isolation.json', ${JSON.stringify(JSON.stringify(marker))}, {flag:'wx',mode:0o600});
    fs.chownSync('/validation-state/isolation.json',1000,1000);
    for (const path of paths) fs.chownSync(path,1000,1000);
  `], { initialize: true });
  return volumes;
}
function mounts(volumes, role) {
  const args = ["--mount", `type=volume,source=${volumes.data},target=/data${role === "backup" ? ",readonly" : ""}`,
    "--mount", `type=volume,source=${volumes.backups},target=/backups${role === "app" ? ",readonly" : ""}`];
  if (role !== "backup") args.push("--mount", `type=volume,source=${volumes.secrets},target=/run/perpay-secrets${role === "maintenance" ? ",readonly" : ""}`);
  if (["fixture", "app"].includes(role)) args.push("--mount", `type=volume,source=${volumes.state},target=/validation-state${role === "app" ? ",readonly" : ""}`,
    "--mount", `type=bind,source=${scripts},target=/validation,readonly`);
  return args;
}
async function run(imageId, volumes, suffix, command, { initialize = false, detached = false, role = "fixture" } = {}) {
  const name = `${runId}-${suffix}`;
  assert.ok(!resources.containers.includes(name), "Container names must be unique within this run");
  assert.notEqual((await docker(["container", "inspect", name], { allowedFailure: true })).code, 0, "Refusing existing container");
  const args = ["run", "--pull=never", "--name", name, ...labels, "--network", "none", "--read-only", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges:true", "--user", initialize ? "0:0" : "1000:1000", "--init",
    "--tmpfs", "/tmp:rw,size=64m,mode=1777", ...mounts(volumes, role),
    "--env", "PERPAY_DATA_DIR=/data", "--env", "PERPAY_BACKUP_DIR=/backups",
    "--env", "PERPAY_PUBLIC_URL=http://127.0.0.1:6190", "--env", "PERPAY_SETUP_TOKEN_ENABLED=false"];
  if (role !== "backup") args.push("--env", "PERPAY_MASTER_KEY", "--env", "PERPAY_SECRETS_DIR=/run/perpay-secrets");
  if (["fixture", "app"].includes(role)) args.push("--env", "PERPAY_UPGRADE_ISOLATED", "--env", "PERPAY_UPGRADE_RUN_ID");
  if (initialize) args.push("--cap-add", "CHOWN", "--cap-add", "FOWNER");
  if (detached) args.push("--detach");
  resources.containers.push(name); persist();
  const result = await docker([...args, imageId, ...command]);
  const inspected = JSON.parse((await docker(["inspect", name])).stdout)[0];
  assert.equal(inspected.HostConfig.NetworkMode, "none");
  assert.equal(inspected.HostConfig.ReadonlyRootfs, true);
  assert.equal(inspected.Config.User, initialize ? "0:0" : "1000:1000");
  assert.ok(inspected.HostConfig.CapDrop.includes("ALL"));
  const mounted = destination => inspected.Mounts.find(item => item.Destination === destination);
  if (role === "app") assert.equal(mounted("/backups").RW, false);
  if (role === "backup") {
    assert.equal(mounted("/data").RW, false);
    // The image declares VOLUME /run/perpay-secrets; avoid giving the backup role
    // the application's secret volume or key even if Docker creates an empty one.
    assert.notEqual(mounted("/run/perpay-secrets")?.Name, volumes.secrets);
    assert.equal(inspected.Config.Env.some(value => value.startsWith("PERPAY_MASTER_KEY=")), false);
  }
  if (role === "maintenance") assert.equal(mounted("/run/perpay-secrets").RW, false);
  report.roleIsolation ??= {};
  report.roleIsolation[initialize ? "initializer" : role] = { network: "none", readOnlyRoot: true, user: inspected.Config.User,
    capDrop: inspected.HostConfig.CapDrop, capAdd: inspected.HostConfig.CapAdd,
    mounts: inspected.Mounts.map(item => ({ destination: item.Destination, writable: item.RW, type: item.Type })) };
  if (!detached) writeFileSync(resolve(output, `${suffix}.log`), result.stdout + result.stderr, { mode: 0o600 });
  return { ...result, name };
}
async function fixture(imageId, volumes, label, ...arguments_) {
  log("check_started", { check: label });
  const result = lastJson((await run(imageId, volumes, label, ["node", "/validation/upgrade-fixture.mjs", ...arguments_])).stdout);
  assert.equal(result.ok, true); report.checks.push({ check: label, ...result });
  log("check_passed", { check: label }); return result;
}
async function backup(imageId, volumes, label) {
  // Compose runs its read-only backup beside the application. Keep the image's
  // real writer connection open so WAL/SHM exist, without advancing background
  // jobs before the exact migration snapshot has been checked.
  const writer = await run(imageId, volumes, `${label}-writer`, ["node", "/validation/database-writer.mjs"], { detached: true });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      const logs = await docker(["logs", writer.name]);
      if (logs.stdout.includes('"event":"validation_writer_ready"')) { ready = true; break; }
      const state = lastJson((await docker(["inspect", "--format", "{{json .State}}", writer.name])).stdout);
      assert.equal(state.Running, true, "Backup writer exited before becoming ready");
      await delay(250);
    }
    assert.ok(ready, "Backup writer did not become ready");
    const result = lastJson((await run(imageId, volumes, label, ["node", "dist/backup/runner.js", "run-once"], { role: "backup" })).stdout);
    assert.ok(result.backup?.name); assert.match(result.backup.sha256, /^[a-f0-9]{64}$/);
    return result.backup;
  } finally { await docker(["stop", "--time", "45", writer.name]); }
}
async function restore(imageId, volumes, label, saved) {
  await run(imageId, volumes, label, ["node", "dist/backup/runner.js", "restore", saved.name, saved.sha256, "--confirm-replace-current-database"], { role: "maintenance" });
}
async function application(imageId, volumes, label, checkpoint) {
  const process_ = await run(imageId, volumes, `${label}-app`, ["node", "dist/main.js"], { detached: true, role: "app" });
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    const status = await docker(["exec", process_.name, "node", "-e", "fetch('http://127.0.0.1:6190/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"], { allowedFailure: true, timeout: 5000 });
    if (status.code === 0) { ready = true; break; }
    const state = lastJson((await docker(["inspect", "--format", "{{json .State}}", process_.name])).stdout);
    assert.equal(state.Running, true, "Application stopped before becoming healthy");
    await delay(500);
  }
  assert.ok(ready, "Application did not become healthy");
  const http = await docker(["exec", process_.name, "node", "/validation/upgrade-fixture.mjs", "http-verify", `--checkpoint=${checkpoint}`]);
  const evidence = lastJson(http.stdout); assert.equal(evidence.ok, true);
  report.checks.push({ check: `${label}-http`, ...evidence });
  await docker(["stop", "--time", "45", process_.name]);
  log("check_passed", { check: `${label}-http` });
}
async function upgrade() {
  const volumes = await group("upgrade");
  const rc1 = report.images.rc1.id, candidate = report.images.candidate.id;
  await fixture(rc1, volumes, "rc1-seed", "seed");
  await fixture(rc1, volumes, "rc1-baseline", "verify", "--schema=38", "--checkpoint=base", "--label=rc1-baseline");
  const before = await backup(rc1, volumes, "backup-schema38");
  // Validate unchanged rows before starting workers that may legitimately advance them.
  await fixture(candidate, volumes, "upgrade-schema39", "verify", "--schema=39", "--checkpoint=base", "--label=upgraded");
  await fixture(candidate, volumes, "new-schema39-business", "advance");
  const current = await backup(candidate, volumes, "backup-schema39");
  report.backups = { beforeUpgrade: before, afterUpgrade: current };
  await application(candidate, volumes, "candidate", "upgraded");
  // Preserve the upgraded snapshot independently before testing the old-version recovery.
  const recovered = await group("restore39");
  recovered.backups = volumes.backups; recovered.state = volumes.state; recovered.secrets = volumes.secrets;
  await restore(candidate, recovered, "restore-schema39", current);
  await fixture(candidate, recovered, "verify-restored39", "verify", "--schema=39", "--label=restored39", "--checkpoint=upgraded");
  await application(candidate, recovered, "restored39", "upgraded");
  await restore(candidate, volumes, "restore-schema38", before);
  await fixture(rc1, volumes, "verify-restored38", "verify", "--schema=38", "--checkpoint=base", "--label=restored38");
  await application(rc1, volumes, "restored38", "base");
}
async function recovery(scenario) {
  log("scenario_started", { scenario });
  const volumes = await group(scenario, scenario), candidate = report.images.candidate.id;
  await run(candidate, volumes, `${scenario}-prepare`, ["node", "/validation/recovery-fixture.mjs", "prepare", scenario]);
  const crashing = await run(candidate, volumes, `${scenario}-crash`, ["node", "/validation/recovery-fixture.mjs", "crash", scenario], { detached: true });
  let boundary;
  for (let attempt = 0; attempt < 120; attempt++) {
    const logs = await docker(["logs", crashing.name]);
    for (const line of logs.stdout.split(/\r?\n/)) {
      try { const item = JSON.parse(line); if (item.event === "recovery_boundary_ready") boundary = item; } catch { /* non-JSON runtime logs */ }
    }
    if (boundary) break;
    const state = lastJson((await docker(["inspect", "--format", "{{json .State}}", crashing.name])).stdout);
    assert.equal(state.Running, true, "Recovery worker exited before its durable boundary");
    await delay(500);
  }
  assert.ok(boundary, "Recovery worker did not reach its boundary"); assert.equal(boundary.scenario, scenario);
  await docker(["kill", "--signal", "KILL", crashing.name]);
  const state = lastJson((await docker(["inspect", "--format", "{{json .State}}", crashing.name])).stdout);
  assert.equal(state.ExitCode, 137, "The interrupted container must have died from SIGKILL");
  log("boundary_killed", { scenario, exitCode: state.ExitCode });
  const verified = await run(candidate, volumes, `${scenario}-verify`, ["node", "/validation/recovery-fixture.mjs", "verify", scenario]);
  const evidence = lastJson(verified.stdout); assert.equal(evidence.execution_platform, "linux");
  assert.equal(evidence.event, "recovery_verified");
  report.checks.push({ check: scenario, boundary, killedExitCode: state.ExitCode, result: evidence });
  log("scenario_passed", { scenario });
}
async function cleanup() {
  for (const [kind, names] of [["container", resources.containers], ["volume", resources.volumes]]) {
    for (const name of names) {
      assert.ok(name.startsWith(runId + "-"));
      const inspected = await docker([kind, "inspect", name], { allowedFailure: true });
      if (inspected.code !== 0) {
        assert.match(inspected.stderr, /No such (?:container|volume|object)/i, "Cannot confirm resource ownership for cleanup");
        continue;
      }
      const data = JSON.parse(inspected.stdout)[0], resourceLabels = kind === "container" ? data.Config.Labels : data.Labels;
      assert.equal(resourceLabels?.["com.perpay.validation.owner"], owner);
      assert.equal(resourceLabels?.["com.perpay.validation.run"], runId);
      await docker(kind === "container" ? ["container", "rm", "--force", "--volumes", name] : ["volume", "rm", name]);
    }
  }
}

try {
  const engine = lastJson((await docker(["info", "--format", "{{json .}}"])).stdout);
  assert.equal(engine.OSType, "linux"); report.engine = { version: engine.ServerVersion, architecture: engine.Architecture };
  report.images.candidate = await image(options["candidate-image"], "1.0.0-rc.2");
  if (phase !== "recovery") report.images.rc1 = await image(options["rc1-image"], "1.0.0-rc.1");
  log("run_started", { phase, output });
  if (phase !== "recovery") await upgrade();
  if (phase !== "upgrade") for (const scenario of selectedScenarios) await recovery(scenario);
  await cleanup(); report.cleanedUp = true; report.ok = true; report.finishedAt = new Date().toISOString();
  writeFileSync(resolve(output, "result.json"), JSON.stringify(report, null, 2) + "\n");
  log("run_passed", { result: resolve(output, "result.json") });
} catch (error) {
  report.ok = false; report.error = error instanceof Error ? error.message : "Validation failed";
  writeFileSync(resolve(output, "result.json"), JSON.stringify(report, null, 2) + "\n");
  log("run_failed_resources_retained", { error: report.error, resources: resolve(output, "resources.json") });
  process.exitCode = 1;
}
