import type { LedgerManualScanRequest, LedgerManualScanStatus, SystemStatus } from "@/api/client";

const states = ["WAITING", "RUNNING", "COMPLETED", "FAILED"];
const outcomes = ["COMPLETED", "PARTIAL", "FAILED", "SKIPPED"];
export const manualScanUnavailable: Record<NonNullable<LedgerManualScanStatus["unavailable_reason"]>, string | null> = {
  not_configured: "请先完成支付宝账号配置。",
  transitioning: "运行配置正在切换，请稍后再试。",
  stopped: "查账任务已停用，请先启用查账服务。",
  storage_unavailable: "查账进度暂不可用，请检查运行诊断。",
  database_unavailable: "数据库暂不可用，请检查服务器。",
  demo_read_only: null,
};

export function manualScanActive(request: LedgerManualScanRequest | null | undefined): boolean {
  return request?.state === "WAITING" || request?.state === "RUNNING";
}

export function manualScanSource(data: SystemStatus): string {
  return `${data.instance_id}:${data.provider_account_key}:${data.payment_revision}`;
}

function timestamp(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function isManualScanRequest(value: unknown): value is LedgerManualScanRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Record<string, unknown>;
  return typeof request.id === "string" && request.id.length > 0 &&
    typeof request.state === "string" && states.includes(request.state) && timestamp(request.requested_at) &&
    [request.started_at, request.finished_at, request.next_attempt_at].every(time => time === null || timestamp(time)) &&
    (request.outcome === null || (typeof request.outcome === "string" && outcomes.includes(request.outcome))) &&
    [request.error_code, request.ingest_run_id].every(text => text === null || typeof text === "string") &&
    (request.state !== "RUNNING" || request.started_at !== null) &&
    (!["COMPLETED", "FAILED"].includes(request.state) || (request.finished_at !== null && request.outcome !== null));
}

export function isManualScanStatus(value: unknown): value is LedgerManualScanStatus {
  if (!value || typeof value !== "object") return false;
  const status = value as Record<string, unknown>;
  return typeof status.available === "boolean" &&
    (status.unavailable_reason === null || (typeof status.unavailable_reason === "string" && Object.hasOwn(manualScanUnavailable, status.unavailable_reason))) &&
    (status.request === null || isManualScanRequest(status.request));
}
