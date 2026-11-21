import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { compareReleaseVersions, parseReleaseVersion } from "../shared/release-version.ts";
import {
  buildRecreateSpec,
  DockerClient,
  normalizeContainerName,
  type DockerContainerInspect,
} from "./docker-client.ts";

export const OFFICIAL_IMAGE_REPOSITORY = "ghcr.io/mashiro0619/perpay";

export type SelfUpdateStage =
  | "queued"
  | "backing_up"
  | "pulling"
  | "stopping_backup"
  | "recreating_app"
  | "verifying_health"
  | "recreating_backup"
  | "rolling_back"
  | "completed"
  | "failed";

export interface UpdateExecutionJob {
  readonly id: string;
  readonly target_version: string;
  readonly previous_version: string;
  readonly status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";
  readonly stage: SelfUpdateStage;
  readonly message: string;
  readonly backup_name: string | null;
  readonly rolled_back: boolean;
  readonly started_at: number;
  readonly finished_at: number | null;
  readonly error: string | null;
}

export interface UpdaterState {
  readonly active: UpdateExecutionJob | null;
  readonly latest: UpdateExecutionJob | null;
}

const updaterApplyRequestSchema = z.object({
  operation_id: z.uuid(),
  target_version: z.string().trim().min(1).max(64),
  previous_version: z.string().trim().min(1).max(64),
  backup_name: z.string().trim().min(1).max(255).nullable().optional(),
}).strict();

export type UpdaterApplyRequest = z.infer<typeof updaterApplyRequestSchema>;

export interface UpdaterOrchestratorOptions {
  readonly docker: DockerClient;
  readonly composeProject: string;
  readonly clock?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly healthCheck?: (inspect: DockerContainerInspect) => Promise<boolean>;
  readonly healthTimeoutMilliseconds?: number;
  readonly healthPollIntervalMilliseconds?: number;
  readonly stopTimeoutSeconds?: number;
}

function tokenDigest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function tokensMatch(supplied: string | undefined, expected: string): boolean {
  if (!supplied || !expected) return false;
  return timingSafeEqual(tokenDigest(supplied), tokenDigest(expected));
}

export function ensureUpdaterToken(tokenFilePath: string): string {
  const fullPath = resolve(tokenFilePath);
  mkdirSync(dirname(fullPath), { recursive: true, mode: 0o755 });
  if (existsSync(fullPath)) {
    const stat = lstatSync(fullPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error("updater token path must be a regular file");
    }
    const existing = readFileSync(fullPath, "utf8").trim();
    if (/^[0-9a-f]{64}$/iu.test(existing)) return existing;
  }
  const generated = randomBytes(32).toString("hex");
  try {
    // Readable inside the private shared volume by the non-root app container (:ro).
    writeFileSync(fullPath, `${generated}\n`, { encoding: "utf8", flag: "wx", mode: 0o644 });
    if (process.platform !== "win32") chmodSync(fullPath, 0o644);
    return generated;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      return readFileSync(fullPath, "utf8").trim();
    }
    throw error;
  }
}

export function canonicalTargetImage(version: string): string {
  if (!parseReleaseVersion(version)) {
    throw new RangeError("目标版本号格式无效");
  }
  return `${OFFICIAL_IMAGE_REPOSITORY}:${version}`;
}

export class UpdaterConflictError extends Error {
  readonly statusCode: 409 | 422;
  readonly code: "update_in_progress" | "operation_conflict" | "validation_failed";

  constructor(statusCode: 409 | 422, code: UpdaterConflictError["code"], message: string) {
    super(message);
    this.name = "UpdaterConflictError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export class UpdaterOrchestrator {
  readonly #docker: DockerClient;
  readonly #project: string;
  readonly #clock: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #healthCheck: (inspect: DockerContainerInspect) => Promise<boolean>;
  readonly #healthTimeoutMs: number;
  readonly #healthPollMs: number;
  readonly #stopTimeoutSec: number;
  readonly #jobs = new Map<string, { request: UpdaterApplyRequest; job: UpdateExecutionJob }>();
  #active: UpdateExecutionJob | null = null;
  #latest: UpdateExecutionJob | null = null;
  #execution: Promise<void> | null = null;

  constructor(options: UpdaterOrchestratorOptions) {
    this.#docker = options.docker;
    this.#project = options.composeProject;
    this.#clock = options.clock ?? Date.now;
    this.#sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.#healthCheck = options.healthCheck ?? defaultAppHealthCheck;
    this.#healthTimeoutMs = options.healthTimeoutMilliseconds ?? 90_000;
    this.#healthPollMs = options.healthPollIntervalMilliseconds ?? 1_500;
    this.#stopTimeoutSec = options.stopTimeoutSeconds ?? 30;
  }

  state(): UpdaterState {
    return { active: this.#active, latest: this.#latest };
  }

  async settled(): Promise<void> {
    await this.#execution;
  }

  start(rawRequest: UpdaterApplyRequest): UpdateExecutionJob {
    if (!parseReleaseVersion(rawRequest.target_version) || !parseReleaseVersion(rawRequest.previous_version)) {
      throw new UpdaterConflictError(422, "validation_failed", "版本号格式无效，仅允许规范的官方发布版本。");
    }
    if (compareReleaseVersions(rawRequest.previous_version, rawRequest.target_version) >= 0) {
      throw new UpdaterConflictError(422, "validation_failed", "在线一键更新仅支持升级到高于当前版本的官方发布版，不支持直接降级。");
    }
    const existing = this.#jobs.get(rawRequest.operation_id);
    if (existing) {
      if (
        existing.request.target_version !== rawRequest.target_version ||
        existing.request.previous_version !== rawRequest.previous_version
      ) {
        throw new UpdaterConflictError(409, "operation_conflict", "此次更新操作参数与已有记录不一致，请刷新后重试。");
      }
      return existing.job;
    }
    if (this.#active) {
      throw new UpdaterConflictError(409, "update_in_progress", "已有在线更新任务正在执行，请等待完成。");
    }
    const job: UpdateExecutionJob = {
      id: rawRequest.operation_id,
      target_version: rawRequest.target_version,
      previous_version: rawRequest.previous_version,
      status: "QUEUED",
      stage: "queued",
      message: `已受理更新任务，准备升级至 v${rawRequest.target_version}`,
      backup_name: rawRequest.backup_name ?? null,
      rolled_back: false,
      started_at: this.#clock(),
      finished_at: null,
      error: null,
    };
    this.#jobs.set(job.id, { request: rawRequest, job });
    while (this.#jobs.size > 20) {
      const oldest = this.#jobs.keys().next().value;
      if (oldest) this.#jobs.delete(oldest);
    }
    this.#active = this.#latest = job;
    this.#execution = new Promise<void>(resolve => setImmediate(resolve)).then(() => this.#run(job));
    return job;
  }

  #updateJob(
    current: UpdateExecutionJob,
    patch: Partial<Pick<UpdateExecutionJob, "status" | "stage" | "message" | "rolled_back" | "finished_at" | "error">>,
  ): UpdateExecutionJob {
    const next: UpdateExecutionJob = { ...current, ...patch };
    const stored = this.#jobs.get(next.id);
    if (stored) stored.job = next;
    if (this.#active?.id === next.id) this.#active = next.status === "SUCCEEDED" || next.status === "FAILED" ? null : next;
    if (this.#latest?.id === next.id) this.#latest = next;
    return next;
  }

  async #run(initialJob: UpdateExecutionJob): Promise<void> {
    let job = this.#updateJob(initialJob, {
      status: "RUNNING",
      stage: "pulling",
      message: `正在拉取官方镜像 ${OFFICIAL_IMAGE_REPOSITORY}:${initialJob.target_version}…`,
    });
    const targetImage = canonicalTargetImage(job.target_version);
    let oldAppInspect: DockerContainerInspect | null = null;
    let oldBackupInspect: DockerContainerInspect | null = null;
    let oldAppRenamedName: string | null = null;
    let newAppId: string | null = null;
    let backupStopped = false;

    try {
      // 1. Pull strictly whitelisted official image & verify it exists locally.
      await this.#docker.pullImage(OFFICIAL_IMAGE_REPOSITORY, job.target_version);
      await this.#docker.inspectImage(targetImage);

      // 2. Discover strictly scoped containers belonging to this compose project.
      const containers = await this.#docker.listProjectContainers(this.#project);
      const appSummary = containers.find(item => item.Labels?.["com.docker.compose.service"] === "app");
      const backupSummary = containers.find(item => item.Labels?.["com.docker.compose.service"] === "backup");
      if (!appSummary) {
        throw new Error(`未在 Compose 项目 "${this.#project}" 中找到 app 服务容器。`);
      }
      oldAppInspect = await this.#docker.inspectContainer(appSummary.Id);
      if (backupSummary) {
        oldBackupInspect = await this.#docker.inspectContainer(backupSummary.Id);
      }

      // 3. Stop backup container first so SQLite readers are quiescent during upgrade.
      if (oldBackupInspect) {
        job = this.#updateJob(job, { stage: "stopping_backup", message: "正在停止备份服务…" });
        await this.#docker.stopContainer(oldBackupInspect.Id, this.#stopTimeoutSec);
        backupStopped = true;
      }

      // 4. Recreate app container while preserving the old container for instant rollback.
      job = this.#updateJob(job, {
        stage: "recreating_app",
        message: `正在重启核心服务并切换至 v${job.target_version}…`,
      });
      const originalAppName = normalizeContainerName(oldAppInspect.Name);
      oldAppRenamedName = `${originalAppName}-rollback-${this.#clock()}`;
      await this.#docker.stopContainer(oldAppInspect.Id, this.#stopTimeoutSec);
      await this.#docker.renameContainer(oldAppInspect.Id, oldAppRenamedName);

      const appSpec = buildRecreateSpec(oldAppInspect, targetImage);
      const createdApp = await this.#docker.createContainer(originalAppName, appSpec.body);
      newAppId = createdApp.Id;
      for (const extra of appSpec.extraNetworks) {
        await this.#docker.connectNetwork(extra.networkName, newAppId, extra.endpointConfig);
      }
      await this.#docker.startContainer(newAppId);

      // 5. Verify new app container starts cleanly and passes /healthz.
      job = this.#updateJob(job, {
        stage: "verifying_health",
        message: `正在等待新版本 v${job.target_version} 启动并通过健康检查…`,
      });
      await this.#waitForHealthyApp(newAppId);

      // 6. Clean up old app container and recreate backup container on the new image.
      await this.#docker.removeContainer(oldAppInspect.Id, false).catch(() => undefined);
      oldAppRenamedName = null;

      if (oldBackupInspect) {
        job = this.#updateJob(job, {
          stage: "recreating_backup",
          message: `核心服务已就绪，正在同步更新备份服务至 v${job.target_version}…`,
        });
        const originalBackupName = normalizeContainerName(oldBackupInspect.Name);
        const backupSpec = buildRecreateSpec(oldBackupInspect, targetImage);
        await this.#docker.removeContainer(oldBackupInspect.Id, false);
        const createdBackup = await this.#docker.createContainer(originalBackupName, backupSpec.body);
        for (const extra of backupSpec.extraNetworks) {
          await this.#docker.connectNetwork(extra.networkName, createdBackup.Id, extra.endpointConfig);
        }
        await this.#docker.startContainer(createdBackup.Id);
      }

      this.#updateJob(job, {
        status: "SUCCEEDED",
        stage: "completed",
        message: `已成功更新至 v${job.target_version}`,
        finished_at: this.#clock(),
        error: null,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "更新执行失败";
      let rolledBack = false;
      let rollbackNote = "";

      if (oldAppInspect && oldAppRenamedName) {
        job = this.#updateJob(job, {
          stage: "rolling_back",
          message: `新版本启动异常，正在自动回滚至 v${job.previous_version}…`,
        });
        try {
          if (newAppId) {
            await this.#docker.stopContainer(newAppId, 15).catch(() => undefined);
            await this.#docker.removeContainer(newAppId, true).catch(() => undefined);
          }
          await this.#docker.renameContainer(oldAppInspect.Id, normalizeContainerName(oldAppInspect.Name));
          await this.#docker.startContainer(oldAppInspect.Id);
          if (oldBackupInspect && backupStopped) {
            await this.#docker.startContainer(oldBackupInspect.Id).catch(() => undefined);
          }
          rolledBack = true;
          rollbackNote = `；已自动回滚至 v${job.previous_version}。`;
        } catch (rollbackError) {
          const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : "未知错误";
          rollbackNote = `；自动回滚也未成功（${rollbackMessage}），请立即在宿主机检查容器状态。`;
        }
      } else if (oldBackupInspect && backupStopped) {
        await this.#docker.startContainer(oldBackupInspect.Id).catch(() => undefined);
      }

      this.#updateJob(job, {
        status: "FAILED",
        stage: "failed",
        message: rolledBack
          ? `更新至 v${job.target_version} 失败，已自动回滚至 v${job.previous_version}`
          : `更新至 v${job.target_version} 失败`,
        rolled_back: rolledBack,
        finished_at: this.#clock(),
        error: `${reason}${rollbackNote}`,
      });
    }
  }

  async #waitForHealthyApp(containerId: string): Promise<void> {
    const deadline = this.#clock() + this.#healthTimeoutMs;
    while (true) {
      const inspect = await this.#docker.inspectContainer(containerId);
      if (inspect.State.Status === "exited" || inspect.State.Status === "dead" || inspect.State.OOMKilled) {
        const tail = await this.#docker.containerLogsTail(containerId, 12).catch(() => "");
        const exitCode = inspect.State.ExitCode ?? "unknown";
        throw new Error(
          `新版本容器启动后异常退出（exit ${exitCode}）${tail ? `：${tail.slice(0, 240)}` : ""}`,
        );
      }
      if (inspect.State.Running && !inspect.State.Restarting) {
        if (inspect.State.Health?.Status === "healthy") return;
        const ok = await this.#healthCheck(inspect).catch(() => false);
        if (ok) return;
      }
      if (this.#clock() >= deadline) {
        throw new Error("新版本容器在超时时间内未通过健康检查");
      }
      await this.#sleep(this.#healthPollMs);
    }
  }
}

async function defaultAppHealthCheck(inspect: DockerContainerInspect): Promise<boolean> {
  const port = readAppPort(inspect.Config.Env);
  const candidates: string[] = [];
  for (const endpoint of Object.values(inspect.NetworkSettings?.Networks ?? {})) {
    if (endpoint.IPAddress) candidates.push(`http://${endpoint.IPAddress}:${port}/healthz`);
  }
  candidates.push(`http://app:${port}/healthz`);
  for (const url of candidates) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return true;
    } catch {
      // Try next address.
    }
  }
  return false;
}

function readAppPort(env: readonly string[] | undefined): number {
  const entry = env?.find(item => item.startsWith("PERPAY_PORT="));
  const parsed = entry ? Number(entry.slice("PERPAY_PORT=".length)) : NaN;
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : 6190;
}

export interface UpdaterServerOptions {
  readonly orchestrator: UpdaterOrchestrator;
  readonly token: string;
  readonly pingDocker?: () => Promise<void>;
}

export function createUpdaterServer(options: UpdaterServerOptions): http.Server {
  return http.createServer(async (request, response) => {
    const sendJson = (statusCode: number, body: unknown) => {
      const payload = Buffer.from(JSON.stringify(body), "utf8");
      response.writeHead(statusCode, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "content-length": payload.byteLength,
      });
      response.end(payload);
    };

    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/healthz") {
      try {
        await options.pingDocker?.();
        sendJson(200, { status: "ok" });
      } catch {
        sendJson(503, { status: "unavailable" });
      }
      return;
    }

    const authorization = request.headers.authorization;
    const suppliedToken = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : undefined;
    if (!tokensMatch(suppliedToken, options.token)) {
      sendJson(401, { error: { code: "unauthorized", message: "更新器鉴权失败" } });
      return;
    }

    if (request.method === "GET" && url.pathname === "/status") {
      sendJson(200, { data: options.orchestrator.state() });
      return;
    }

    if (request.method === "POST" && url.pathname === "/apply") {
      try {
        const rawBody = await readRequestBody(request, 16 * 1024);
        const parsed = updaterApplyRequestSchema.safeParse(JSON.parse(rawBody));
        if (!parsed.success) {
          sendJson(422, { error: { code: "validation_failed", message: "更新请求参数无效" } });
          return;
        }
        const job = options.orchestrator.start(parsed.data);
        sendJson(202, { data: job });
      } catch (error) {
        if (error instanceof UpdaterConflictError) {
          sendJson(error.statusCode, { error: { code: error.code, message: error.message } });
          return;
        }
        sendJson(400, { error: { code: "invalid_json", message: "无法解析更新请求内容" } });
      }
      return;
    }

    sendJson(404, { error: { code: "route_not_found", message: "未找到对应接口" } });
  });
}

function readRequestBody(request: http.IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    request.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        reject(new Error("request body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks, bytes).toString("utf8")));
    request.on("error", reject);
  });
}
