import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { parse } from "yaml";
import {
  buildOneOffMaintenanceSpec,
  buildRecreateSpec,
  demuxDockerLogs,
  DockerClient,
  type DockerContainerInspect,
  type DockerCreateContainerBody,
} from "../src/update/docker-client.ts";
import {
  createUpdaterServer,
  DEFAULT_UPDATER_HEALTH_TIMEOUT_MS,
  ensureUpdaterToken,
  OFFICIAL_IMAGE_REPOSITORY,
  resolveComposeProject,
  resolveHealthTimeoutMilliseconds,
  resolveStopTimeoutSeconds,
  UpdaterOrchestrator,
  type UpdateExecutionJob,
} from "../src/update/updater-core.ts";

interface MockContainerRecord {
  id: string;
  name: string;
  service: string;
  image: string;
  running: boolean;
  status: string;
  exitCode: number;
  healthy: boolean;
  env: string[];
  hostConfig: Record<string, unknown>;
  networks: Record<string, { Aliases?: string[]; IPAddress?: string }>;
  logs: string;
  oneoff?: boolean;
  stopTimeout?: number;
  healthcheck?: Record<string, unknown>;
  restartCount?: number;
  cmd?: readonly string[] | null;
}

async function startMockDockerEngine(
  context: TestContext,
  options: {
    newAppBehavior?: "healthy" | "exit_error" | "never_healthy" | "crash_loop";
    failBackupCreate?: boolean;
    pullError?: string;
    pingFail?: boolean;
    appStopTimeout?: number;
    backupStopTimeout?: number;
    appHealthcheck?: Record<string, unknown>;
    onPull?: () => void;
    onOneOffRun?: (record: MockContainerRecord) => { exitCode: number; logs: string };
    oldAppRollbackBehavior?: "healthy" | "schema_mismatch_until_restored";
  } = {},
) {
  const containers = new Map<string, MockContainerRecord>();
  const pulledImages = new Set<string>();
  const events: string[] = [];
  const stopTimeouts: Array<{ id: string; service: string; t: number }> = [];
  let createdBodies: Array<{ name: string; body: DockerCreateContainerBody }> = [];
  let connectedExtraNetworks: Array<{ network: string; containerId: string }> = [];
  let dbRestoredByOneOff = false;
  let seq = 1;

  containers.set("app-old-id-123456", {
    id: "app-old-id-123456",
    name: "/perpay-app-1",
    service: "app",
    image: `${OFFICIAL_IMAGE_REPOSITORY}:1.0.0-rc.5`,
    running: true,
    status: "running",
    exitCode: 0,
    healthy: true,
    env: ["PERPAY_PORT=6190", "PERPAY_PUBLIC_URL=https://pay.example.com"],
    hostConfig: {
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      Binds: ["perpay-data:/data", "perpay-backups:/backups"],
      PortBindings: { "6190/tcp": [{ HostIp: "127.0.0.1", HostPort: "6190" }] },
    },
    networks: {
      perpay_default: { Aliases: ["app", "app-old-id-1"], IPAddress: "172.20.0.2" },
      proxy_net: { Aliases: ["perpay-app"], IPAddress: "172.21.0.5" },
    },
    logs: "",
    ...(options.appStopTimeout !== undefined ? { stopTimeout: options.appStopTimeout } : {}),
    ...(options.appHealthcheck !== undefined ? { healthcheck: options.appHealthcheck } : {}),
  });

  containers.set("backup-old-id-999", {
    id: "backup-old-id-999",
    name: "/perpay-backup-1",
    service: "backup",
    image: `${OFFICIAL_IMAGE_REPOSITORY}:1.0.0-rc.5`,
    running: true,
    status: "running",
    exitCode: 0,
    healthy: true,
    env: ["PERPAY_DATA_DIR=/data", "PERPAY_BACKUP_DIR=/backups"],
    hostConfig: { ReadonlyRootfs: true, CapDrop: ["ALL"], NetworkMode: "none" },
    networks: { none: {} },
    logs: "",
    ...(options.backupStopTimeout !== undefined ? { stopTimeout: options.backupStopTimeout } : {}),
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const rawBody = Buffer.concat(chunks).toString("utf8");

    const send = (status: number, body?: unknown, contentType = "application/json") => {
      if (body === undefined) {
        res.writeHead(status);
        res.end();
        return;
      }
      const text = typeof body === "string" ? body : JSON.stringify(body);
      res.writeHead(status, { "content-type": contentType });
      res.end(text);
    };

    if (req.method === "GET" && url.pathname === "/_ping") {
      if (options.pingFail) return send(500, { message: "docker down" });
      return send(200, "OK", "text/plain");
    }

    if (req.method === "POST" && url.pathname === "/images/create") {
      const repo = url.searchParams.get("fromImage") ?? "";
      const tag = url.searchParams.get("tag") ?? "";
      events.push(`pull:${repo}:${tag}`);
      options.onPull?.();
      if (options.pullError) {
        return send(200, JSON.stringify({ error: options.pullError }) + "\n", "application/x-ndjson");
      }
      pulledImages.add(`${repo}:${tag}`);
      return send(200, JSON.stringify({ status: "Pull complete" }) + "\n", "application/x-ndjson");
    }

    if (req.method === "GET" && url.pathname.startsWith("/images/") && url.pathname.endsWith("/json")) {
      const ref = decodeURIComponent(url.pathname.slice("/images/".length, -"/json".length));
      if (!pulledImages.has(ref)) return send(404, { message: "No such image" });
      return send(200, { Id: `sha256:${ref}` });
    }

    if (req.method === "GET" && url.pathname === "/containers/json") {
      const list = [...containers.values()].map(item => ({
        Id: item.id,
        Names: [item.name],
        Image: item.image,
        State: item.status,
        Labels: {
          "com.docker.compose.project": "perpay",
          "com.docker.compose.service": item.service,
          ...(item.oneoff ? { "com.docker.compose.oneoff": "true" } : {}),
        },
      }));
      return send(200, list);
    }

    const inspectMatch = /^\/containers\/([^/]+)\/json$/u.exec(url.pathname);
    if (req.method === "GET" && inspectMatch) {
      const item = containers.get(decodeURIComponent(inspectMatch[1]!));
      if (!item) return send(404, { message: "No such container" });
      const inspect: DockerContainerInspect = {
        Id: item.id,
        Name: item.name,
        Image: item.image,
        State: {
          Status: item.status,
          Running: item.running,
          Restarting: item.status === "restarting",
          ExitCode: item.exitCode,
          Health: { Status: item.healthy ? "healthy" : "starting" },
        },
        RestartCount: item.restartCount ?? (item.status === "restarting" ? 1 : 0),
        Config: {
          Hostname: item.id.slice(0, 12),
          User: "1000:1000",
          Env: item.env,
          Cmd: item.cmd !== undefined ? item.cmd : (item.service === "backup" ? ["node", "dist/backup/runner.js", "schedule"] : ["node", "dist/main.js"]),
          Image: item.image,
          ...(item.stopTimeout !== undefined ? { StopTimeout: item.stopTimeout } : {}),
          ...(item.healthcheck !== undefined ? { Healthcheck: item.healthcheck } : {}),
          Labels: {
            "com.docker.compose.project": "perpay",
            "com.docker.compose.service": item.service,
            ...(item.oneoff ? { "com.docker.compose.oneoff": "true" } : {}),
          },
        },
        HostConfig: item.hostConfig,
        NetworkSettings: { Networks: item.networks },
      };
      return send(200, inspect);
    }

    const stopMatch = /^\/containers\/([^/]+)\/stop$/u.exec(url.pathname);
    if (req.method === "POST" && stopMatch) {
      const item = containers.get(decodeURIComponent(stopMatch[1]!));
      if (!item) return send(404, { message: "No such container" });
      const t = Number(url.searchParams.get("t") ?? "10");
      stopTimeouts.push({ id: item.id, service: item.service, t });
      item.running = false;
      item.status = "exited";
      events.push(`stop:${item.service}:${item.id}`);
      return send(204);
    }

    const renameMatch = /^\/containers\/([^/]+)\/rename$/u.exec(url.pathname);
    if (req.method === "POST" && renameMatch) {
      const item = containers.get(decodeURIComponent(renameMatch[1]!));
      if (!item) return send(404, { message: "No such container" });
      const newName = url.searchParams.get("name") ?? "";
      item.name = newName.startsWith("/") ? newName : `/${newName}`;
      events.push(`rename:${item.id}:${item.name}`);
      return send(204);
    }

    if (req.method === "POST" && url.pathname === "/containers/create") {
      const name = url.searchParams.get("name") ?? `container-${seq}`;
      const body = JSON.parse(rawBody) as DockerCreateContainerBody;
      const isOneOff = body.Labels?.["com.docker.compose.oneoff"] === "true";
      const service = isOneOff ? "oneoff" : (body.Labels?.["com.docker.compose.service"] ?? "unknown");
      if (service === "backup" && options.failBackupCreate) {
        return send(500, { message: "simulated backup create failure" });
      }
      const id = `${service}-new-${seq++}`;
      createdBodies.push({ name, body });
      containers.set(id, {
        id,
        name: name.startsWith("/") ? name : `/${name}`,
        service,
        oneoff: isOneOff,
        image: body.Image,
        running: false,
        status: "created",
        exitCode: 0,
        healthy: false,
        env: [...(body.Env ?? [])],
        cmd: body.Cmd ?? null,
        ...(body.StopTimeout !== undefined ? { stopTimeout: body.StopTimeout } : {}),
        ...(body.Healthcheck !== undefined ? { healthcheck: body.Healthcheck } : {}),
        hostConfig: body.HostConfig,
        networks: body.NetworkingConfig?.EndpointsConfig
          ? Object.fromEntries(Object.entries(body.NetworkingConfig.EndpointsConfig).map(([k, v]) => [k, { Aliases: [...(v.Aliases ?? [])], IPAddress: "172.20.0.9" }]))
          : { none: {} },
        logs: service === "app" && options.newAppBehavior === "exit_error" ? "Fatal migration error: schema mismatch" : "",
      });
      events.push(`create:${service}:${name}:${body.Image}`);
      return send(201, { Id: id });
    }

    const startMatch = /^\/containers\/([^/]+)\/start$/u.exec(url.pathname);
    if (req.method === "POST" && startMatch) {
      const item = containers.get(decodeURIComponent(startMatch[1]!));
      if (!item) return send(404, { message: "No such container" });
      events.push(`start:${item.service}:${item.id}`);
      if (item.oneoff) {
        const outcome = options.onOneOffRun?.(item) ?? { exitCode: 0, logs: "" };
        if (outcome.exitCode === 0 && (item.cmd?.includes("rollback-failed-migration") || item.cmd?.includes("restore-migration-backup"))) {
          dbRestoredByOneOff = true;
        }
        item.running = false;
        item.status = "exited";
        item.exitCode = outcome.exitCode;
        item.logs = outcome.logs;
      } else if (item.id === "app-old-id-123456" && options.oldAppRollbackBehavior === "schema_mismatch_until_restored" && !dbRestoredByOneOff) {
        item.running = false;
        item.status = "exited";
        item.exitCode = 1;
        item.healthy = false;
        item.logs = "Error: database contains unknown migration 50 future_schema_v50";
      } else if (item.service === "app" && item.id.startsWith("app-new-") && options.newAppBehavior === "exit_error") {
        item.running = false;
        item.status = "exited";
        item.exitCode = 1;
        item.healthy = false;
      } else if (item.service === "app" && item.id.startsWith("app-new-") && options.newAppBehavior === "crash_loop") {
        item.running = true;
        item.status = "restarting";
        item.exitCode = 137;
        item.healthy = false;
        item.logs = "Crash loop on startup";
      } else {
        item.running = true;
        item.status = "running";
        item.exitCode = 0;
        item.healthy = item.service === "app" && item.id.startsWith("app-new-")
          ? (options.newAppBehavior ?? "healthy") === "healthy"
          : true;
      }
      return send(204);
    }

    const waitMatch = /^\/containers\/([^/]+)\/wait$/u.exec(url.pathname);
    if (req.method === "POST" && waitMatch) {
      const item = containers.get(decodeURIComponent(waitMatch[1]!));
      if (!item) return send(404, { message: "No such container" });
      events.push(`wait:${item.service}:${item.id}`);
      return send(200, { StatusCode: item.exitCode, Error: null });
    }

    const removeMatch = /^\/containers\/([^/]+)$/u.exec(url.pathname);
    if (req.method === "DELETE" && removeMatch) {
      const id = decodeURIComponent(removeMatch[1]!);
      const item = containers.get(id);
      if (item) {
        events.push(`remove:${item.service}:${id}`);
        containers.delete(id);
      }
      return send(204);
    }

    const netMatch = /^\/networks\/([^/]+)\/connect$/u.exec(url.pathname);
    if (req.method === "POST" && netMatch) {
      const network = decodeURIComponent(netMatch[1]!);
      const body = JSON.parse(rawBody) as { Container: string };
      connectedExtraNetworks.push({ network, containerId: body.Container });
      events.push(`connect:${network}:${body.Container}`);
      return send(200);
    }

    const logsMatch = /^\/containers\/([^/]+)\/logs$/u.exec(url.pathname);
    if (req.method === "GET" && logsMatch) {
      const item = containers.get(decodeURIComponent(logsMatch[1]!));
      return send(200, item?.logs ?? "", "text/plain");
    }

    send(404, { message: `Unhandled ${req.method} ${url.pathname}` });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  context.after(async () => {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  });

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    containers,
    events,
    stopTimeouts,
    createdBodies,
    connectedExtraNetworks,
  };
}

describe("self-update sidecar updater", () => {
  it("generates and reuses a 64-hex shared token file", (context) => {
    const dir = mkdtempSync(join(tmpdir(), "perpay-updater-token-"));
    context.after(() => rmSync(dir, { recursive: true, force: true }));
    const tokenPath = join(dir, "secrets", "token");
    const first = ensureUpdaterToken(tokenPath);
    assert.match(first, /^[0-9a-f]{64}$/u);
    const second = ensureUpdaterToken(tokenPath);
    assert.equal(second, first);
    assert.equal(readFileSync(tokenPath, "utf8").trim(), first);
  });

  it("enforces Bearer auth, rejects downgrades, and executes a full config-preserving upgrade", async (context) => {
    const dockerMock = await startMockDockerEngine(context, { newAppBehavior: "healthy" });
    const docker = new DockerClient({ baseUrl: dockerMock.baseUrl });
    let now = 1_700_000_000_000;
    const orchestrator = new UpdaterOrchestrator({
      docker,
      composeProject: "perpay",
      clock: () => now,
      sleep: async () => { now += 100; },
      healthCheck: async () => true,
    });
    const token = "a".repeat(64);
    const updaterServer = createUpdaterServer({
      orchestrator,
      token,
      pingDocker: () => docker.ping(),
    });
    updaterServer.listen(0, "127.0.0.1");
    await once(updaterServer, "listening");
    const addr = updaterServer.address();
    assert.ok(addr && typeof addr === "object");
    context.after(async () => {
      await new Promise<void>(resolve => { updaterServer.close(() => resolve()); updaterServer.closeAllConnections(); });
    });
    const base = `http://127.0.0.1:${addr.port}`;

    // 1. /healthz works without auth
    const healthRes = await fetch(`${base}/healthz`);
    assert.equal(healthRes.status, 200);

    // 2. /status requires Bearer token
    const unauthRes = await fetch(`${base}/status`);
    assert.equal(unauthRes.status, 401);

    // 3. Rejects invalid version & downgrade
    const downgradeRes = await fetch(`${base}/apply`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        operation_id: randomUUID(),
        target_version: "1.0.0-rc.4",
        previous_version: "1.0.0-rc.5",
      }),
    });
    assert.equal(downgradeRes.status, 422);

    const injectedRes = await fetch(`${base}/apply`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        operation_id: randomUUID(),
        target_version: "evil/image:1.0.0",
        previous_version: "1.0.0-rc.5",
      }),
    });
    assert.equal(injectedRes.status, 422);

    // 4. Accepts valid upgrade & preserves container configuration
    const opId = randomUUID();
    const applyRes = await fetch(`${base}/apply`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        operation_id: opId,
        target_version: "1.0.0",
        previous_version: "1.0.0-rc.5",
        backup_name: "perpay-pre-update.sqlite3",
      }),
    });
    assert.equal(applyRes.status, 202);
    const accepted = await applyRes.json() as { data: UpdateExecutionJob };
    assert.equal(accepted.data.id, opId);

    // Same operation_id with different target returns 409 operation_conflict
    const conflictRes = await fetch(`${base}/apply`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        operation_id: opId,
        target_version: "1.1.0",
        previous_version: "1.0.0-rc.5",
      }),
    });
    assert.equal(conflictRes.status, 409);

    await orchestrator.settled();

    const statusRes = await fetch(`${base}/status`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(statusRes.status, 200);
    const finalState = await statusRes.json() as { data: { active: UpdateExecutionJob | null; latest: UpdateExecutionJob | null } };
    assert.equal(finalState.data.active, null);
    assert.equal(finalState.data.latest?.status, "SUCCEEDED");
    assert.equal(finalState.data.latest?.stage, "completed");
    assert.equal(finalState.data.latest?.rolled_back, false);
    assert.equal(finalState.data.latest?.backup_name, "perpay-pre-update.sqlite3");

    // Verify sequence & preserved configuration
    assert.ok(dockerMock.events.includes(`pull:${OFFICIAL_IMAGE_REPOSITORY}:1.0.0`));
    const createdApp = dockerMock.createdBodies.find(item => item.name === "perpay-app-1");
    assert.ok(createdApp);
    assert.equal(createdApp.body.Image, `${OFFICIAL_IMAGE_REPOSITORY}:1.0.0`);
    assert.deepEqual(createdApp.body.Env, ["PERPAY_PORT=6190", "PERPAY_PUBLIC_URL=https://pay.example.com"]);
    assert.equal(createdApp.body.HostConfig.ReadonlyRootfs, true);
    assert.deepEqual(createdApp.body.HostConfig.CapDrop, ["ALL"]);
    assert.equal(dockerMock.connectedExtraNetworks.some(item => item.network === "proxy_net"), true);

    const createdBackup = dockerMock.createdBodies.find(item => item.name === "perpay-backup-1");
    assert.ok(createdBackup);
    assert.equal(createdBackup.body.Image, `${OFFICIAL_IMAGE_REPOSITORY}:1.0.0`);
    assert.equal(createdBackup.body.HostConfig.NetworkMode, "none");
    assert.equal(createdBackup.body.NetworkingConfig, undefined);
  });

  it("automatically rolls back to the original app and backup containers when the new app exits", async (context) => {
    const dockerMock = await startMockDockerEngine(context, { newAppBehavior: "exit_error" });
    const docker = new DockerClient({ baseUrl: dockerMock.baseUrl });
    const orchestrator = new UpdaterOrchestrator({
      docker,
      composeProject: "perpay",
      sleep: async () => {},
      healthCheck: async () => false,
    });

    orchestrator.start({
      operation_id: randomUUID(),
      target_version: "1.0.0",
      previous_version: "1.0.0-rc.5",
      backup_name: "perpay-backup.sqlite3",
    });
    await orchestrator.settled();

    const state = orchestrator.state();
    assert.equal(state.active, null);
    assert.equal(state.latest?.status, "FAILED");
    assert.equal(state.latest?.rolled_back, true);
    assert.match(state.latest?.error ?? "", /exit 1/u);
    assert.match(state.latest?.error ?? "", /Fatal migration error/u);

    // Original app container was renamed back to /perpay-app-1 and restarted
    const restoredApp = dockerMock.containers.get("app-old-id-123456");
    assert.ok(restoredApp);
    assert.equal(restoredApp.name, "/perpay-app-1");
    assert.equal(restoredApp.running, true);

    // Original backup container was restarted
    const restoredBackup = dockerMock.containers.get("backup-old-id-999");
    assert.ok(restoredBackup);
    assert.equal(restoredBackup.running, true);
  });

  it("automatically rolls back when the new app container never becomes healthy before timeout", async (context) => {
    const dockerMock = await startMockDockerEngine(context, { newAppBehavior: "never_healthy" });
    const docker = new DockerClient({ baseUrl: dockerMock.baseUrl });
    let now = 1_700_000_000_000;
    const orchestrator = new UpdaterOrchestrator({
      docker,
      composeProject: "perpay",
      clock: () => now,
      sleep: async (ms) => { now += ms; },
      healthCheck: async () => false,
      healthTimeoutMilliseconds: 3_000,
      healthPollIntervalMilliseconds: 1_000,
    });

    orchestrator.start({
      operation_id: randomUUID(),
      target_version: "1.0.0",
      previous_version: "1.0.0-rc.5",
    });
    await orchestrator.settled();

    const state = orchestrator.state();
    assert.equal(state.latest?.status, "FAILED");
    assert.equal(state.latest?.rolled_back, true);
    assert.match(state.latest?.error ?? "", /健康检查/u);
    assert.equal(dockerMock.containers.get("app-old-id-123456")?.running, true);
  });

  it("keeps docker-compose.updater.yml isolated from business data, master-key volumes, external networks, and hardcoded project names", () => {
    const overlay = parse(readFileSync(new URL("../docker-compose.updater.yml", import.meta.url), "utf8")) as {
      services: {
        app: { environment: Record<string, string>; volumes: string[]; networks?: string[] };
        updater: {
          image: string;
          environment?: Record<string, string>;
          volumes: string[];
          networks?: string[];
          ports?: unknown[];
          read_only: boolean;
          cap_drop: string[];
        };
      };
      networks?: Record<string, { internal?: boolean }>;
      volumes: Record<string, unknown>;
    };
    assert.ok(overlay.services.updater);
    assert.equal(overlay.services.updater.ports, undefined);
    assert.equal(overlay.services.updater.read_only, true);
    assert.deepEqual(overlay.services.updater.cap_drop, ["ALL"]);
    assert.equal(overlay.services.updater.volumes.some(v => v.includes("perpay-data") || v.includes("perpay-secrets")), false);
    assert.equal(overlay.services.app.volumes.some(v => v.includes("docker.sock")), false);
    assert.match(overlay.services.updater.image, /ghcr\.io\/mashiro0619\/perpay/u);
    assert.equal(overlay.services.updater.environment?.PERPAY_COMPOSE_PROJECT, undefined);
    assert.equal(overlay.networks?.["perpay-updater"]?.internal, true);
    assert.deepEqual(overlay.services.updater.networks, ["perpay-updater"]);
    assert.ok(overlay.services.app.networks?.includes("perpay-updater"));
  });

  it("blocks forged previous_version downgrades using authoritative running container version before pulling", async (context) => {
    const dockerMock = await startMockDockerEngine(context, { newAppBehavior: "healthy" });
    const appContainer = dockerMock.containers.get("app-old-id-123456")!;
    appContainer.image = `${OFFICIAL_IMAGE_REPOSITORY}:1.2.0`;
    const docker = new DockerClient({ baseUrl: dockerMock.baseUrl });
    const orchestrator = new UpdaterOrchestrator({
      docker,
      composeProject: "perpay",
      sleep: async () => {},
      healthCheck: async () => true,
    });

    // Attacker supplies forged previous_version="0.0.1" attempting downgrade from 1.2.0 -> 1.0.0.
    orchestrator.start({
      operation_id: randomUUID(),
      target_version: "1.0.0",
      previous_version: "0.0.1",
    });
    await orchestrator.settled();

    const state = orchestrator.state();
    assert.equal(state.latest?.status, "FAILED");
    assert.match(state.latest?.error ?? "", /1\.2\.0.*拒绝降级/u);
    // Neither pullImage nor stopContainer should ever have been called!
    assert.equal(dockerMock.events.length, 0);
  });

  it("auto-detects Compose project from updater container label, rejects corrupt token files, and handles multi-network + log demux", async (context) => {
    const dir = mkdtempSync(join(tmpdir(), "perpay-updater-corrupt-"));
    context.after(() => rmSync(dir, { recursive: true, force: true }));
    const badTokenPath = join(dir, "bad-token");
    writeFileSync(badTokenPath, "not-a-valid-64-hex-token\n", "utf8");
    assert.throws(() => ensureUpdaterToken(badTokenPath), /64 lowercase hexadecimal/u);

    const dockerMock = await startMockDockerEngine(context, { newAppBehavior: "healthy" });
    dockerMock.containers.set("updater-self-abc", {
      id: "updater-self-abc",
      name: "/perpay-staging-updater-1",
      service: "updater",
      image: `${OFFICIAL_IMAGE_REPOSITORY}:1.0.0`,
      running: true,
      status: "running",
      exitCode: 0,
      healthy: true,
      env: [],
      hostConfig: {},
      networks: {},
      logs: "",
    });
    const docker = new DockerClient({ baseUrl: dockerMock.baseUrl });
    assert.equal(await resolveComposeProject(docker, undefined, "updater-self-abc"), "perpay");
    await assert.rejects(() => resolveComposeProject(docker, undefined, "missing-self"), /无法自动识别/u);

    // Multi-network ordering: caddy_proxy sorts before perpay_default, yet HostConfig.NetworkMode must win!
    const spec = buildRecreateSpec(
      {
        Id: "1234567890abcdef",
        Name: "/perpay-app-1",
        Image: `${OFFICIAL_IMAGE_REPOSITORY}:1.0.0`,
        State: { Status: "running", Running: true },
        Config: {
          Image: `${OFFICIAL_IMAGE_REPOSITORY}:1.0.0`,
          Labels: {
            "com.docker.compose.project": "perpay",
            "com.docker.compose.service": "app",
            "org.opencontainers.image.version": "1.0.0",
            "com.docker.compose.image": `${OFFICIAL_IMAGE_REPOSITORY}:1.0.0`,
          },
        },
        HostConfig: { NetworkMode: "perpay_default" },
        NetworkSettings: {
          Networks: {
            caddy_proxy: { Aliases: ["proxy-app"] },
            perpay_default: { Aliases: ["app"] },
          },
        },
      },
      `${OFFICIAL_IMAGE_REPOSITORY}:1.1.0`,
    );
    assert.deepEqual(Object.keys(spec.body.NetworkingConfig?.EndpointsConfig ?? {}), ["perpay_default"]);
    assert.deepEqual(spec.extraNetworks.map(item => item.networkName), ["caddy_proxy"]);
    assert.equal(spec.body.Labels?.["org.opencontainers.image.version"], undefined);
    assert.equal(spec.body.Labels?.["com.docker.compose.image"], undefined);
    assert.equal(spec.body.Labels?.["com.docker.compose.service"], "app");

    // Demux 8-byte Docker log frames cleanly
    const payload = Buffer.from("line one\nline two\n", "utf8");
    const frame = Buffer.alloc(8 + payload.byteLength);
    frame[0] = 2; // stderr
    frame.writeUInt32BE(payload.byteLength, 4);
    payload.copy(frame, 8);
    assert.equal(demuxDockerLogs(frame), "line one\nline two");
  });

  it("fast-fails crash-looping app containers, preserves stopped backup state, and returns 413 on oversized apply requests", async (context) => {
    const dockerMock = await startMockDockerEngine(context, { newAppBehavior: "healthy" });
    // Keep backup container stopped initially — upgrade must preserve its stopped state
    const backup = dockerMock.containers.get("backup-old-id-999")!;
    backup.running = false;
    backup.status = "exited";
    const docker = new DockerClient({ baseUrl: dockerMock.baseUrl });
    const orchestrator = new UpdaterOrchestrator({
      docker,
      composeProject: "perpay",
      sleep: async () => {},
      healthCheck: async () => true,
    });
    orchestrator.start({
      operation_id: randomUUID(),
      target_version: "1.0.0",
      previous_version: "1.0.0-rc.5",
    });
    await orchestrator.settled();
    assert.equal(orchestrator.state().latest?.status, "SUCCEEDED");
    // Stopped backup was recreated on the new image without being started!
    const newBackup = [...dockerMock.containers.values()].find(c => c.service === "backup");
    assert.ok(newBackup);
    assert.equal(newBackup.image, `${OFFICIAL_IMAGE_REPOSITORY}:1.0.0`);
    assert.equal(newBackup.running, false);

    // Oversized HTTP body to /apply returns clean 413 without crashing server
    const token = "b".repeat(64);
    const updaterServer = createUpdaterServer({ orchestrator, token });
    updaterServer.listen(0, "127.0.0.1");
    await once(updaterServer, "listening");
    const addr = updaterServer.address();
    assert.ok(addr && typeof addr === "object");
    context.after(async () => {
      await new Promise<void>(resolve => { updaterServer.close(() => resolve()); updaterServer.closeAllConnections(); });
    });
    const oversized = await fetch(`http://127.0.0.1:${addr.port}/apply`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ pad: "x".repeat(24 * 1024) }),
    });
    assert.equal(oversized.status, 413);
  });

  it("fast-fails crash-looping app containers and restores original backup non-destructively if backup recreate fails", async (context) => {
    const crashMock = await startMockDockerEngine(context, { newAppBehavior: "crash_loop" });
    let sleeps = 0;
    const crashOrchestrator = new UpdaterOrchestrator({
      docker: new DockerClient({ baseUrl: crashMock.baseUrl }),
      composeProject: "perpay",
      sleep: async () => { sleeps += 1; },
      healthCheck: async () => false,
      healthTimeoutMilliseconds: 90_000,
    });
    crashOrchestrator.start({
      operation_id: randomUUID(),
      target_version: "1.0.0",
      previous_version: "1.0.0-rc.5",
    });
    await crashOrchestrator.settled();
    assert.equal(crashOrchestrator.state().latest?.status, "FAILED");
    assert.equal(crashOrchestrator.state().latest?.rolled_back, true);
    assert.match(crashOrchestrator.state().latest?.error ?? "", /崩溃重启.*restarts=1/u);
    assert.equal(sleeps, 0);

    // Non-destructive backup recreate failure keeps upgraded app live and restores original backup!
    const backupFailMock = await startMockDockerEngine(context, {
      newAppBehavior: "healthy",
      failBackupCreate: true,
    });
    const backupFailOrchestrator = new UpdaterOrchestrator({
      docker: new DockerClient({ baseUrl: backupFailMock.baseUrl }),
      composeProject: "perpay",
      sleep: async () => {},
      healthCheck: async () => true,
    });
    backupFailOrchestrator.start({
      operation_id: randomUUID(),
      target_version: "1.0.0",
      previous_version: "1.0.0-rc.5",
    });
    await backupFailOrchestrator.settled();
    const resultState = backupFailOrchestrator.state().latest;
    assert.equal(resultState?.status, "FAILED");
    assert.equal(resultState?.rolled_back, false);
    assert.match(resultState?.error ?? "", /原备份容器已恢复/u);
    const restoredBackup = backupFailMock.containers.get("backup-old-id-999");
    assert.ok(restoredBackup);
    assert.equal(restoredBackup.name, "/perpay-backup-1");
    assert.equal(restoredBackup.running, true);
  });

  it("configures docker-compose.updater.yml with gid 1000 so app (node) can read the 0640 token under cap_drop ALL", () => {
    const compose = parse(readFileSync(new URL("../docker-compose.updater.yml", import.meta.url), "utf8")) as {
      services?: { updater?: { user?: string; cap_drop?: string[]; read_only?: boolean } };
    };
    assert.equal(compose.services?.updater?.user, "0:1000");
    assert.deepEqual(compose.services?.updater?.cap_drop, ["ALL"]);
    assert.equal(compose.services?.updater?.read_only, true);
  });

  it("aborts update cleanly if maintenance starts during image pull and respects container stop_grace_period", async (context) => {
    let maintenanceActive = false;
    const pullRaceMock = await startMockDockerEngine(context, {
      newAppBehavior: "healthy",
      onPull: () => {
        maintenanceActive = true;
      },
    });
    const pullRaceOrchestrator = new UpdaterOrchestrator({
      docker: new DockerClient({ baseUrl: pullRaceMock.baseUrl }),
      composeProject: "perpay",
      sleep: async () => {},
      healthCheck: async () => true,
      checkAppMaintenance: async () => ({ active: maintenanceActive, operation: maintenanceActive ? "RESTORE" : null }),
    });
    pullRaceOrchestrator.start({
      operation_id: randomUUID(),
      target_version: "1.0.0",
      previous_version: "1.0.0-rc.5",
    });
    await pullRaceOrchestrator.settled();

    const aborted = pullRaceOrchestrator.state().latest;
    assert.equal(aborted?.status, "FAILED");
    assert.equal(aborted?.rolled_back, false);
    assert.match(aborted?.error ?? "", /拉取镜像期间启动了维护任务/u);
    // Neither backup nor app should ever have been stopped!
    assert.equal(pullRaceMock.stopTimeouts.length, 0);
    assert.equal(pullRaceMock.containers.get("app-old-id-123456")?.running, true);
    assert.equal(pullRaceMock.containers.get("backup-old-id-999")?.running, true);

    // When container declares StopTimeout (e.g. compose stop_grace_period: 7h = 25200s), stopContainer must preserve it.
    const graceMock = await startMockDockerEngine(context, {
      newAppBehavior: "healthy",
      appStopTimeout: 25_200,
      backupStopTimeout: 25_200,
    });
    const graceOrchestrator = new UpdaterOrchestrator({
      docker: new DockerClient({ baseUrl: graceMock.baseUrl }),
      composeProject: "perpay",
      sleep: async () => {},
      healthCheck: async () => true,
    });
    graceOrchestrator.start({
      operation_id: randomUUID(),
      target_version: "1.0.0",
      previous_version: "1.0.0-rc.5",
    });
    await graceOrchestrator.settled();

    assert.equal(graceOrchestrator.state().latest?.status, "SUCCEEDED");
    assert.deepEqual(
      graceMock.stopTimeouts.map(item => ({ service: item.service, t: item.t })),
      [
        { service: "backup", t: 25_200 },
        { service: "app", t: 25_200 },
      ],
    );
    assert.equal(resolveStopTimeoutSeconds(30, null), 30);
  });

  it("allows slow large-DB upgrades exceeding 90s to succeed and aligns timeout with container Healthcheck.StartPeriod", async (context) => {
    // 1. Default orchestrator timeout must NOT kill a container that becomes ready at 120s.
    const slowMock = await startMockDockerEngine(context, {
      newAppBehavior: "healthy",
      appHealthcheck: {
        StartPeriod: 5 * 60 * 1_000_000_000, // 5m in nanoseconds (matching docker-compose.yml)
        Interval: 30 * 1_000_000_000,
        Retries: 3,
      },
    });
    let now = 1_700_000_000_000;
    const startMs = now;
    const slowOrchestrator = new UpdaterOrchestrator({
      docker: new DockerClient({ baseUrl: slowMock.baseUrl }),
      composeProject: "perpay",
      clock: () => now,
      sleep: async (ms) => { now += ms; },
      healthCheck: async () => (now - startMs) >= 120_000,
    });

    slowOrchestrator.start({
      operation_id: randomUUID(),
      target_version: "1.0.0",
      previous_version: "1.0.0-rc.5",
    });
    await slowOrchestrator.settled();

    assert.equal(slowOrchestrator.state().latest?.status, "SUCCEEDED");
    assert.ok(now - startMs >= 120_000);
    assert.ok(DEFAULT_UPDATER_HEALTH_TIMEOUT_MS >= 300_000);

    // 2. Container declaring a 10m StartPeriod stretches deadline past 6m automatically.
    const derived = resolveHealthTimeoutMilliseconds(90_000, {
      Id: "x",
      Name: "/app",
      Image: "img",
      State: { Status: "running", Running: true },
      Config: {
        Image: "img",
        Healthcheck: { StartPeriod: 600 * 1_000_000_000, Interval: 30 * 1_000_000_000, Retries: 3 },
      },
      HostConfig: {},
    });
    assert.equal(derived, 690_000);
  });

  it("automatically restores the pre-migration database via an offline old-image maintenance container when rollback hits newer schema", async (context) => {
    const mock = await startMockDockerEngine(context, {
      newAppBehavior: "exit_error",
      oldAppRollbackBehavior: "schema_mismatch_until_restored",
      onOneOffRun: (record) => {
        assert.equal(record.hostConfig.NetworkMode, "none");
        assert.equal((record.hostConfig.RestartPolicy as { Name?: string })?.Name, "no");
        assert.equal(record.hostConfig.PortBindings, undefined);
        assert.equal(record.cmd?.[0], "node");
        assert.equal(record.cmd?.[1], "dist/database/maintenance.js");
        assert.equal(record.cmd?.[2], "rollback-failed-migration");
        assert.equal(record.cmd?.[3], "--since-ms");
        assert.equal(record.cmd?.[5], "--confirm-replace-current-database");
        return {
          exitCode: 0,
          logs: JSON.stringify({
            backupName: "perpay.sqlite3.pre-migration-v49-to-v50.sqlite3",
            restoredSchemaVersion: 49,
            quarantinedDatabaseName: "perpay.sqlite3.before-restore-test",
          }) + "\n",
        };
      },
    });
    const orchestrator = new UpdaterOrchestrator({
      docker: new DockerClient({ baseUrl: mock.baseUrl }),
      composeProject: "perpay",
      sleep: async () => {},
      healthCheck: async (inspect) => inspect.Id === "app-old-id-123456" && inspect.State.Running,
    });

    orchestrator.start({
      operation_id: randomUUID(),
      target_version: "1.0.0",
      previous_version: "1.0.0-rc.5",
    });
    await orchestrator.settled();

    const latest = orchestrator.state().latest;
    assert.equal(latest?.status, "FAILED");
    assert.equal(latest?.rolled_back, true);
    assert.match(latest?.error ?? "", /已自动恢复迁移前数据库快照（perpay\.sqlite3\.pre-migration-v49-to-v50\.sqlite3）/u);
    // One-off container must have been removed after completing restore, and old app + backup must be running!
    assert.equal([...mock.containers.values()].some(c => c.oneoff), false);
    assert.equal(mock.containers.get("app-old-id-123456")?.running, true);
    assert.equal(mock.containers.get("backup-old-id-999")?.running, true);

    // Also verify buildOneOffMaintenanceSpec strips ports/networking and keeps oneoff label + volumes.
    const oneOffSpec = buildOneOffMaintenanceSpec(
      {
        Id: "old123",
        Name: "/perpay-app-1",
        Image: "sha256:oldimage",
        State: { Status: "exited", Running: false },
        Config: {
          User: "1000:1000",
          Image: `${OFFICIAL_IMAGE_REPOSITORY}:latest`,
          Env: ["PERPAY_DATA_DIR=/data"],
          Labels: {
            "com.docker.compose.project": "perpay",
            "com.docker.compose.service": "app",
          },
        },
        HostConfig: {
          Binds: ["perpay-data:/data"],
          PortBindings: { "6190/tcp": [{ HostPort: "6190" }] },
          RestartPolicy: { Name: "unless-stopped" },
        },
      },
      ["node", "dist/database/maintenance.js", "list-migration-backups"],
    );
    assert.equal(oneOffSpec.Image, "sha256:oldimage");
    assert.equal(oneOffSpec.HostConfig.NetworkMode, "none");
    assert.equal(oneOffSpec.HostConfig.PortBindings, undefined);
    assert.deepEqual(oneOffSpec.HostConfig.RestartPolicy, { Name: "no" });
    assert.equal(oneOffSpec.Labels?.["com.docker.compose.oneoff"], "true");
  });

  it("falls back to list-migration-backups + restore-migration-backup when rolling back to a legacy old image", async (context) => {
    const oneOffCommands: string[][] = [];
    const mock = await startMockDockerEngine(context, {
      newAppBehavior: "exit_error",
      oldAppRollbackBehavior: "schema_mismatch_until_restored",
      onOneOffRun: (record) => {
        const cmd = [...(record.cmd ?? [])];
        oneOffCommands.push(cmd);
        if (cmd[2] === "rollback-failed-migration") {
          return { exitCode: 1, logs: "usage: maintenance <list-migration-backups|restore-migration-backup>" };
        }
        if (cmd[2] === "list-migration-backups") {
          return {
            exitCode: 0,
            logs: JSON.stringify({
              backups: [
                { name: "perpay.sqlite3.pre-migration-v48-to-v49.sqlite3", fromVersion: 48, toVersion: 49 },
                { name: "perpay.sqlite3.pre-migration-v49-to-v50.sqlite3", fromVersion: 49, toVersion: 50 },
              ],
            }) + "\n",
          };
        }
        assert.equal(cmd[2], "restore-migration-backup");
        assert.equal(cmd[3], "perpay.sqlite3.pre-migration-v49-to-v50.sqlite3");
        return { exitCode: 0, logs: JSON.stringify({ backupName: cmd[3], restoredSchemaVersion: 49 }) + "\n" };
      },
    });
    const orchestrator = new UpdaterOrchestrator({
      docker: new DockerClient({ baseUrl: mock.baseUrl }),
      composeProject: "perpay",
      sleep: async () => {},
      healthCheck: async (inspect) => inspect.Id === "app-old-id-123456" && inspect.State.Running,
    });

    orchestrator.start({
      operation_id: randomUUID(),
      target_version: "1.0.0",
      previous_version: "1.0.0-rc.5",
    });
    await orchestrator.settled();

    assert.equal(orchestrator.state().latest?.rolled_back, true);
    assert.deepEqual(
      oneOffCommands.map(cmd => cmd[2]),
      ["rollback-failed-migration", "list-migration-backups", "restore-migration-backup"],
    );
    assert.equal(mock.containers.get("app-old-id-123456")?.running, true);
  });

  it("detects live app maintenance via real /healthz responses (status=maintenance and 503 database_maintenance_in_progress)", async (context) => {
    for (const scenario of [
      { status: 200, body: { status: "maintenance", operation: "RESTORE" } },
      { status: 503, body: { status: "unhealthy", database: { ok: false, result: "database_maintenance_in_progress" } } },
    ]) {
      const appHealthServer = http.createServer((_req, res) => {
        res.writeHead(scenario.status, { "content-type": "application/json" });
        res.end(JSON.stringify(scenario.body));
      });
      appHealthServer.listen(0, "127.0.0.1");
      await once(appHealthServer, "listening");
      const healthAddr = appHealthServer.address();
      assert.ok(healthAddr && typeof healthAddr === "object");
      context.after(async () => {
        await new Promise<void>(resolve => { appHealthServer.close(() => resolve()); appHealthServer.closeAllConnections(); });
      });

      const mock = await startMockDockerEngine(context, { newAppBehavior: "healthy" });
      const oldApp = mock.containers.get("app-old-id-123456")!;
      oldApp.env = [`PERPAY_PORT=${healthAddr.port}`];
      oldApp.networks = { perpay_default: { IPAddress: "127.0.0.1" } };

      const orchestrator = new UpdaterOrchestrator({
        docker: new DockerClient({ baseUrl: mock.baseUrl }),
        composeProject: "perpay",
        sleep: async () => {},
      });
      orchestrator.start({
        operation_id: randomUUID(),
        target_version: "1.0.0",
        previous_version: "1.0.0-rc.5",
      });
      await orchestrator.settled();

      const latest = orchestrator.state().latest;
      assert.equal(latest?.status, "FAILED");
      assert.match(latest?.error ?? "", /维护任务/u);
      assert.equal(mock.stopTimeouts.length, 0);
      assert.equal(mock.events.length, 0);
    }
  });
});
