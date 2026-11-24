import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  chownSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { syncDirectory } from "../database/maintenance-lock.ts";
import { compareReleaseVersions, parseReleaseVersion } from "../shared/release-version.ts";
import {
  buildOneOffMaintenanceSpec,
  buildRecreateSpec,
  DockerClient,
  normalizeContainerName,
  type DockerContainerInspect,
  type DockerContainerSummary,
} from "./docker-client.ts";

export const OFFICIAL_IMAGE_REPOSITORY = "ghcr.io/mashiro0619/perpay";
const COMPOSE_PROJECT_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/iu;
const UPDATER_TOKEN_HEX_PATTERN = /^[0-9a-f]{64}$/u;
const UPDATER_TOKEN_MANUAL_PATTERN = /^[\x21-\x7E]{32,256}$/u;
const APP_CONTAINER_UID = 0;
const APP_CONTAINER_GID = 1000;
const MAX_HEALTHZ_BODY_BYTES = 16 * 1024;
export const DEFAULT_UPDATER_HEALTH_TIMEOUT_MS = 360_000;
const DEFAULT_UPDATER_STOP_TIMEOUT_SEC = 30;
const DEFAULT_ROLLBACK_RESTORE_TIMEOUT_MS = 10 * 60_000;
const SCHEMA_MISMATCH_LOG_PATTERN =
  /database contains unknown(?: or renamed)? migration|database schema is newer|database schema \d+ is outside application/iu;
const UNKNOWN_MIGRATION_VERSION_PATTERN = /unknown(?: or renamed)? migration (\d+)/iu;

export function isValidUpdaterToken(value: string): boolean {
  return UPDATER_TOKEN_MANUAL_PATTERN.test(value);
}

export function isOfficialImageReference(image: string | undefined): boolean {
  if (!image) return false;
  return (
    image.startsWith(`${OFFICIAL_IMAGE_REPOSITORY}:`) ||
    image.startsWith(`${OFFICIAL_IMAGE_REPOSITORY}@sha256:`)
  );
}

export async function resolveComposeProject(
  docker: DockerClient,
  explicitProject: string | undefined,
  selfContainerId = hostname(),
): Promise<string> {
  const explicit = explicitProject?.trim();
  if (explicit) {
    if (!COMPOSE_PROJECT_PATTERN.test(explicit)) {
      throw new Error("PERPAY_COMPOSE_PROJECT 格式无效");
    }
    return explicit;
  }
  const containerId = selfContainerId.trim();
  if (!containerId) {
    throw new Error("无法自动识别 Compose 项目名：当前容器主机名为空，请显式设置 PERPAY_COMPOSE_PROJECT。");
  }
  let selfInspect: DockerContainerInspect;
  try {
    selfInspect = await docker.inspectContainer(containerId);
  } catch (error) {
    throw new Error(
      "无法自动识别 Compose 项目名：未能通过 Docker API 读取当前 updater 容器标签，请确认通过 Docker Compose 启动或显式设置 PERPAY_COMPOSE_PROJECT。",
      { cause: error },
    );
  }
  const detected = selfInspect.Config.Labels?.["com.docker.compose.project"]?.trim();
  if (!detected || !COMPOSE_PROJECT_PATTERN.test(detected)) {
    throw new Error("无法自动识别 Compose 项目名：当前容器缺少有效的 com.docker.compose.project 标签。");
  }
  return detected;
}

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

export interface AppMaintenanceProbe {
  readonly active: boolean;
  readonly operation?: string | null;
}

export interface UpdaterOrchestratorOptions {
  readonly docker: DockerClient;
  readonly composeProject: string;
  readonly clock?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly healthCheck?: (inspect: DockerContainerInspect, expectedVersion?: string) => Promise<boolean>;
  readonly checkAppMaintenance?: (inspect: DockerContainerInspect) => Promise<AppMaintenanceProbe>;
  readonly readCurrentVersion?: (inspect: DockerContainerInspect) => Promise<string | null>;
  readonly healthTimeoutMilliseconds?: number;
  readonly healthPollIntervalMilliseconds?: number;
  readonly stopTimeoutSeconds?: number;
  readonly rollbackRestoreTimeoutMilliseconds?: number;
}

function tokenDigest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function tokensMatch(supplied: string | undefined, expected: string): boolean {
  if (!supplied || !expected) return false;
  return timingSafeEqual(tokenDigest(supplied), tokenDigest(expected));
}

function readValidatedTokenFile(fullPath: string): string {
  const stat = lstatSync(fullPath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    throw new Error("updater token path must be a regular non-symlink file");
  }
  if (process.platform !== "win32") {
    if ((stat.mode & 0o027) !== 0) {
      chmodSync(fullPath, 0o640);
    }
    if (process.getuid?.() === 0 && stat.gid !== APP_CONTAINER_GID) {
      try {
        chownSync(fullPath, APP_CONTAINER_UID, APP_CONTAINER_GID);
      } catch {
        console.warn(JSON.stringify({
          level: "warn",
          event: "updater_token_gid_mismatch",
          path: fullPath,
          actual_gid: stat.gid,
          expected_gid: APP_CONTAINER_GID,
          hint: "Set updater container user to 0:1000 so the app (node) container can read the 0640 token file under cap_drop: ALL.",
        }));
      }
    }
  }
  const existing = readFileSync(fullPath, "utf8").trim();
  if (!UPDATER_TOKEN_HEX_PATTERN.test(existing)) {
    throw new Error("updater token file must contain 64 lowercase hexadecimal characters");
  }
  return existing;
}

export function ensureUpdaterToken(tokenFilePath: string): string {
  const fullPath = resolve(tokenFilePath);
  const directory = dirname(fullPath);
  mkdirSync(directory, { recursive: true, mode: 0o750 });
  if (process.platform !== "win32" && process.getuid?.() === 0) {
    try { chownSync(directory, APP_CONTAINER_UID, APP_CONTAINER_GID); } catch { /* ignore */ }
  }
  if (existsSync(fullPath)) {
    return readValidatedTokenFile(fullPath);
  }
  const generated = randomBytes(32).toString("hex");
  const temporary = `${fullPath}.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temporary, `${generated}\n`, { encoding: "utf8", flag: "wx", mode: 0o640 });
  try {
    if (process.platform !== "win32") {
      chmodSync(temporary, 0o640);
      if (process.getuid?.() === 0) {
        try { chownSync(temporary, APP_CONTAINER_UID, APP_CONTAINER_GID); } catch { /* ignore */ }
      }
      const handle = openSync(temporary, "r");
      try { fsyncSync(handle); } finally { closeSync(handle); }
    }
    try {
      linkSync(temporary, fullPath);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
  } finally {
    try { unlinkSync(temporary); } catch { /* ignore */ }
  }
  syncDirectory(directory);
  return readValidatedTokenFile(fullPath);
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

class RollbackSchemaMismatchError extends Error {
  readonly logs: string;

  constructor(message: string, logs: string) {
    super(message);
    this.name = "RollbackSchemaMismatchError";
    this.logs = logs;
  }
}

export function resolveHealthTimeoutMilliseconds(
  baseTimeoutMs: number,
  inspect: DockerContainerInspect | null,
): number {
  const healthcheck = inspect?.Config.Healthcheck;
  if (!healthcheck || typeof healthcheck !== "object") return baseTimeoutMs;
  const startPeriodNs =
    typeof healthcheck.StartPeriod === "number" && Number.isFinite(healthcheck.StartPeriod) && healthcheck.StartPeriod > 0
      ? healthcheck.StartPeriod
      : 0;
  if (startPeriodNs <= 0) return baseTimeoutMs;
  const intervalNs =
    typeof healthcheck.Interval === "number" && Number.isFinite(healthcheck.Interval) && healthcheck.Interval > 0
      ? healthcheck.Interval
      : 0;
  const retries =
    typeof healthcheck.Retries === "number" && Number.isFinite(healthcheck.Retries) && healthcheck.Retries > 0
      ? Math.trunc(healthcheck.Retries)
      : 0;
  const startPeriodMs = Math.ceil(startPeriodNs / 1_000_000);
  const probeAllowanceMs = intervalNs > 0
    ? Math.ceil(intervalNs / 1_000_000) * Math.max(1, Math.min(retries || 2, 5))
    : 60_000;
  return Math.max(baseTimeoutMs, startPeriodMs + Math.max(30_000, probeAllowanceMs));
}

export function resolveStopTimeoutSeconds(
  fallbackSeconds: number,
  inspect: DockerContainerInspect | null,
): number {
  const configured = inspect?.Config.StopTimeout;
  if (typeof configured === "number" && Number.isFinite(configured) && configured > 0) {
    return Math.max(fallbackSeconds, Math.trunc(configured));
  }
  return fallbackSeconds;
}

export class UpdaterOrchestrator {
  readonly #docker: DockerClient;
  readonly #project: string;
  readonly #clock: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #healthCheck: (inspect: DockerContainerInspect, expectedVersion?: string) => Promise<boolean>;
  readonly #checkAppMaintenance: (inspect: DockerContainerInspect) => Promise<AppMaintenanceProbe>;
  readonly #readCurrentVersion: ((inspect: DockerContainerInspect) => Promise<string | null>) | undefined;
  readonly #healthTimeoutMs: number;
  readonly #healthPollMs: number;
  readonly #stopTimeoutSec: number;
  readonly #rollbackRestoreTimeoutMs: number;
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
    this.#checkAppMaintenance = options.checkAppMaintenance ?? (
      options.healthCheck ? (async () => ({ active: false, operation: null })) : defaultAppMaintenanceCheck
    );
    this.#readCurrentVersion = options.readCurrentVersion;
    this.#healthTimeoutMs = options.healthTimeoutMilliseconds ?? DEFAULT_UPDATER_HEALTH_TIMEOUT_MS;
    this.#healthPollMs = options.healthPollIntervalMilliseconds ?? 1_500;
    this.#stopTimeoutSec = options.stopTimeoutSeconds ?? DEFAULT_UPDATER_STOP_TIMEOUT_SEC;
    this.#rollbackRestoreTimeoutMs = options.rollbackRestoreTimeoutMilliseconds ?? DEFAULT_ROLLBACK_RESTORE_TIMEOUT_MS;
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
    patch: Partial<Pick<UpdateExecutionJob, "previous_version" | "status" | "stage" | "message" | "rolled_back" | "finished_at" | "error">>,
  ): UpdateExecutionJob {
    const next: UpdateExecutionJob = { ...current, ...patch };
    const stored = this.#jobs.get(next.id);
    if (stored) stored.job = next;
    if (this.#active?.id === next.id) this.#active = next.status === "SUCCEEDED" || next.status === "FAILED" ? null : next;
    if (this.#latest?.id === next.id) this.#latest = next;
    return next;
  }

  async #resolveAuthoritativeAppVersion(inspect: DockerContainerInspect): Promise<string | null> {
    if (this.#readCurrentVersion) {
      const custom = await this.#readCurrentVersion(inspect);
      return custom && parseReleaseVersion(custom) ? custom : null;
    }
    const labelVersion = inspect.Config.Labels?.["org.opencontainers.image.version"]?.trim();
    if (labelVersion && parseReleaseVersion(labelVersion)) return labelVersion;
    const prefix = `${OFFICIAL_IMAGE_REPOSITORY}:`;
    if (inspect.Config.Image.startsWith(prefix)) {
      const tag = inspect.Config.Image.slice(prefix.length).trim();
      if (tag && parseReleaseVersion(tag)) return tag;
    }
    if (inspect.State.Running) {
      const probed = await probeAppHealth(inspect);
      if (probed.version && parseReleaseVersion(probed.version)) return probed.version;
    }
    return null;
  }

  async #run(initialJob: UpdateExecutionJob): Promise<void> {
    let job = this.#updateJob(initialJob, {
      status: "RUNNING",
      stage: "pulling",
      message: `正在校验运行中的容器并准备拉取 ${OFFICIAL_IMAGE_REPOSITORY}:${initialJob.target_version}…`,
    });
    const targetImage = canonicalTargetImage(job.target_version);
    let oldAppInspect: DockerContainerInspect | null = null;
    let oldBackupInspect: DockerContainerInspect | null = null;
    let authoritativePreviousVersion = job.previous_version;
    let backupWasRunning = false;
    let backupStopped = false;
    let oldBackupRenamed = false;
    let newBackupId: string | null = null;
    let oldAppStopped = false;
    let oldAppRenamed = false;
    let newAppId: string | null = null;
    let appSwitched = false;
    let upgradeCutoverAt = this.#clock();

    try {
      // 1. Discover strictly scoped containers and verify authoritative running version BEFORE pulling or stopping anything.
      const containers = await this.#docker.listProjectContainers(this.#project);
      const appSummary = selectServiceContainer(containers, this.#project, "app", true);
      const backupSummary = selectServiceContainer(containers, this.#project, "backup", false);
      oldAppInspect = await this.#docker.inspectContainer(appSummary.Id);
      if (!isOfficialImageReference(oldAppInspect.Config.Image)) {
        throw new Error(`当前 app 容器镜像不是官方仓库 ${OFFICIAL_IMAGE_REPOSITORY}，已拒绝在线更新。`);
      }
      if (backupSummary) {
        oldBackupInspect = await this.#docker.inspectContainer(backupSummary.Id);
        if (!isOfficialImageReference(oldBackupInspect.Config.Image)) {
          throw new Error(`当前 backup 容器镜像不是官方仓库 ${OFFICIAL_IMAGE_REPOSITORY}，已拒绝在线更新。`);
        }
        backupWasRunning = oldBackupInspect.State.Running === true;
      }

      const actualVersion = await this.#resolveAuthoritativeAppVersion(oldAppInspect);
      if (!actualVersion) {
        throw new Error("无法核实当前运行中 app 容器的真实版本，为防止降级已中止更新。");
      }
      authoritativePreviousVersion = actualVersion;
      if (compareReleaseVersions(actualVersion, job.target_version) >= 0) {
        throw new Error(`当前运行版本为 v${actualVersion}，拒绝降级或重复覆盖至 v${job.target_version}。`);
      }
      if (actualVersion !== job.previous_version) {
        job = this.#updateJob(job, { previous_version: actualVersion });
      }

      if (oldAppInspect.State.Running) {
        const prePullMaintenance = await this.#checkAppMaintenance(oldAppInspect);
        if (prePullMaintenance.active) {
          throw new Error("检测到应用正在执行维护任务，为防止中断维护已中止本次在线更新，请等待维护完成后重试。");
        }
      }

      // 2. Pull strictly whitelisted official image & verify it exists locally.
      job = this.#updateJob(job, {
        stage: "pulling",
        message: `正在拉取官方镜像 ${OFFICIAL_IMAGE_REPOSITORY}:${job.target_version}…`,
      });
      await this.#docker.pullImage(OFFICIAL_IMAGE_REPOSITORY, job.target_version);
      await this.#docker.inspectImage(targetImage);

      // Re-inspect app and re-check maintenance state immediately before stopping containers
      // so a restore/archive started during the image pull window is never interrupted.
      oldAppInspect = await this.#docker.inspectContainer(oldAppInspect.Id);
      if (oldAppInspect.State.Running) {
        const postPullMaintenance = await this.#checkAppMaintenance(oldAppInspect);
        if (postPullMaintenance.active) {
          throw new Error("检测到应用在拉取镜像期间启动了维护任务，为防止中断维护已中止本次在线更新，请等待维护完成后重试。");
        }
      }
      if (oldBackupInspect) {
        oldBackupInspect = await this.#docker.inspectContainer(oldBackupInspect.Id);
        backupWasRunning = oldBackupInspect.State.Running === true;
      }

      // 3. Stop running backup container first so SQLite readers are quiescent during upgrade.
      if (oldBackupInspect && backupWasRunning) {
        job = this.#updateJob(job, { stage: "stopping_backup", message: "正在停止备份服务…" });
        await this.#docker.stopContainer(
          oldBackupInspect.Id,
          resolveStopTimeoutSeconds(this.#stopTimeoutSec, oldBackupInspect),
        );
        backupStopped = true;
      }

      // 4. Recreate app container while preserving the old container for instant rollback.
      job = this.#updateJob(job, {
        stage: "recreating_app",
        message: `正在重启核心服务并切换至 v${job.target_version}…`,
      });
      const originalAppName = normalizeContainerName(oldAppInspect.Name);
      const rollbackAppName = `${originalAppName}-rollback-${this.#clock()}`;
      await this.#docker.stopContainer(
        oldAppInspect.Id,
        resolveStopTimeoutSeconds(this.#stopTimeoutSec, oldAppInspect),
      );
      oldAppStopped = true;
      await this.#docker.renameContainer(oldAppInspect.Id, rollbackAppName);
      oldAppRenamed = true;

      upgradeCutoverAt = this.#clock();
      const appSpec = buildRecreateSpec(oldAppInspect, targetImage);
      const createdApp = await this.#docker.createContainer(originalAppName, appSpec.body);
      newAppId = createdApp.Id;
      for (const extra of appSpec.extraNetworks) {
        await this.#docker.connectNetwork(extra.networkName, newAppId, extra.endpointConfig);
      }
      await this.#docker.startContainer(newAppId);

      // 5. Verify new app container starts cleanly and passes /healthz on target_version.
      job = this.#updateJob(job, {
        stage: "verifying_health",
        message: `正在等待新版本 v${job.target_version} 启动并通过健康检查…`,
      });
      await this.#waitForHealthyApp(newAppId, job.target_version, oldAppInspect);

      // 6. Clean up old app container and atomically recreate backup container on the new image.
      await this.#docker.removeContainer(oldAppInspect.Id, false).catch(() => undefined);
      appSwitched = true;
      oldAppRenamed = false;
      oldAppStopped = false;

      if (oldBackupInspect) {
        job = this.#updateJob(job, {
          stage: "recreating_backup",
          message: `核心服务已就绪，正在同步更新备份服务至 v${job.target_version}…`,
        });
        const originalBackupName = normalizeContainerName(oldBackupInspect.Name);
        const rollbackBackupName = `${originalBackupName}-rollback-${this.#clock()}`;
        const backupSpec = buildRecreateSpec(oldBackupInspect, targetImage);
        await this.#docker.renameContainer(oldBackupInspect.Id, rollbackBackupName);
        oldBackupRenamed = true;
        const createdBackup = await this.#docker.createContainer(originalBackupName, backupSpec.body);
        newBackupId = createdBackup.Id;
        for (const extra of backupSpec.extraNetworks) {
          await this.#docker.connectNetwork(extra.networkName, newBackupId, extra.endpointConfig);
        }
        if (backupWasRunning) {
          await this.#docker.startContainer(newBackupId);
        }
        await this.#docker.removeContainer(oldBackupInspect.Id, false).catch(() => undefined);
        oldBackupRenamed = false;
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
      let failureSummary = `更新至 v${job.target_version} 失败`;

      if (appSwitched) {
        // Core app is already live on target_version; recover backup container non-destructively.
        let backupRestored = false;
        try {
          if (newBackupId) {
            await this.#docker.stopContainer(newBackupId, 15).catch(() => undefined);
            await this.#docker.removeContainer(newBackupId, true).catch(() => undefined);
          }
          if (oldBackupInspect) {
            if (oldBackupRenamed) {
              await this.#docker.renameContainer(oldBackupInspect.Id, normalizeContainerName(oldBackupInspect.Name));
            }
            if (backupWasRunning) {
              await this.#docker.startContainer(oldBackupInspect.Id);
            }
            backupRestored = true;
          }
        } catch (backupRestoreError) {
          const msg = backupRestoreError instanceof Error ? backupRestoreError.message : "未知错误";
          rollbackNote = `；原备份容器恢复未成功（${msg}），请在宿主机检查 backup 容器状态。`;
        }
        if (backupRestored) {
          rollbackNote = "；核心服务已运行在新版本，原备份容器已恢复，请稍后手动重建 backup 容器。";
        }
        failureSummary = `核心服务已切换至 v${job.target_version}，但备份服务更新失败`;
      } else if (oldAppInspect && (oldAppStopped || oldAppRenamed || newAppId)) {
        job = this.#updateJob(job, {
          stage: "rolling_back",
          message: `新版本启动异常，正在自动回滚至 v${authoritativePreviousVersion}…`,
        });
        try {
          if (newAppId) {
            await this.#docker.stopContainer(newAppId, 15).catch(() => undefined);
            await this.#docker.removeContainer(newAppId, true).catch(() => undefined);
          }
          if (oldAppRenamed) {
            await this.#docker.renameContainer(oldAppInspect.Id, normalizeContainerName(oldAppInspect.Name));
          }
          const preRollbackInspect = await this.#docker.inspectContainer(oldAppInspect.Id).catch(() => oldAppInspect!);
          const baselineRestarts = preRollbackInspect.RestartCount ?? 0;
          await this.#docker.startContainer(oldAppInspect.Id);
          try {
            await this.#verifyRollbackAppHealthy(
              oldAppInspect.Id,
              authoritativePreviousVersion,
              preRollbackInspect,
              baselineRestarts,
            );
            rolledBack = true;
            rollbackNote = `；已自动回滚至 v${authoritativePreviousVersion}。`;
          } catch (firstRollbackError) {
            if (!(firstRollbackError instanceof RollbackSchemaMismatchError)) {
              throw firstRollbackError;
            }
            job = this.#updateJob(job, {
              stage: "rolling_back",
              message: `检测到数据库架构已推进，正在通过旧版本隔离维护容器自动恢复迁移前快照…`,
            });
            await this.#docker.stopContainer(oldAppInspect.Id, 15).catch(() => undefined);
            const restoredBackupName = await this.#restorePreMigrationDatabase(
              oldAppInspect,
              upgradeCutoverAt,
              firstRollbackError.logs,
            );
            const postRestoreInspect = await this.#docker.inspectContainer(oldAppInspect.Id).catch(() => oldAppInspect!);
            await this.#docker.startContainer(oldAppInspect.Id);
            await this.#verifyRollbackAppHealthy(
              oldAppInspect.Id,
              authoritativePreviousVersion,
              postRestoreInspect,
              postRestoreInspect.RestartCount ?? 0,
            );
            rolledBack = true;
            rollbackNote = restoredBackupName
              ? `；已自动恢复迁移前数据库快照（${restoredBackupName}）并回滚至 v${authoritativePreviousVersion}。`
              : `；已自动恢复迁移前数据库快照并回滚至 v${authoritativePreviousVersion}。`;
          }
        } catch (rollbackError) {
          const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : "未知错误";
          rollbackNote = `；自动回滚也未成功（${rollbackMessage}），请立即在宿主机检查容器状态。`;
        }
        if (oldBackupInspect && backupWasRunning && backupStopped) {
          try {
            await this.#docker.startContainer(oldBackupInspect.Id);
          } catch (backupError) {
            const msg = backupError instanceof Error ? backupError.message : "未知错误";
            rollbackNote += `（原备份服务未能自动重启：${msg}）`;
          }
        }
        if (rolledBack) {
          failureSummary = `更新至 v${job.target_version} 失败，已自动回滚至 v${authoritativePreviousVersion}`;
        }
      } else if (oldBackupInspect && backupWasRunning && backupStopped) {
        await this.#docker.startContainer(oldBackupInspect.Id).catch(() => undefined);
      }

      this.#updateJob(job, {
        status: "FAILED",
        stage: "failed",
        message: failureSummary,
        rolled_back: rolledBack,
        finished_at: this.#clock(),
        error: `${reason}${rollbackNote}`,
      });
    }
  }

  async #waitForHealthyApp(
    containerId: string,
    expectedVersion: string,
    fallbackInspect: DockerContainerInspect | null = null,
  ): Promise<void> {
    const startedAt = this.#clock();
    let effectiveTimeoutMs = resolveHealthTimeoutMilliseconds(this.#healthTimeoutMs, fallbackInspect);
    while (true) {
      const inspect = await this.#docker.inspectContainer(containerId);
      effectiveTimeoutMs = Math.max(
        effectiveTimeoutMs,
        resolveHealthTimeoutMilliseconds(this.#healthTimeoutMs, inspect),
      );
      const crashed =
        inspect.State.Status === "exited" ||
        inspect.State.Status === "dead" ||
        inspect.State.OOMKilled === true ||
        inspect.State.Restarting === true ||
        (inspect.RestartCount ?? 0) > 0;
      if (crashed) {
        const tail = await this.#docker.containerLogsTail(containerId, 12).catch(() => "");
        const exitCode = inspect.State.ExitCode ?? "unknown";
        const detail = inspect.State.Restarting || (inspect.RestartCount ?? 0) > 0
          ? `新版本容器启动后崩溃重启（restarts=${inspect.RestartCount ?? 1}, exit ${exitCode}）`
          : `新版本容器启动后异常退出（exit ${exitCode}）`;
        throw new Error(`${detail}${tail ? `：${tail.slice(0, 240)}` : ""}`);
      }
      if (inspect.State.Health?.Status === "unhealthy") {
        const tail = await this.#docker.containerLogsTail(containerId, 12).catch(() => "");
        throw new Error(`新版本容器健康检查持续失败（unhealthy）${tail ? `：${tail.slice(0, 240)}` : ""}`);
      }
      if (inspect.State.Running && !inspect.State.Restarting) {
        const ok = await this.#healthCheck(inspect, expectedVersion).catch(() => false);
        if (ok) return;
      }
      if (this.#clock() - startedAt >= effectiveTimeoutMs) {
        throw new Error("新版本容器在超时时间内未通过健康检查");
      }
      await this.#sleep(this.#healthPollMs);
    }
  }

  async #verifyRollbackAppHealthy(
    containerId: string,
    expectedVersion: string,
    fallbackInspect: DockerContainerInspect | null = null,
    baselineRestartCount = 0,
  ): Promise<void> {
    const startedAt = this.#clock();
    let effectiveTimeoutMs = resolveHealthTimeoutMilliseconds(this.#healthTimeoutMs, fallbackInspect);
    while (true) {
      const inspect = await this.#docker.inspectContainer(containerId);
      effectiveTimeoutMs = Math.max(
        effectiveTimeoutMs,
        resolveHealthTimeoutMilliseconds(this.#healthTimeoutMs, inspect),
      );
      const crashed =
        inspect.State.Status === "exited" ||
        inspect.State.Status === "dead" ||
        inspect.State.OOMKilled === true ||
        inspect.State.Restarting === true ||
        (inspect.RestartCount ?? 0) > baselineRestartCount;
      if (crashed) {
        const tail = await this.#docker.containerLogsTail(containerId, 20).catch(() => "");
        const message = `原版本容器回滚后异常退出（exit ${inspect.State.ExitCode ?? "unknown"}）`;
        if (SCHEMA_MISMATCH_LOG_PATTERN.test(tail)) {
          throw new RollbackSchemaMismatchError(message, tail);
        }
        throw new Error(`${message}${tail ? `：${tail.slice(0, 240)}` : ""}`);
      }
      if (inspect.State.Health?.Status === "unhealthy") {
        const tail = await this.#docker.containerLogsTail(containerId, 20).catch(() => "");
        throw new Error(`原版本容器回滚后健康检查失败（unhealthy）${tail ? `：${tail.slice(0, 240)}` : ""}`);
      }
      if (inspect.State.Running && !inspect.State.Restarting) {
        if (inspect.State.Health?.Status === "healthy") return;
        const ok = await this.#healthCheck(inspect, expectedVersion).catch(() => false);
        if (ok) return;
      }
      if (this.#clock() - startedAt >= effectiveTimeoutMs) {
        throw new Error("原版本容器回滚后未通过健康检查");
      }
      await this.#sleep(this.#healthPollMs);
    }
  }

  async #runOneOffMaintenance(
    oldAppInspect: DockerContainerInspect,
    suffix: string,
    cmd: readonly string[],
  ): Promise<{ readonly exitCode: number; readonly stdout: string; readonly logs: string }> {
    const baseName = normalizeContainerName(oldAppInspect.Name);
    const oneOffName = `${baseName}-rollback-db-${suffix}-${this.#clock()}`;
    const spec = buildOneOffMaintenanceSpec(oldAppInspect, cmd);
    const created = await this.#docker.createContainer(oneOffName, spec);
    try {
      await this.#docker.startContainer(created.Id);
      const waited = await this.#docker.waitContainer(created.Id, this.#rollbackRestoreTimeoutMs);
      const stdout = await this.#docker.containerLogsTail(created.Id, 100, { stdoutOnly: true }).catch(() => "");
      const logs = await this.#docker.containerLogsTail(created.Id, 40).catch(() => stdout);
      return { exitCode: waited.StatusCode, stdout, logs };
    } finally {
      await this.#docker.stopContainer(created.Id, 10).catch(() => undefined);
      await this.#docker.removeContainer(created.Id, true).catch(() => undefined);
    }
  }

  async #restorePreMigrationDatabase(
    oldAppInspect: DockerContainerInspect,
    upgradeCutoverAt: number,
    schemaMismatchLogs: string,
  ): Promise<string | null> {
    const minMtimeMs = Math.max(0, upgradeCutoverAt - 5_000);
    const direct = await this.#runOneOffMaintenance(oldAppInspect, "restore", [
      "node",
      "dist/database/maintenance.js",
      "rollback-failed-migration",
      "--since-ms",
      String(minMtimeMs),
      "--confirm-replace-current-database",
    ]);
    if (direct.exitCode === 0) {
      return parseRestoredBackupName(direct.stdout);
    }

    // Legacy old-image compatibility: older releases expose list-migration-backups + restore-migration-backup
    // instead of rollback-failed-migration.
    if (/usage:\s*maintenance\b/iu.test(direct.logs)) {
      const rejectedVersionMatch = UNKNOWN_MIGRATION_VERSION_PATTERN.exec(schemaMismatchLogs);
      const rejectedVersion = rejectedVersionMatch ? Number(rejectedVersionMatch[1]) : null;
      const listed = await this.#runOneOffMaintenance(oldAppInspect, "list", [
        "node",
        "dist/database/maintenance.js",
        "list-migration-backups",
      ]);
      if (listed.exitCode === 0) {
        const candidate = selectLegacyMigrationBackup(listed.stdout, rejectedVersion);
        if (candidate) {
          const legacyRestore = await this.#runOneOffMaintenance(oldAppInspect, "legacy-restore", [
            "node",
            "dist/database/maintenance.js",
            "restore-migration-backup",
            candidate.name,
            "--confirm-replace-current-database",
          ]);
          if (legacyRestore.exitCode === 0) {
            return candidate.name;
          }
          throw new Error(
            `自动恢复迁移前快照 ${candidate.name} 失败（exit ${legacyRestore.exitCode}）${legacyRestore.logs ? `：${legacyRestore.logs.slice(0, 240)}` : ""}；请在宿主机手动执行 restore-migration-backup`,
          );
        }
      }
    }

    throw new Error(
      `自动恢复迁移前数据库快照失败（exit ${direct.exitCode}）${direct.logs ? `：${direct.logs.slice(0, 240)}` : ""}；请在宿主机通过 maintenance 容器执行 list-migration-backups 与 restore-migration-backup 恢复`,
    );
  }
}

function parseRestoredBackupName(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/u).reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as { backupName?: unknown };
      if (typeof parsed.backupName === "string" && parsed.backupName.length > 0) return parsed.backupName;
    } catch {
      // Ignore non-JSON lines.
    }
  }
  return null;
}

function selectLegacyMigrationBackup(
  stdout: string,
  rejectedVersion: number | null,
): { readonly name: string; readonly fromVersion: number; readonly toVersion: number } | null {
  if (rejectedVersion === null || !Number.isSafeInteger(rejectedVersion) || rejectedVersion < 2) {
    return null;
  }
  for (const line of stdout.split(/\r?\n/u).reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as {
        backups?: Array<{ name?: unknown; fromVersion?: unknown; toVersion?: unknown }>;
      };
      if (!Array.isArray(parsed.backups)) continue;
      const valid = parsed.backups.filter(
        (item): item is { name: string; fromVersion: number; toVersion: number } =>
          typeof item?.name === "string" &&
          typeof item.fromVersion === "number" &&
          typeof item.toVersion === "number" &&
          item.fromVersion < rejectedVersion &&
          item.toVersion >= rejectedVersion,
      );
      if (valid.length === 0) return null;
      valid.sort((a, b) => b.fromVersion - a.fromVersion || b.toVersion - a.toVersion);
      const top = valid[0]!;
      // Only proceed automatically when the highest pre-migration source version is unambiguous.
      if (valid.length > 1 && valid[1]!.fromVersion === top.fromVersion) return null;
      return top;
    } catch {
      // Try earlier lines.
    }
  }
  return null;
}

function selectServiceContainer(
  containers: readonly DockerContainerSummary[],
  project: string,
  service: "app" | "backup",
  required: true,
): DockerContainerSummary;
function selectServiceContainer(
  containers: readonly DockerContainerSummary[],
  project: string,
  service: "app" | "backup",
  required: false,
): DockerContainerSummary | null;
function selectServiceContainer(
  containers: readonly DockerContainerSummary[],
  project: string,
  service: "app" | "backup",
  required: boolean,
): DockerContainerSummary | null {
  const candidates = containers.filter(item => {
    if (item.Labels?.["com.docker.compose.project"] !== project) return false;
    if (item.Labels?.["com.docker.compose.service"] !== service) return false;
    if (item.Labels?.["com.docker.compose.oneoff"]?.toLowerCase() === "true") return false;
    if ((item.Names ?? []).some(name => /-rollback-\d+$/u.test(normalizeContainerName(name)))) return false;
    return true;
  });
  if (candidates.length > 1) {
    throw new Error(`Compose 项目 "${project}" 中存在多个 ${service} 服务容器（${candidates.length} 个），为防止误操作已中止更新。`);
  }
  const selected = candidates[0] ?? null;
  if (!selected && required) {
    throw new Error(`未在 Compose 项目 "${project}" 中找到 ${service} 服务容器。`);
  }
  return selected;
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string | null> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(next.value);
    }
    return Buffer.concat(chunks, total).toString("utf8");
  } finally {
    reader.releaseLock();
  }
}

async function probeAppHealth(
  inspect: DockerContainerInspect,
): Promise<{
  readonly healthy: boolean;
  readonly maintenance: boolean;
  readonly maintenanceOperation: string | null;
  readonly version: string | null;
}> {
  const port = readAppPort(inspect.Config.Env);
  // Probe Compose service DNS first (resolves directly on the shared updater network),
  // then fall back to container IPs without blocking 2s on unreachable non-shared bridge IPs first.
  const candidates: string[] = [`http://app:${port}/healthz`];
  for (const endpoint of Object.values(inspect.NetworkSettings?.Networks ?? {})) {
    if (endpoint.IPAddress) candidates.push(`http://${endpoint.IPAddress}:${port}/healthz`);
  }
  for (const url of candidates) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(2_000),
        redirect: "error",
        cache: "no-store",
      });
      if (!response.ok && response.status !== 503) {
        await response.body?.cancel().catch(() => undefined);
        continue;
      }
      const raw = await readBoundedText(response, MAX_HEALTHZ_BODY_BYTES);
      if (!raw) continue;
      const parsed = JSON.parse(raw) as {
        status?: unknown;
        operation?: unknown;
        version?: unknown;
        database?: { result?: unknown } | null;
      };
      if (parsed.status === "maintenance") {
        return {
          healthy: false,
          maintenance: true,
          maintenanceOperation: typeof parsed.operation === "string" ? parsed.operation : null,
          version: null,
        };
      }
      if (parsed.database && typeof parsed.database === "object" && parsed.database.result === "database_maintenance_in_progress") {
        return {
          healthy: false,
          maintenance: true,
          maintenanceOperation: "DATABASE_MAINTENANCE",
          version: null,
        };
      }
      if (response.ok && parsed.status === "healthy") {
        const version = typeof parsed.version === "string" && parseReleaseVersion(parsed.version)
          ? parsed.version
          : null;
        return { healthy: true, maintenance: false, maintenanceOperation: null, version };
      }
    } catch {
      // Try next address.
    }
  }
  return { healthy: false, maintenance: false, maintenanceOperation: null, version: null };
}

async function defaultAppMaintenanceCheck(
  inspect: DockerContainerInspect,
): Promise<AppMaintenanceProbe> {
  const result = await probeAppHealth(inspect);
  return { active: result.maintenance, operation: result.maintenanceOperation };
}

async function defaultAppHealthCheck(
  inspect: DockerContainerInspect,
  expectedVersion?: string,
): Promise<boolean> {
  const result = await probeAppHealth(inspect);
  if (!result.healthy) return false;
  if (expectedVersion && result.version !== expectedVersion) return false;
  return true;
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

class RequestBodyTooLargeError extends Error {
  constructor() {
    super("request body too large");
    this.name = "RequestBodyTooLargeError";
  }
}

export function createUpdaterServer(options: UpdaterServerOptions): http.Server {
  return http.createServer((request, response) => {
    void (async () => {
      const sendJson = (statusCode: number, body: unknown, closeConnection = false) => {
        if (response.headersSent || response.writableEnded) return;
        const payload = Buffer.from(JSON.stringify(body), "utf8");
        response.writeHead(statusCode, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "content-length": payload.byteLength,
          ...(closeConnection ? { connection: "close" } : {}),
        });
        response.end(payload);
      };

      try {
        let url: URL;
        try {
          url = new URL(request.url ?? "/", "http://127.0.0.1");
        } catch {
          sendJson(400, { error: { code: "invalid_request", message: "请求路径格式无效" } }, true);
          return;
        }

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
            if (error instanceof RequestBodyTooLargeError) {
              sendJson(413, { error: { code: "payload_too_large", message: "更新请求体过大" } }, true);
              return;
            }
            if (error instanceof UpdaterConflictError) {
              sendJson(error.statusCode, { error: { code: error.code, message: error.message } });
              return;
            }
            sendJson(400, { error: { code: "invalid_json", message: "无法解析更新请求内容" } });
          }
          return;
        }

        sendJson(404, { error: { code: "route_not_found", message: "未找到对应接口" } });
      } catch {
        sendJson(500, { error: { code: "internal_error", message: "更新器内部处理异常" } }, true);
      }
    })();
  });
}

function readRequestBody(request: http.IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    request.on("data", (chunk: Buffer) => {
      if (settled) return;
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        settled = true;
        request.pause();
        reject(new RequestBodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, bytes).toString("utf8"));
    });
    request.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}
