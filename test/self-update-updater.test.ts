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
  buildRecreateSpec,
  demuxDockerLogs,
  DockerClient,
  type DockerContainerInspect,
  type DockerCreateContainerBody,
} from "../src/update/docker-client.ts";
import {
  createUpdaterServer,
  ensureUpdaterToken,
  OFFICIAL_IMAGE_REPOSITORY,
  resolveComposeProject,
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
}

async function startMockDockerEngine(
  context: TestContext,
  options: {
    newAppBehavior?: "healthy" | "exit_error" | "never_healthy" | "crash_loop";
    failBackupCreate?: boolean;
    pullError?: string;
    pingFail?: boolean;
  } = {},
) {
  const containers = new Map<string, MockContainerRecord>();
  const pulledImages = new Set<string>();
  const events: string[] = [];
  let createdBodies: Array<{ name: string; body: DockerCreateContainerBody }> = [];
  let connectedExtraNetworks: Array<{ network: string; containerId: string }> = [];
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
        RestartCount: item.status === "restarting" ? 1 : 0,
        Config: {
          Hostname: item.id.slice(0, 12),
          User: "1000:1000",
          Env: item.env,
          Cmd: item.service === "backup" ? ["node", "dist/backup/runner.js", "schedule"] : ["node", "dist/main.js"],
          Image: item.image,
          Labels: {
            "com.docker.compose.project": "perpay",
            "com.docker.compose.service": item.service,
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
      const service = body.Labels?.["com.docker.compose.service"] ?? "unknown";
      if (service === "backup" && options.failBackupCreate) {
        return send(500, { message: "simulated backup create failure" });
      }
      const id = `${service}-new-${seq++}`;
      createdBodies.push({ name, body });
      containers.set(id, {
        id,
        name: name.startsWith("/") ? name : `/${name}`,
        service,
        image: body.Image,
        running: false,
        status: "created",
        exitCode: 0,
        healthy: false,
        env: [...(body.Env ?? [])],
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
      if (item.service === "app" && item.id.startsWith("app-new-") && options.newAppBehavior === "exit_error") {
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
});
