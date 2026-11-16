import { createHash } from "node:crypto";
import type { AuthenticatedSession } from "../identity/service.ts";
import type { AdminFrontend } from "../http/web/admin.ts";
import type { AppDatabase } from "../database/database.ts";
import { MaintenanceError, type MaintenanceJob, type MaintenanceRequest, type MaintenanceResult, type MaintenanceState } from "./model.ts";

export interface MaintenanceObserver {
  session: AuthenticatedSession;
  address: string;
}
interface StoredJob {
  request: MaintenanceRequest;
  job: MaintenanceJob;
}
export interface MaintenanceHooks {
  pause(): Promise<void>;
  resume(): Promise<void>;
  run(request: MaintenanceRequest, progress: (stage: string, message: string) => void): Promise<MaintenanceResult>;
  completed?(job: MaintenanceJob): void;
}

/** Keeps the management page responsive while the business database is closed. */
export class MaintenanceController {
  readonly #hooks: MaintenanceHooks;
  readonly #jobs = new Map<string, StoredJob>();
  #active: MaintenanceJob | null = null;
  #latest: MaintenanceJob | null = null;
  #paused = false;
  #execution: Promise<void> | null = null;
  #observer: { digest: string; address: string; username: string; idle: number; absolute: number } | null = null;

  constructor(hooks: MaintenanceHooks) { this.#hooks = hooks; }
  get paused(): boolean { return this.#paused; }
  state(): MaintenanceState { return { active: this.#active, latest: this.#latest }; }
  get(id: string): MaintenanceJob {
    const stored = this.#jobs.get(id);
    if (!stored) throw new MaintenanceError(404, "maintenance_job_not_found", "没有找到这项维护任务");
    return stored.job;
  }
  start(request: MaintenanceRequest, observer: MaintenanceObserver): MaintenanceJob {
    const previous = this.#jobs.get(request.operation_id);
    if (previous) {
      if (JSON.stringify(previous.request) !== JSON.stringify(request)) {
        throw new MaintenanceError(409, "maintenance_operation_conflict", "这次操作的内容已改变，请重新提交");
      }
      return previous.job;
    }
    if (this.#active || this.#paused) throw new MaintenanceError(409, "maintenance_in_progress", "已有维护任务正在执行，请等待完成");
    const job: MaintenanceJob = {
      id: request.operation_id, kind: request.kind, status: "QUEUED", stage: "queued", message: "任务已提交，正在准备执行",
      started_at: Date.now(), finished_at: null, error: null, result: null,
    };
    this.#jobs.set(job.id, { request, job });
    while (this.#jobs.size > 20) this.#jobs.delete(this.#jobs.keys().next().value!);
    this.#active = this.#latest = job;
    const exclusive = request.kind === "ARCHIVE" || request.kind === "RESTORE";
    if (exclusive) {
      this.#paused = true;
      this.#observer = {
        digest: digest(observer.session.token), address: observer.address, username: observer.session.session.username,
        idle: observer.session.session.idleExpiresAt, absolute: observer.session.session.absoluteExpiresAt,
      };
    }
    this.#execution = new Promise<void>(resolve => setImmediate(resolve)).then(() => this.#execute(request, job, exclusive));
    return job;
  }
  async settled(): Promise<void> { await this.#execution; }
  prepareDatabase(database: AppDatabase): void {
    if (this.#latest?.kind !== "RESTORE" || !this.#latest.result?.requires_login) return;
    database.write(connection => {
      const now = Date.now();
      connection.prepare("UPDATE admin_identity SET session_generation = session_generation + 1, updated_at = ? WHERE singleton_key = 1").run(now);
      connection.prepare("UPDATE admin_sessions SET revoked_at = ?, revoke_reason = 'backup_restore' WHERE revoked_at IS NULL").run(now);
    });
  }

  /** Only the initiating session can use this read-only view while writers are stopped. */
  response(request: Request, address: string, secureCookies: boolean, frontend: AdminFrontend | null): Response | null {
    const path = new URL(request.url).pathname;
    const receipt = this.#latest?.result?.requires_login === true;
    if (!this.#paused && !receipt) return null;
    const observer = this.#observer;
    const cookie = secureCookies ? "__Host-perpay_session" : "perpay_session";
    const token = request.headers.get("cookie")?.split(";").map(value => value.trim()).find(value => value.startsWith(cookie + "="))?.slice(cookie.length + 1);
    const authorized = observer !== null && token !== undefined && digest(token) === observer.digest && address === observer.address &&
      Date.now() < Math.min(observer.idle, observer.absolute);
    const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "cache-control": "no-store" } });
    if (authorized && request.method === "GET") {
      if (path === "/api/admin/v1/maintenance/jobs") return json({ data: this.state() });
      if (path.startsWith("/api/admin/v1/maintenance/jobs/")) {
        const stored = this.#jobs.get(path.slice("/api/admin/v1/maintenance/jobs/".length));
        return stored ? json({ data: stored.job }) : json({ error: { code: "maintenance_job_not_found", message: "没有找到这项维护任务" } }, 404);
      }
      if (this.#paused && path === "/api/admin/v1/session") return json({ data: {
        username: observer.username, csrf_token_required: true,
        idle_expires_at: new Date(observer.idle).toISOString(), absolute_expires_at: new Date(observer.absolute).toISOString(),
      } });
      if (this.#paused && frontend) {
        const asset = frontend.assets.get(path);
        if (asset) return new Response(asset.body, { headers: { "content-type": asset.contentType, "etag": asset.etag } });
        if (path === "/admin" || path.startsWith("/admin/")) return new Response(frontend.render(true), { headers: { "content-type": "text/html; charset=utf-8" } });
      }
    }
    if (!this.#paused) return null;
    if (request.method === "GET" && path === "/healthz") return json({ status: "maintenance", operation: this.#active?.kind ?? null });
    return json({ error: { code: "maintenance_in_progress", message: "系统正在维护，完成后会自动恢复服务" } }, 503);
  }

  async #execute(request: MaintenanceRequest, job: MaintenanceJob, exclusive: boolean): Promise<void> {
    let stopped = false;
    let failure: unknown;
    job.status = "RUNNING";
    const progress = (stage: string, message: string) => { job.stage = stage; job.message = message; };
    try {
      if (exclusive) {
        progress("pausing", "正在等待当前请求结束并暂停收款、查账和通知");
        await this.#hooks.pause();
        stopped = true;
      }
      job.result = await this.#hooks.run(request, progress);
    } catch (error) {
      failure = error;
      if (error instanceof Error && "result" in error) job.result = error.result as MaintenanceResult | null;
    }
    if (exclusive && stopped) {
      progress("resuming", "正在重新打开数据库并恢复服务");
      try { await this.#hooks.resume(); this.#paused = false; }
      catch (error) { failure = error; }
    }
    job.finished_at = Date.now();
    job.status = failure === undefined ? "SUCCEEDED" : "FAILED";
    job.stage = failure === undefined ? "completed" : "failed";
    job.message = failure === undefined ? "操作已完成" : this.#paused ? "维护未完成，服务仍处于维护状态" : "操作未完成，服务已恢复";
    job.error = failure === undefined ? null : (failure instanceof Error ? failure.message : "维护操作失败") +
      (this.#paused ? "；服务仍处于维护状态，请检查服务日志并重启 PerPay。" : "");
    this.#active = null;
    if (job.result?.requires_login !== true && !this.#paused) this.#observer = null;
    try { this.#hooks.completed?.(job); }
    catch (error) { console.error(JSON.stringify({ event: "maintenance_completion_audit_failed", message: error instanceof Error ? error.message : "unknown_error" })); }
  }
}

function digest(token: string): string { return createHash("sha256").update(token).digest("hex"); }
