import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ActivityRecorder } from "../src/audit/activity.ts";
import { loadConfig } from "../src/config.ts";
import { createApp } from "../src/http/app.ts";
import { MaintenanceController } from "../src/maintenance/controller.ts";
import { SelfUpdateService, type UpdaterClient } from "../src/update/self-update.ts";
import { createUpdaterServer, ensureUpdaterToken, UpdaterOrchestrator, type UpdateExecutionJob, type UpdaterApplyRequest } from "../src/update/updater-core.ts";
import { DockerClient } from "../src/update/docker-client.ts";
import { createConfiguredHttpServices, HTTP_TEST_ADMIN_PASSWORD } from "./http-fixture.ts";

const ORIGIN = "http://localhost:6190";

async function login(app: ReturnType<typeof createApp>) {
  const response = await app.request(`${ORIGIN}/api/admin/v1/session/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ password: HTTP_TEST_ADMIN_PASSWORD }),
  });
  assert.equal(response.status, 200);
  const cookies = response.headers.getSetCookie().map(item => item.split(";")[0]!);
  const csrfCookie = cookies.find(item => item.startsWith("perpay_csrf="));
  assert.ok(csrfCookie);
  const csrf = decodeURIComponent(csrfCookie.slice("perpay_csrf=".length));
  return { cookie: cookies.join("; "), csrf };
}

function makeFixtureDirectory(): string {
  return mkdtempSync(join(tmpdir(), "perpay-self-update-http-"));
}

describe("self-update configuration and HTTP orchestration", () => {
  it("validates PERPAY_UPDATER_URL and token settings in loadConfig", (context) => {
    const dir = makeFixtureDirectory();
    context.after(() => rmSync(dir, { recursive: true, force: true }));
    const baseEnv = {
      PERPAY_MASTER_KEY: "0123456789abcdef".repeat(4),
      PERPAY_DATA_DIR: join(dir, "data"),
      PERPAY_BACKUP_DIR: join(dir, "backups"),
      PERPAY_PUBLIC_URL: ORIGIN,
    };

    assert.equal(loadConfig(baseEnv).updater, undefined);

    const configured = loadConfig({
      ...baseEnv,
      PERPAY_UPDATER_URL: "http://updater:6199",
      PERPAY_UPDATER_TOKEN_FILE: join(dir, "token"),
    });
    assert.equal(configured.updater?.url, "http://updater:6199");
    assert.equal(configured.updater?.token, null);
    assert.equal(configured.updater?.tokenFile, join(dir, "token"));

    assert.throws(() => loadConfig({ ...baseEnv, PERPAY_UPDATER_URL: "https://updater:6199", PERPAY_UPDATER_TOKEN: "a".repeat(64) }));
    assert.throws(() => loadConfig({ ...baseEnv, PERPAY_UPDATER_URL: "http://updater:6199/extra", PERPAY_UPDATER_TOKEN: "a".repeat(64) }));
    assert.throws(() => loadConfig({ ...baseEnv, PERPAY_UPDATER_URL: "http://updater:6199" }));
    assert.throws(() => loadConfig({ ...baseEnv, PERPAY_UPDATER_URL: "http://updater:6199", PERPAY_UPDATER_TOKEN: "weak-short-token" }));
    const strongToken = loadConfig({ ...baseEnv, PERPAY_UPDATER_URL: "http://updater:6199", PERPAY_UPDATER_TOKEN: "a".repeat(64) });
    assert.equal(strongToken.updater?.token, "a".repeat(64));
  });

  it("reports not_configured and demo_read_only states cleanly and enforces auth/CSRF", async (context) => {
    const dir = makeFixtureDirectory();
    const services = await createConfiguredHttpServices({
      directory: dir,
      apiSecret: null,
      collectionCodePayload: "https://qr.alipay.com/self-update-http",
    });
    context.after(() => {
      services.database.close();
      rmSync(dir, { recursive: true, force: true });
    });

    const app = createApp({ ...services, startedAt: new Date() });

    // Unauthenticated rejected
    assert.equal((await app.request(`${ORIGIN}/api/admin/v1/system/update/status`)).status, 401);

    const auth = await login(app);

    // Default config without updater -> enabled: false, not_configured
    const statusRes = await app.request(`${ORIGIN}/api/admin/v1/system/update/status`, {
      headers: { cookie: auth.cookie },
    });
    assert.equal(statusRes.status, 200);
    const statusJson = await statusRes.json() as { data: { enabled: boolean; unavailable_reason: string | null; can_backup: boolean } };
    assert.equal(statusJson.data.enabled, false);
    assert.equal(statusJson.data.unavailable_reason, "not_configured");
    assert.equal(statusJson.data.can_backup, false);

    // Missing CSRF on POST /apply -> 403
    const noCsrf = await app.request(`${ORIGIN}/api/admin/v1/system/update/apply`, {
      method: "POST",
      headers: { cookie: auth.cookie, origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ operation_id: randomUUID(), target_version: "9.9.9" }),
    });
    assert.equal(noCsrf.status, 403);

    // Demo mode -> demo_read_only
    const demoApp = createApp({ ...services, startedAt: new Date(), demoMode: true });
    const demoStatus = await demoApp.request(`${ORIGIN}/api/admin/v1/system/update/status`, {
      headers: { cookie: auth.cookie },
    });
    assert.equal(demoStatus.status, 200);
    assert.equal(((await demoStatus.json()) as { data: { unavailable_reason: string } }).data.unavailable_reason, "demo_read_only");

    const demoApply = await demoApp.request(`${ORIGIN}/api/admin/v1/system/update/apply`, {
      method: "POST",
      headers: { cookie: auth.cookie, origin: ORIGIN, "x-csrf-token": auth.csrf, "content-type": "application/json" },
      body: JSON.stringify({ operation_id: randomUUID(), target_version: "9.9.9" }),
    });
    assert.equal(demoApply.status, 403);
  });

  it("aborts upgrade before calling updater when pre-upgrade database backup fails", async (context) => {
    const dir = makeFixtureDirectory();
    const services = await createConfiguredHttpServices({
      directory: dir,
      apiSecret: null,
      collectionCodePayload: "https://qr.alipay.com/self-update-backup-fail",
    });
    context.after(() => {
      services.database.close();
      rmSync(dir, { recursive: true, force: true });
    });

    let updaterApplyCalls = 0;
    const mockClient: UpdaterClient = {
      status: async () => ({ active: null, latest: null }),
      apply: async () => {
        updaterApplyCalls += 1;
        throw new Error("should not be called");
      },
    };
    const maintenance = new MaintenanceController({
      pause: async () => {},
      resume: async () => {},
      run: async () => { throw new Error("disk full during backup"); },
    });
    const selfUpdate = new SelfUpdateService({
      updaterClient: mockClient,
      maintenance,
      currentVersion: "1.0.0-rc.5",
    });
    const app = createApp({ ...services, maintenance, selfUpdate, startedAt: new Date() });
    const auth = await login(app);

    const applyRes = await app.request(`${ORIGIN}/api/admin/v1/system/update/apply`, {
      method: "POST",
      headers: { cookie: auth.cookie, origin: ORIGIN, "x-csrf-token": auth.csrf, "content-type": "application/json" },
      body: JSON.stringify({ operation_id: randomUUID(), target_version: "1.0.0", create_backup: true }),
    });
    assert.equal(applyRes.status, 202);
    const started = await applyRes.json() as { data: UpdateExecutionJob };
    assert.equal(started.data.stage, "backing_up");

    await selfUpdate.settled();
    assert.equal(updaterApplyCalls, 0);

    const statusRes = await app.request(`${ORIGIN}/api/admin/v1/system/update/status`, {
      headers: { cookie: auth.cookie },
    });
    const statusData = (await statusRes.json() as { data: { active_job: UpdateExecutionJob | null; latest_job: UpdateExecutionJob | null } }).data;
    assert.equal(statusData.active_job, null);
    assert.equal(statusData.latest_job?.status, "FAILED");
    assert.match(statusData.latest_job?.error ?? "", /disk full during backup/u);
  });

  it("runs pre-upgrade backup, hands off to updater with backup_name, rejects downgrades, and logs audit activity", async (context) => {
    const dir = makeFixtureDirectory();
    const services = await createConfiguredHttpServices({
      directory: dir,
      apiSecret: null,
      collectionCodePayload: "https://qr.alipay.com/self-update-happy",
    });
    const activity = new ActivityRecorder({ database: services.database });
    context.after(() => {
      activity.stop();
      services.database.close();
      rmSync(dir, { recursive: true, force: true });
    });

    const handedOffRequests: UpdaterApplyRequest[] = [];
    let remoteJob: UpdateExecutionJob | null = null;
    const mockClient: UpdaterClient = {
      status: async () => ({ active: remoteJob, latest: remoteJob }),
      apply: async (request) => {
        handedOffRequests.push(request);
        remoteJob = {
          id: request.operation_id,
          target_version: request.target_version,
          previous_version: request.previous_version,
          status: "RUNNING",
          stage: "pulling",
          message: `正在拉取官方镜像…`,
          backup_name: request.backup_name ?? null,
          rolled_back: false,
          started_at: Date.now(),
          finished_at: null,
          error: null,
        };
        return remoteJob;
      },
    };
    const maintenance = new MaintenanceController({
      pause: async () => {},
      resume: async () => {},
      run: async () => ({ backup_name: "perpay-2026-11-22.sqlite3" }),
    });

    const selfUpdate = new SelfUpdateService({
      updaterClient: mockClient,
      maintenance,
      currentVersion: "1.0.0-rc.5",
    });
    const app = createApp({ ...services, activity, maintenance, selfUpdate, startedAt: new Date() });
    const auth = await login(app);

    // Reject downgrade (422)
    const downgrade = await app.request(`${ORIGIN}/api/admin/v1/system/update/apply`, {
      method: "POST",
      headers: { cookie: auth.cookie, origin: ORIGIN, "x-csrf-token": auth.csrf, "content-type": "application/json" },
      body: JSON.stringify({ operation_id: randomUUID(), target_version: "1.0.0-rc.4" }),
    });
    assert.equal(downgrade.status, 422);

    // Trigger real upgrade with backup
    const opId = randomUUID();
    const applyRes = await app.request(`${ORIGIN}/api/admin/v1/system/update/apply`, {
      method: "POST",
      headers: { cookie: auth.cookie, origin: ORIGIN, "x-csrf-token": auth.csrf, "content-type": "application/json" },
      body: JSON.stringify({ operation_id: opId, target_version: "1.0.0", create_backup: true }),
    });
    assert.equal(applyRes.status, 202);
    await selfUpdate.settled();

    assert.equal(handedOffRequests.length, 1);
    assert.equal(handedOffRequests[0]!.operation_id, opId);
    assert.equal(handedOffRequests[0]!.target_version, "1.0.0");
    assert.equal(handedOffRequests[0]!.backup_name, "perpay-2026-11-22.sqlite3");

    // Status merges remote pulling job
    const statusRes = await app.request(`${ORIGIN}/api/admin/v1/system/update/status`, {
      headers: { cookie: auth.cookie },
    });
    const statusBody = (await statusRes.json() as { data: { enabled: boolean; active_job: UpdateExecutionJob | null } }).data;
    assert.equal(statusBody.enabled, true);
    assert.equal(statusBody.active_job?.stage, "pulling");
    assert.equal(statusBody.active_job?.backup_name, "perpay-2026-11-22.sqlite3");

    // Concurrent second apply returns 409 update_in_progress
    const second = await app.request(`${ORIGIN}/api/admin/v1/system/update/apply`, {
      method: "POST",
      headers: { cookie: auth.cookie, origin: ORIGIN, "x-csrf-token": auth.csrf, "content-type": "application/json" },
      body: JSON.stringify({ operation_id: randomUUID(), target_version: "1.1.0", create_backup: false }),
    });
    assert.equal(second.status, 409);
    assert.equal(((await second.json()) as { error: { code: string } }).error.code, "update_in_progress");

    // Same operation_id replay returns existing job (idempotent)
    const replay = await app.request(`${ORIGIN}/api/admin/v1/system/update/apply`, {
      method: "POST",
      headers: { cookie: auth.cookie, origin: ORIGIN, "x-csrf-token": auth.csrf, "content-type": "application/json" },
      body: JSON.stringify({ operation_id: opId, target_version: "1.0.0", create_backup: true }),
    });
    assert.equal(replay.status, 202);
    assert.equal(((await replay.json()) as { data: UpdateExecutionJob }).data.id, opId);

    // Flush activity recorder and verify audit query retains update detail keys.
    activity.flush();
    const auditRes = await app.request(
      `${ORIGIN}/api/admin/v1/audit-events?source=activity&action=system.update_requested`,
      { headers: { cookie: auth.cookie } },
    );
    assert.equal(auditRes.status, 200);
    const auditBody = (await auditRes.json()) as {
      data: Array<{ event_id: string; source: string }>;
    };
    assert.ok(auditBody.data.length >= 1);
    const detailRes = await app.request(
      `${ORIGIN}/api/admin/v1/audit-events/${auditBody.data[0]!.source}/${encodeURIComponent(auditBody.data[0]!.event_id)}`,
      { headers: { cookie: auth.cookie } },
    );
    assert.equal(detailRes.status, 200);
    const detailBody = (await detailRes.json()) as {
      data: { details: Record<string, unknown> };
    };
    assert.deepEqual(detailBody.data.details, {
      target_version: "1.0.0",
      previous_version: "1.0.0-rc.5",
      create_backup: true,
    });
  });

  it("connects app to updater over real HTTP using a shared token file", async (context) => {
    const dir = makeFixtureDirectory();
    const tokenFile = join(dir, "updater-token");
    const token = ensureUpdaterToken(tokenFile);
    const orchestrator = new UpdaterOrchestrator({
      docker: new DockerClient({ baseUrl: "http://127.0.0.1:1" }),
      composeProject: "perpay",
    });
    const updaterServer = createUpdaterServer({ orchestrator, token });
    updaterServer.listen(0, "127.0.0.1");
    await once(updaterServer, "listening");
    const addr = updaterServer.address();
    assert.ok(addr && typeof addr === "object");

    const services = await createConfiguredHttpServices({
      directory: dir,
      apiSecret: null,
      collectionCodePayload: "https://qr.alipay.com/self-update-live-token",
      environment: {
        PERPAY_UPDATER_URL: `http://127.0.0.1:${addr.port}`,
        PERPAY_UPDATER_TOKEN_FILE: tokenFile,
      },
    });
    context.after(async () => {
      await new Promise<void>(resolve => { updaterServer.close(() => resolve()); updaterServer.closeAllConnections(); });
      services.database.close();
      rmSync(dir, { recursive: true, force: true });
    });

    const app = createApp({ ...services, startedAt: new Date() });
    const auth = await login(app);
    const statusRes = await app.request(`${ORIGIN}/api/admin/v1/system/update/status`, {
      headers: { cookie: auth.cookie },
    });
    assert.equal(statusRes.status, 200);
    const body = (await statusRes.json() as { data: { enabled: boolean; unavailable_reason: string | null } }).data;
    assert.equal(body.enabled, true);
    assert.equal(body.unavailable_reason, null);
  });

  it("blocks concurrent POST /apply calls via synchronous lock and probes updater status after handoff timeout", async () => {
    let releaseStatus!: () => void;
    let statusGate = new Promise<void>((resolve) => { releaseStatus = resolve; });
    const acceptedId = randomUUID();
    let remoteJob: UpdateExecutionJob | null = null;
    let applyAttempts = 0;

    const client: UpdaterClient = {
      status: async () => {
        await statusGate;
        return { active: remoteJob, latest: remoteJob };
      },
      apply: async (request) => {
        applyAttempts += 1;
        // Simulate updater accepting the job, then dropping the HTTP response before returning!
        remoteJob = {
          id: request.operation_id,
          target_version: request.target_version,
          previous_version: request.previous_version,
          status: "RUNNING",
          stage: "pulling",
          message: "正在拉取镜像…",
          backup_name: request.backup_name ?? null,
          rolled_back: false,
          started_at: Date.now(),
          finished_at: null,
          error: null,
        };
        throw new Error("simulated handoff timeout after acceptance");
      },
    };
    const maintenance = new MaintenanceController({
      pause: async () => {},
      resume: async () => {},
      run: async () => ({ backup_name: "perpay-race-backup.sqlite3" }),
    });
    const service = new SelfUpdateService({
      updaterClient: client,
      maintenance,
      currentVersion: "1.0.0-rc.5",
    });
    const observer = { session: { session: { username: "admin" } } } as never;

    const firstPromise = service.apply({ operation_id: acceptedId, target_version: "1.0.0", create_backup: true }, observer);
    await assert.rejects(
      () => service.apply({ operation_id: randomUUID(), target_version: "1.0.0", create_backup: false }, observer),
      /已有在线更新任务正在执行/u,
    );
    releaseStatus();
    statusGate = Promise.resolve();

    const first = await firstPromise;
    assert.equal(first.stage, "backing_up");
    await service.settled();
    assert.equal(applyAttempts, 1);

    // Even though client.apply threw after acceptance, probing client.status() recovered the running remote job!
    const afterStatus = await service.status();
    assert.equal(afterStatus.active_job?.id, acceptedId);
    assert.equal(afterStatus.active_job?.stage, "pulling");
  });

  it("enforces bidirectional mutual exclusion between online updates and maintenance jobs including during image pull", async (context) => {
    const dir = makeFixtureDirectory();
    const services = await createConfiguredHttpServices({
      directory: dir,
      apiSecret: null,
      collectionCodePayload: "https://qr.alipay.com/self-update-mutex",
    });
    context.after(() => {
      services.database.close();
      rmSync(dir, { recursive: true, force: true });
    });

    let remoteActive: UpdateExecutionJob | null = null;
    let statusShouldFail = false;
    let releaseRemoteStatusGate: (() => void) | null = null;
    let remoteStatusGate: Promise<void> | null = null;

    const client: UpdaterClient = {
      status: async () => {
        if (remoteStatusGate) await remoteStatusGate;
        if (statusShouldFail) throw new Error("updater temporarily unreachable");
        return { active: remoteActive, latest: remoteActive };
      },
      apply: async (request) => {
        remoteActive = {
          id: request.operation_id,
          target_version: request.target_version,
          previous_version: request.previous_version,
          status: "RUNNING",
          stage: "pulling",
          message: "正在拉取官方镜像…",
          backup_name: request.backup_name ?? null,
          rolled_back: false,
          started_at: Date.now(),
          finished_at: null,
          error: null,
        };
        return remoteActive;
      },
    };
    let maintenanceRuns = 0;
    const maintenance = new MaintenanceController({
      pause: async () => {},
      resume: async () => {},
      run: async () => {
        maintenanceRuns += 1;
        return { backup_name: "perpay-manual.sqlite3" };
      },
    });
    const selfUpdate = new SelfUpdateService({
      updaterClient: client,
      maintenance,
      currentVersion: "1.0.0-rc.5",
    });
    const app = createApp({ ...services, maintenance, selfUpdate, startedAt: new Date() });
    const auth = await login(app);

    const postMaintenance = (body: Record<string, unknown>) =>
      app.request(`${ORIGIN}/api/admin/v1/maintenance/jobs`, {
        method: "POST",
        headers: { cookie: auth.cookie, origin: ORIGIN, "x-csrf-token": auth.csrf, "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    // 1. Start online update (skip backup -> immediately handed off to updater in stage=pulling)
    const applyRes = await app.request(`${ORIGIN}/api/admin/v1/system/update/apply`, {
      method: "POST",
      headers: { cookie: auth.cookie, origin: ORIGIN, "x-csrf-token": auth.csrf, "content-type": "application/json" },
      body: JSON.stringify({ operation_id: randomUUID(), target_version: "1.0.0", create_backup: false }),
    });
    assert.equal(applyRes.status, 202);

    // 2. Attempting ARCHIVE, RESTORE, or BACKUP while updater is pulling must be rejected with 409 update_in_progress!
    for (const payload of [
      { operation_id: randomUUID(), kind: "ARCHIVE", before: "2026-01-01" },
      { operation_id: randomUUID(), kind: "RESTORE", name: "perpay-backup.sqlite3", expected_sha256: "a".repeat(64) },
      { operation_id: randomUUID(), kind: "BACKUP" },
    ]) {
      const blocked = await postMaintenance(payload);
      assert.equal(blocked.status, 409, `expected 409 for ${payload.kind}`);
      assert.equal(((await blocked.json()) as { error: { code: string } }).error.code, "update_in_progress");
    }
    assert.equal(maintenanceRuns, 0);

    // 3. If updater briefly becomes unreachable while an active handoff is known, fail closed for maintenance!
    statusShouldFail = true;
    const blockedUnreachable = await postMaintenance({ operation_id: randomUUID(), kind: "ARCHIVE", before: "2026-01-01" });
    assert.equal(blockedUnreachable.status, 409);
    assert.equal(((await blockedUnreachable.json()) as { error: { code: string } }).error.code, "update_in_progress");
    statusShouldFail = false;

    // 4. Once updater finishes (active=null), concurrent maintenance admission blocks POST /update/apply!
    remoteActive = null;
    remoteStatusGate = new Promise<void>(resolve => { releaseRemoteStatusGate = resolve; });

    const maintenancePromise = postMaintenance({ operation_id: randomUUID(), kind: "BACKUP" });
    // Let the maintenance handler enter guardMaintenanceStart and block on client.status().
    await new Promise<void>(resolve => setImmediate(resolve));

    const racingApply = await app.request(`${ORIGIN}/api/admin/v1/system/update/apply`, {
      method: "POST",
      headers: { cookie: auth.cookie, origin: ORIGIN, "x-csrf-token": auth.csrf, "content-type": "application/json" },
      body: JSON.stringify({ operation_id: randomUUID(), target_version: "1.0.0", create_backup: false }),
    });
    assert.equal(racingApply.status, 409);
    assert.equal(((await racingApply.json()) as { error: { code: string } }).error.code, "maintenance_in_progress");

    releaseRemoteStatusGate!();
    remoteStatusGate = null;
    const allowedMaintenance = await maintenancePromise;
    assert.equal(allowedMaintenance.status, 202);
    await maintenance.settled();
    assert.equal(maintenanceRuns, 1);
  });
});
