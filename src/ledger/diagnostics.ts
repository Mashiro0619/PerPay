import type { AppDatabase } from "../database/database.ts";
import { PAGE_VALIDATION_REASONS } from "../infrastructure/alipay/errors.ts";
import { normalizeProviderAccountKey, parseOccurredAt, type IngestScanKind } from "./model.ts";

export interface LedgerFailureDiagnostic {
  readonly ingest_run_id: string;
  readonly ingest_segment_id: string | null;
  readonly scan_kind: IngestScanKind;
  readonly window_start: string;
  readonly window_end: string;
  readonly error_code: string;
  readonly reason: string;
  readonly occurred_at: string;
}

export interface LedgerDiagnostics {
  readonly available: boolean;
  /** Account-wide counter, not a count of identical pages or one scan lane. */
  readonly consecutive_failures: number | null;
  readonly in_flight: boolean;
  readonly next_retry_at: string | null;
  readonly latest_failure: LedgerFailureDiagnostic | null;
}

/** Read bounded metadata only. Raw pages, headers and bodies never leave the store here. */
export function readLedgerFailureDiagnostic(database: AppDatabase, accountKey: string): {
  consecutiveFailures: number;
  latestFailure: LedgerFailureDiagnostic | null;
} {
  const account = normalizeProviderAccountKey(accountKey);
  return database.read(connection => {
    const schedule = connection.prepare(
      "SELECT consecutive_failures, last_error_code, updated_at FROM ledger_ingest_schedule_state WHERE provider_account_key = ?",
    ).get(account) as { consecutive_failures: bigint; last_error_code: string; updated_at: bigint } | undefined;
    if (!schedule) return { consecutiveFailures: 0, latestFailure: null };
    const count = Number(schedule.consecutive_failures);
    if (!Number.isSafeInteger(count) || count < 1) throw new Error("invalid persisted failure count");
    interface Run { ingest_run_id: string; scan_kind: IngestScanKind; window_start: string; window_end: string }
    const columns = "ingest_run_id, scan_kind, window_start, window_end";
    // Long-running NORMAL/COMPENSATION runs may predate many completed runs.
    const running = connection.prepare(`SELECT ${columns} FROM ingest_runs WHERE provider_account_key = ? AND status = 'RUNNING' LIMIT 2`).all(account) as unknown as Run[];
    const recent = connection.prepare(`SELECT ${columns} FROM ingest_runs WHERE provider_account_key = ? ORDER BY started_at DESC, ingest_run_id LIMIT 32`).all(account) as unknown as Run[];
    const candidates = new Map([...running, ...recent].map(run => [run.ingest_run_id, run]));
    const statement = connection.prepare(
      `SELECT error_code, details_json, occurred_at FROM ingest_errors
       WHERE ingest_run_id = ? AND occurred_at = ? AND error_code = ?
       ORDER BY occurred_at DESC, ingest_error_id DESC LIMIT 1`,
    );
    for (const run of candidates.values()) {
      const row = statement.get(run.ingest_run_id, schedule.updated_at, schedule.last_error_code) as {
        error_code: string; details_json: string; occurred_at: bigint;
      } | undefined;
      if (!row) continue;
      const details: unknown = JSON.parse(row.details_json);
      if (!details || typeof details !== "object" || Array.isArray(details)) throw new Error("invalid failure details");
      const record = details as Record<string, unknown>;
      const segmentId = typeof record.ingest_segment_id === "string" ? record.ingest_segment_id : null;
      const segment = segmentId === null ? undefined : connection.prepare(
        "SELECT window_start, window_end FROM ingest_segments WHERE ingest_segment_id = ? AND ingest_run_id = ?",
      ).get(segmentId, run.ingest_run_id) as { window_start: string; window_end: string } | undefined;
      if (segmentId !== null && !segment) throw new Error("failure segment is unavailable");
      return { consecutiveFailures: count, latestFailure: {
        ingest_run_id: run.ingest_run_id,
        ingest_segment_id: segmentId,
        scan_kind: run.scan_kind,
        window_start: new Date(parseOccurredAt(segment?.window_start ?? run.window_start)).toISOString(),
        window_end: new Date(parseOccurredAt(segment?.window_end ?? run.window_end)).toISOString(),
        error_code: row.error_code,
        reason: diagnosticReason(row.error_code, record.validation_reason),
        occurred_at: new Date(Number(row.occurred_at)).toISOString(),
      } };
    }
    // Never invent an explanation when bounded lookup cannot find the persisted failure.
    throw new Error("latest ingest failure metadata is unavailable");
  });
}

function diagnosticReason(code: string, reason: unknown): string {
  if (typeof reason === "string" && Object.hasOwn(PAGE_VALIDATION_REASONS, reason)) {
    return PAGE_VALIDATION_REASONS[reason as keyof typeof PAGE_VALIDATION_REASONS];
  }
  switch (code) {
    case "pagination_invalid": case "response_invalid_shape": return "账单页未通过校验，请保留失败窗口和错误记录进行排查";
    case "remote_authentication_failed": case "request_signing_failed": return "支付宝身份验证失败，请检查当前应用和密钥配置";
    case "remote_authorization_failed": return "支付宝查询权限不足，请检查应用授权";
    case "remote_rate_limited": return "支付宝限制了查询频率，系统会遵守退避时间";
    case "transport_network": case "transport_timeout": return "支付宝查询连接失败或超时，请检查网络";
    default: return "采集失败，请根据错误码检查网络、支付宝配置或上游响应";
  }
}
