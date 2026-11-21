import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { z } from "zod";
import type { UpdaterConfig } from "../config.ts";
import type { HttpErrorCode } from "../http/error-codes.ts";
import type { MaintenanceController, MaintenanceObserver } from "../maintenance/controller.ts";
import { compareReleaseVersions, parseReleaseVersion } from "../shared/release-version.ts";
import { APP_VERSION } from "../version.ts";
import type { UpdateExecutionJob, UpdaterApplyRequest, UpdaterState } from "./updater-core.ts";

export const selfUpdateApplyRequestSchema = z.object({
  operation_id: z.uuid(),
  target_version: z.string().trim().min(1).max(64),
  create_backup: z.boolean().default(true),
}).strict();

export type SelfUpdateApplyRequest = z.infer<typeof selfUpdateApplyRequestSchema>;

export type SelfUpdateUnavailableReason = "demo_read_only" | "not_configured" | "unreachable" | null;

export interface SelfUpdateStatus {
  readonly enabled: boolean;
  readonly unavailable_reason: SelfUpdateUnavailableReason;
  readonly current_version: string;
  readonly can_backup: boolean;
  readonly active_job: UpdateExecutionJob | null;
  readonly latest_job: UpdateExecutionJob | null;
}

export interface UpdaterClient {
  status(): Promise<UpdaterState>;
  apply(request: UpdaterApplyRequest): Promise<UpdateExecutionJob>;
}

export class SelfUpdateError extends Error {
  readonly status: 403 | 409 | 422 | 503;
  readonly code: Extract<
    HttpErrorCode,
    | "demo_read_only"
    | "self_update_unavailable"
    | "update_in_progress"
    | "operation_conflict"
    | "validation_failed"
    | "maintenance_in_progress"
  >;

  constructor(status: SelfUpdateError["status"], code: SelfUpdateError["code"], message: string) {
    super(message);
    this.name = "SelfUpdateError";
    this.status = status;
    this.code = code;
  }
}

export interface SelfUpdateServiceOptions {
  readonly updaterConfig?: UpdaterConfig | null | undefined;
  readonly updaterClient?: UpdaterClient | undefined;
  readonly maintenance?: MaintenanceController | undefined;
  readonly demoMode?: boolean | undefined;
  readonly currentVersion?: string | undefined;
  readonly clock?: (() => number) | undefined;
}

interface StoredLocalRequest {
  readonly request: SelfUpdateApplyRequest;
  job: UpdateExecutionJob;
  handedOff: boolean;
}

export class SelfUpdateService {
  readonly #client: UpdaterClient | null;
  readonly #maintenance: MaintenanceController | undefined;
  readonly #demoMode: boolean;
  readonly #currentVersion: string;
  readonly #clock: () => number;
  readonly #requests = new Map<string, StoredLocalRequest>();
  #localActive: UpdateExecutionJob | null = null;
  #localLatest: UpdateExecutionJob | null = null;
  #handoffExecution: Promise<void> | null = null;

  constructor(options: SelfUpdateServiceOptions = {}) {
    this.#client = options.updaterClient ?? (options.updaterConfig ? createHttpUpdaterClient(options.updaterConfig) : null);
    this.#maintenance = options.maintenance;
    this.#demoMode = options.demoMode === true;
    this.#currentVersion = options.currentVersion ?? APP_VERSION;
    this.#clock = options.clock ?? Date.now;
  }

  async settled(): Promise<void> {
    await this.#handoffExecution;
  }

  async status(): Promise<SelfUpdateStatus> {
    const canBackup = !this.#demoMode && this.#maintenance !== undefined;
    if (this.#demoMode) {
      return {
        enabled: false,
        unavailable_reason: "demo_read_only",
        current_version: this.#currentVersion,
        can_backup: false,
        active_job: null,
        latest_job: null,
      };
    }
    if (!this.#client) {
      return {
        enabled: false,
        unavailable_reason: "not_configured",
        current_version: this.#currentVersion,
        can_backup: canBackup,
        active_job: null,
        latest_job: null,
      };
    }
    try {
      const remote = await this.#client.status();
      const active = this.#localActive ?? remote.active;
      const latest = selectLatestJob(this.#localLatest, remote.latest);
      return {
        enabled: true,
        unavailable_reason: null,
        current_version: this.#currentVersion,
        can_backup: canBackup,
        active_job: active,
        latest_job: latest,
      };
    } catch {
      return {
        enabled: false,
        unavailable_reason: "unreachable",
        current_version: this.#currentVersion,
        can_backup: canBackup,
        active_job: this.#localActive,
        latest_job: this.#localLatest,
      };
    }
  }

  async apply(request: SelfUpdateApplyRequest, observer: MaintenanceObserver): Promise<UpdateExecutionJob> {
    if (this.#demoMode) {
      throw new SelfUpdateError(403, "demo_read_only", "当前演示环境为只读模式，无法执行在线更新。");
    }
    if (!this.#client) {
      throw new SelfUpdateError(
        503,
        "self_update_unavailable",
        "未启用在线更新伴生服务，请使用升级助手中的手动命令，或启用 docker-compose.updater.yml。",
      );
    }
    if (!parseReleaseVersion(request.target_version)) {
      throw new SelfUpdateError(422, "validation_failed", "目标版本号格式无效，仅允许规范的官方发布版本。");
    }
    if (!parseReleaseVersion(this.#currentVersion) || compareReleaseVersions(this.#currentVersion, request.target_version) >= 0) {
      throw new SelfUpdateError(
        422,
        "validation_failed",
        "在线一键更新仅支持升级到高于当前版本的官方发布版，不支持降级或重复覆盖同版本。",
      );
    }

    const existing = this.#requests.get(request.operation_id);
    if (existing) {
      if (
        existing.request.target_version !== request.target_version ||
        existing.request.create_backup !== request.create_backup
      ) {
        throw new SelfUpdateError(409, "operation_conflict", "此次更新操作编号与先前提交的参数不一致，请刷新后重试。");
      }
      if (existing.handedOff) {
        try {
          const remote = await this.#client.status();
          if (remote.active?.id === request.operation_id) return remote.active;
          if (remote.latest?.id === request.operation_id) return remote.latest;
        } catch {
          // Fall back to last known job snapshot.
        }
      }
      return existing.job;
    }

    if (this.#localActive) {
      throw new SelfUpdateError(409, "update_in_progress", "已有在线更新任务正在执行，请等待当前更新完成。");
    }

    // Confirm updater connectivity and idle state before starting any pre-upgrade backup.
    let remoteState: UpdaterState;
    try {
      remoteState = await this.#client.status();
    } catch {
      throw new SelfUpdateError(
        503,
        "self_update_unavailable",
        "暂时无法连接到伴生更新服务，请检查 updater 容器状态，或改用升级助手手动更新。",
      );
    }
    if (remoteState.active) {
      if (remoteState.active.id === request.operation_id) return remoteState.active;
      throw new SelfUpdateError(409, "update_in_progress", "已有在线更新任务正在执行，请等待当前更新完成。");
    }
    if (remoteState.latest?.id === request.operation_id) {
      return remoteState.latest;
    }

    if (this.#maintenance && (this.#maintenance.paused || this.#maintenance.state().active !== null)) {
      throw new SelfUpdateError(409, "maintenance_in_progress", "已有维护任务正在执行，请等待完成后再开始更新。");
    }

    // Case 1: Skip pre-upgrade backup (user explicitly unchecked or maintenance service unavailable).
    if (!request.create_backup || !this.#maintenance) {
      const job = await this.#client.apply({
        operation_id: request.operation_id,
        target_version: request.target_version,
        previous_version: this.#currentVersion,
        backup_name: null,
      });
      this.#rememberRequest(request, job, true);
      this.#localLatest = job;
      return job;
    }

    // Case 2: Run online database backup first, then hand off to updater only if backup succeeds.
    const backupOperationId = randomUUID();
    this.#maintenance.start({ operation_id: backupOperationId, kind: "BACKUP" }, observer);

    const backingUpJob: UpdateExecutionJob = {
      id: request.operation_id,
      target_version: request.target_version,
      previous_version: this.#currentVersion,
      status: "RUNNING",
      stage: "backing_up",
      message: "正在创建更新前数据库备份…",
      backup_name: null,
      rolled_back: false,
      started_at: this.#clock(),
      finished_at: null,
      error: null,
    };
    const stored = this.#rememberRequest(request, backingUpJob, false);
    this.#localActive = backingUpJob;
    this.#localLatest = backingUpJob;

    const maintenance = this.#maintenance;
    const client = this.#client;
    this.#handoffExecution = (async () => {
      try {
        await maintenance.settled();
        const backupJob = maintenance.get(backupOperationId);
        if (backupJob.status !== "SUCCEEDED") {
          const failed: UpdateExecutionJob = {
            ...stored.job,
            status: "FAILED",
            stage: "failed",
            message: "更新前数据库备份失败，已中止更新，当前服务未受影响",
            finished_at: this.#clock(),
            error: backupJob.error ?? "数据库备份未成功完成",
          };
          stored.job = failed;
          this.#localActive = null;
          this.#localLatest = failed;
          return;
        }
        const backupName = backupJob.result?.backup_name ?? null;
        const handingOff: UpdateExecutionJob = {
          ...stored.job,
          stage: "queued",
          backup_name: backupName,
          message: backupName
            ? `更新前备份已完成（${backupName}），正在移交伴生更新器…`
            : "更新前备份已完成，正在移交伴生更新器…",
        };
        stored.job = handingOff;
        this.#localActive = handingOff;
        this.#localLatest = handingOff;

        const remoteJob = await client.apply({
          operation_id: request.operation_id,
          target_version: request.target_version,
          previous_version: this.#currentVersion,
          backup_name: backupName,
        });
        stored.job = remoteJob;
        stored.handedOff = true;
        this.#localActive = null;
        this.#localLatest = remoteJob;
      } catch (error) {
        const message = error instanceof Error ? error.message : "无法将更新任务移交给伴生更新器";
        const failed: UpdateExecutionJob = {
          ...stored.job,
          status: "FAILED",
          stage: "failed",
          message: "备份已完成，但未能启动在线更新，当前服务未受影响",
          finished_at: this.#clock(),
          error: message,
        };
        stored.job = failed;
        this.#localActive = null;
        this.#localLatest = failed;
      }
    })();

    return backingUpJob;
  }

  #rememberRequest(request: SelfUpdateApplyRequest, job: UpdateExecutionJob, handedOff: boolean): StoredLocalRequest {
    const record: StoredLocalRequest = { request, job, handedOff };
    this.#requests.set(request.operation_id, record);
    while (this.#requests.size > 20) {
      const oldest = this.#requests.keys().next().value;
      if (oldest) this.#requests.delete(oldest);
    }
    return record;
  }
}

function selectLatestJob(
  local: UpdateExecutionJob | null,
  remote: UpdateExecutionJob | null,
): UpdateExecutionJob | null {
  if (!local) return remote;
  if (!remote) return local;
  if (local.id === remote.id) return remote;
  return remote.started_at >= local.started_at ? remote : local;
}

function readUpdaterToken(config: UpdaterConfig): string | null {
  if (config.token) return config.token;
  if (!config.tokenFile) return null;
  try {
    if (!existsSync(config.tokenFile)) return null;
    const stat = lstatSync(config.tokenFile);
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
    const token = readFileSync(config.tokenFile, "utf8").trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

export function createHttpUpdaterClient(
  config: UpdaterConfig,
  timeoutMilliseconds = 4_000,
): UpdaterClient {
  const baseUrl = config.url.replace(/\/$/u, "");

  async function requestJson<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const token = readUpdaterToken(config);
    if (!token) {
      throw new SelfUpdateError(
        503,
        "self_update_unavailable",
        "尚未读取到伴生更新器认证令牌，请稍后重试或检查 updater 容器状态。",
      );
    }
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMilliseconds),
      });
    } catch {
      throw new SelfUpdateError(
        503,
        "self_update_unavailable",
        "暂时无法连接到伴生更新服务，请检查 updater 容器状态。",
      );
    }

    const payload = await response.json().catch(() => null) as {
      data?: T;
      error?: { code?: unknown; message?: unknown };
    } | null;

    if (!response.ok) {
      const code = typeof payload?.error?.code === "string" ? payload.error.code : "";
      const message = typeof payload?.error?.message === "string" ? payload.error.message : "伴生更新服务拒绝了此次请求。";
      if (response.status === 409 && code === "update_in_progress") {
        throw new SelfUpdateError(409, "update_in_progress", message);
      }
      if (response.status === 409 && code === "operation_conflict") {
        throw new SelfUpdateError(409, "operation_conflict", message);
      }
      if (response.status === 422 && code === "validation_failed") {
        throw new SelfUpdateError(422, "validation_failed", message);
      }
      throw new SelfUpdateError(503, "self_update_unavailable", message);
    }

    if (!payload || payload.data === undefined) {
      throw new SelfUpdateError(503, "self_update_unavailable", "伴生更新服务返回了无效响应。");
    }
    return payload.data;
  }

  return {
    status: () => requestJson<UpdaterState>("GET", "/status"),
    apply: (request: UpdaterApplyRequest) => requestJson<UpdateExecutionJob>("POST", "/apply", request),
  };
}
