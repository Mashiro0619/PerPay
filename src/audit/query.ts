// SPDX-License-Identifier: MIT
import { createHash } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { z } from "zod";
import type { AppDatabase } from "../database/database.ts";
import { normalizeIpAddress } from "../infrastructure/network/ip-policy.ts";
import { csvCell } from "../http/order-export.ts";
import { createdDateRange, CreatedDateError } from "../shared/created-dates.ts";
import { ListQueryError, normalizeKeyword } from "../shared/list-query.ts";
import {
  AUDIT_ACTOR_TYPES, AUDIT_CATEGORIES, AUDIT_CATEGORY_LABELS, AUDIT_OUTCOMES, AUDIT_SOURCES,
  AUDIT_UNASSOCIATED_SITE, type AuditActorType, type AuditCaptureState, type AuditCategory,
  type AuditChange, type AuditEventDetail, type AuditEventItem, type AuditEventPage,
  type AuditFilters, type AuditJsonValue, type AuditMetadata,
  type AuditOutcome, type AuditRelatedEvent, type AuditSnapshot, type AuditSource,
} from "../shared/audit.ts";

type ReadDatabase = Pick<AppDatabase, "read">;
const DAY = 86_400_000;
const ACTIVITY_RETENTION_DAYS = 30;
export const MAX_AUDIT_EXPORT_ROWS = 10_000;
const CURSOR_PREFIX = "perpay:audit:v1";
const FILTER_KEYS = ["source", "category", "action", "outcome", "actor_type", "site_id", "source_address", "created_from", "created_to", "q"] as const;
const QUERY_KEYS = new Set<string>([...FILTER_KEYS, "limit", "cursor"]);
const actionSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const siteSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const filterSchema = z.object({
  source: z.enum(AUDIT_SOURCES).optional(), category: z.enum(AUDIT_CATEGORIES).optional(),
  action: actionSchema.optional(), outcome: z.enum(AUDIT_OUTCOMES).optional(),
  actor_type: z.enum(AUDIT_ACTOR_TYPES).optional(), site_id: siteSchema.optional(),
  source_address: z.string().max(128).optional(), created_from: z.string().optional(),
  created_to: z.string().optional(), q: z.string().optional(),
}).strict();
export const auditExportSchema = filterSchema.extend({ created_from: z.string(), created_to: z.string() });
interface Position { readonly occurredAt: number; readonly source: AuditSource; readonly sequence: number }
interface AuditCursor { readonly snapshot: AuditSnapshot; readonly position: Position }
export interface AuditPageQuery {
  readonly filters: AuditFilters;
  readonly limit: number;
  readonly cursor: AuditCursor | null;
}
export interface AuditExportSummary {
  readonly row_count: number;
  readonly snapshot: AuditSnapshot;
  /** Raw free-text search is deliberately excluded from the generated-export audit event. */
  readonly filters: Omit<AuditFilters, "q"> & { readonly q_fingerprint: string | null };
}
export interface AuditExportResult { readonly csv: string; readonly summary: AuditExportSummary }
export class AuditQueryError extends Error {
  readonly status: 404 | 503;
  readonly code: "audit_event_not_found" | "audit_query_unavailable";
  constructor(status: 404 | 503, code: AuditQueryError["code"], message: string) {
    super(message); this.name = "AuditQueryError"; this.status = status; this.code = code;
  }
}
function unavailable(): AuditQueryError { return new AuditQueryError(503, "audit_query_unavailable", "审计记录暂时无法读取，请稍后重试"); }
function requireAuditTables(db: DatabaseSync): void {
  const count = db.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE type = 'table' AND name IN ('audit_events', 'audit_event_context', 'activity_events')").get()?.count;
  if (Number(count) !== 3) throw unavailable();
}
function hasTable(db: DatabaseSync, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name) !== undefined;
}
function safeInteger(value: unknown): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw unavailable();
  return number;
}
function iso(value: unknown): string {
  const time = safeInteger(value);
  if (time > 8_640_000_000_000_000) throw unavailable();
  return new Date(time).toISOString();
}
function textOrNull(value: unknown): string | null { return typeof value === "string" ? value : null; }
function isObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function jsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw unavailable(); }
  if (!isObject(parsed)) throw unavailable();
  return parsed;
}
function validateFilters(value: unknown): AuditFilters {
  const parsed = filterSchema.safeParse(value);
  if (!parsed.success) throw new ListQueryError("审计筛选条件无效，请重新设置");
  const input = parsed.data;
  try { createdDateRange(input.created_from, input.created_to); } catch (error) {
    if (error instanceof CreatedDateError) throw new ListQueryError(error.message);
    throw error;
  }
  const address = input.source_address === undefined ? undefined : normalizeIpAddress(input.source_address);
  if (input.source_address !== undefined && !address) throw new ListQueryError("来源 IP 须为有效的 IPv4 或 IPv6 地址");
  const output: Record<string, string> = {};
  for (const key of FILTER_KEYS) {
    const item = key === "source_address" ? address : key === "q" ? normalizeKeyword(input.q ?? "") : input[key];
    if (item !== undefined && item !== "") output[key] = item;
  }
  return output as AuditFilters;
}
export function readAuditPageQuery(values: URLSearchParams): AuditPageQuery {
  for (const key of values.keys()) if (!QUERY_KEYS.has(key) || values.getAll(key).length !== 1) {
    throw new ListQueryError("审计筛选条件无效或重复，请重新设置");
  }
  const filters = validateFilters(Object.fromEntries([...values].filter(([key]) => key !== "limit" && key !== "cursor")));
  const limitText = values.get("limit") ?? "20";
  if (!/^[1-9][0-9]{0,2}$/.test(limitText) || Number(limitText) > 100) throw new ListQueryError("审计每页条数须为 1 至 100");
  const limit = Number(limitText);
  return { filters, limit, cursor: values.has("cursor") ? decodeCursor(values.get("cursor")!, filters, limit) : null };
}
function queryFingerprint(filters: AuditFilters, limit: number): string {
  return createHash("sha256").update(JSON.stringify([FILTER_KEYS.map(key => filters[key] ?? null), limit])).digest("hex");
}
function encodeCursor(cursor: AuditCursor, filters: AuditFilters, limit: number): string {
  return Buffer.from(JSON.stringify([CURSOR_PREFIX, queryFingerprint(filters, limit), cursor.snapshot.core_sequence,
    cursor.snapshot.activity_sequence, cursor.snapshot.captured_at, cursor.position.occurredAt,
    cursor.position.source, cursor.position.sequence])).toString("base64url");
}
function decodeCursor(value: string, filters: AuditFilters, limit: number): AuditCursor {
  const invalid = () => new ListQueryError("分页信息无效或不属于当前筛选，请返回第一页");
  if (!/^[A-Za-z0-9_-]{1,2048}$/.test(value)) throw invalid();
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) throw invalid();
  let parts: unknown;
  try { parts = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw invalid(); }
  if (!Array.isArray(parts) || parts.length !== 8 || parts[0] !== CURSOR_PREFIX || parts[1] !== queryFingerprint(filters, limit) ||
    ![2, 3, 4, 5, 7].every(index => Number.isSafeInteger(parts[index]) && parts[index] >= 0) ||
    parts[4] > 8_640_000_000_000_000 || parts[5] > 8_640_000_000_000_000 ||
    !AUDIT_SOURCES.includes(parts[6]) || parts[7] < 1 || parts[7] > parts[parts[6] === "core" ? 2 : 3]) throw invalid();
  return { snapshot: { core_sequence: parts[2], activity_sequence: parts[3], captured_at: parts[4] },
    position: { occurredAt: parts[5], source: parts[6], sequence: parts[7] } };
}
function snapshot(db: DatabaseSync, now: number): AuditSnapshot {
  const row = db.prepare("SELECT (SELECT COALESCE(MAX(sequence), 0) FROM audit_events) AS core, (SELECT COALESCE(MAX(sequence), 0) FROM activity_events) AS activity").get()!;
  return { core_sequence: safeInteger(row.core), activity_sequence: safeInteger(row.activity), captured_at: safeInteger(now) };
}
/** Category rules are shared by filtering, list projections and historical action metadata. */
const CORE_CATEGORY = `CASE
  WHEN action LIKE 'audit.%' THEN 'audit'
  WHEN action LIKE 'admin.%' OR action = 'api.authentication' THEN 'identity'
  WHEN action LIKE 'settings.%' OR action LIKE 'site.%' OR action LIKE 'site_defaults.%' OR action LIKE 'alipay_account.%' OR action LIKE 'api_client.%' THEN 'configuration'
  WHEN action LIKE 'orders.%' OR action LIKE 'order.%' THEN 'orders'
  WHEN action LIKE 'ledger.%' OR action LIKE 'reconciliation.%' OR action LIKE 'financial.%' THEN 'reconciliation'
  WHEN action LIKE 'webhook.%' OR action LIKE 'notification.%' THEN 'notifications'
  WHEN action LIKE 'backup.%' OR action LIKE 'maintenance.%' THEN 'maintenance'
  ELSE 'other' END`;
const ACTIVITY_CATEGORY = `CASE WHEN action LIKE 'backup.%' OR action LIKE 'maintenance.%' THEN 'maintenance' WHEN source_type = 'HTTP' THEN 'requests' WHEN source_type = 'BACKGROUND' THEN 'background' WHEN source_type = 'MAINTENANCE' THEN 'maintenance' ELSE 'other' END`;
function coreProjection(includeEvidence: boolean): string {
  return `SELECT 'core' AS source, e.sequence, e.event_id, e.occurred_at, e.occurred_at AS first_occurred_at, e.occurred_at AS last_occurred_at,
    ${CORE_CATEGORY} AS category, e.action, e.outcome, e.actor_type, e.actor_id, e.subject_type, e.subject_id,
    e.request_id, c.activity_id, COALESCE(c.site_id, CASE WHEN e.subject_type = 'website' AND e.subject_id != 'defaults' THEN e.subject_id END) AS site_id,
    c.site_name, c.source_address, c.user_agent, CASE WHEN c.event_id IS NOT NULL THEN 1 ELSE 0 END AS context_recorded,
    'CORE' AS source_type, 1 AS event_count, 0 AS is_aggregate, NULL AS duration_ms,
    NULL AS http_method, NULL AS route, NULL AS http_status${includeEvidence ? ", e.details_json, c.context_json, e.event_hash, e.previous_hash, c.context_fingerprint, e.remote_address_hash, '[]' AS core_event_ids_json" : ""}
    FROM audit_events e LEFT JOIN audit_event_context c ON c.event_id = e.event_id`;
}
function activityProjection(includeEvidence: boolean): string {
  return `SELECT 'activity' AS source, sequence, event_id, occurred_at, COALESCE(first_occurred_at, occurred_at) AS first_occurred_at, last_occurred_at,
    ${ACTIVITY_CATEGORY} AS category, action, outcome, actor_type, actor_id, subject_type, subject_id,
    request_id, activity_id, site_id, site_name, source_address, user_agent, 1 AS context_recorded,
    source_type, event_count, is_aggregate, duration_ms, http_method, route, http_status${includeEvidence ? ", details_json, NULL AS context_json, NULL AS event_hash, NULL AS previous_hash, NULL AS context_fingerprint, NULL AS remote_address_hash, core_event_ids_json" : ""}
    FROM activity_events`;
}
type AuditRow = Record<string, unknown>;
function selectRows(db: DatabaseSync, filters: AuditFilters, boundary: AuditSnapshot, position: Position | null, limit: number, evidence: boolean, now: number): AuditRow[] {
  const conditions: string[] = [];
  const parameters: SQLInputValue[] = [];
  for (const key of ["category", "action", "outcome", "actor_type", "source_address"] as const) {
    if (filters[key] !== undefined) { conditions.push(key + " = ?"); parameters.push(filters[key]!); }
  }
  if (filters.site_id === AUDIT_UNASSOCIATED_SITE) conditions.push("site_id IS NULL");
  else if (filters.site_id !== undefined) { conditions.push("site_id = ?"); parameters.push(filters.site_id); }
  const dates = createdDateRange(filters.created_from, filters.created_to);
  if (dates) { conditions.push("occurred_at >= ? AND occurred_at < ?"); parameters.push(dates.start, dates.end); }
  if (filters.q) {
    const search = "%" + filters.q.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_") + "%";
    conditions.push("(" + ["event_id", "action", "actor_id", "subject_id", "request_id", "activity_id", "site_id", "site_name", "source_address", "route"].map(column => `${column} LIKE ? ESCAPE '\\'`).join(" OR ") + ")");
    for (let index = 0; index < 10; index++) parameters.push(search);
  }
  const sources = filters.source ? [filters.source] : AUDIT_SOURCES;
  const bindings: SQLInputValue[] = [];
  const selections = sources.map(source => {
    const local = [...conditions, "sequence <= ?"];
    const values: SQLInputValue[] = [...parameters, boundary[source === "core" ? "core_sequence" : "activity_sequence"]];
    // A caller-controlled cursor must never extend the activity retention window.
    if (source === "activity") {
      local.push("occurred_at >= ?");
      values.push(Math.max(0, Math.max(now, boundary.captured_at) - ACTIVITY_RETENTION_DAYS * DAY));
    }
    if (position) {
      if (source === position.source) {
        local.push("(occurred_at, sequence) < (?, ?)");
        values.push(position.occurredAt, position.sequence);
      } else {
        local.push(source < position.source ? "occurred_at <= ?" : "occurred_at < ?");
        values.push(position.occurredAt);
      }
    }
    bindings.push(...values, limit);
    return `${source}_rows AS (SELECT * FROM (${source === "core" ? coreProjection(evidence) : activityProjection(evidence)})
      WHERE ${local.join(" AND ")} ORDER BY occurred_at DESC, sequence DESC LIMIT ?)`;
  });
  // Each source uses its own time index and contributes at most one page. The
  // outer ordering only merges these bounded candidates, in one SQLite snapshot.
  return db.prepare(`WITH ${selections.join(", ")}
    ${sources.map(source => `SELECT * FROM ${source}_rows`).join(" UNION ALL ")}
    ORDER BY occurred_at DESC, source DESC, sequence DESC LIMIT ?`).all(...bindings, limit) as AuditRow[];
}
function item(row: AuditRow): AuditEventItem {
  return {
    source: row.source as AuditSource, event_id: String(row.event_id), sequence: safeInteger(row.sequence),
    occurred_at: iso(row.occurred_at), first_occurred_at: iso(row.first_occurred_at), last_occurred_at: iso(row.last_occurred_at), category: row.category as AuditCategory,
    action: String(row.action), outcome: row.outcome as AuditOutcome, actor_type: row.actor_type as AuditActorType,
    actor_id: textOrNull(row.actor_id), subject_type: textOrNull(row.subject_type), subject_id: textOrNull(row.subject_id),
    request_id: textOrNull(row.request_id), activity_id: textOrNull(row.activity_id), site_id: textOrNull(row.site_id),
    site_name: textOrNull(row.site_name), source_address: textOrNull(row.source_address), user_agent: textOrNull(row.user_agent),
    context_recorded: Number(row.context_recorded) === 1, source_type: row.source_type as AuditEventItem["source_type"],
    event_count: safeInteger(row.event_count), is_aggregate: Number(row.is_aggregate) === 1,
    duration_ms: row.duration_ms === null ? null : safeInteger(row.duration_ms), http_method: textOrNull(row.http_method),
    route: textOrNull(row.route), http_status: row.http_status === null ? null : safeInteger(row.http_status),
  };
}
export function queryAuditEvents(database: ReadDatabase, query: AuditPageQuery, now = Date.now()): AuditEventPage {
  return database.read(db => {
    requireAuditTables(db);
    const boundary = query.cursor?.snapshot ?? snapshot(db, now);
    const rows = selectRows(db, query.filters, boundary, query.cursor?.position ?? null, query.limit + 1, false, now);
    const selected = rows.slice(0, query.limit);
    const last = selected.at(-1);
    return { data: selected.map(item), page: { snapshot_at: iso(boundary.captured_at), next_cursor: rows.length > query.limit && last ? encodeCursor({ snapshot: boundary,
      position: { occurredAt: safeInteger(last.occurred_at), source: last.source as AuditSource, sequence: safeInteger(last.sequence) } }, query.filters, query.limit) : null } };
  });
}
const SAFE_DETAIL_KEYS = new Set([
  "reason", "error_code", "stage", "status", "generation", "session_generation", "revision", "settings_revision", "payment_revision", "payment_revision_changed",
  "key_version", "version", "purpose", "field", "enabled", "cidrs", "name", "system_name", "checkout_show_product_name", "dashboard_chart_type", "checkout_help_url",
  "operation_id", "financial_operation_id", "reverses_operation_id", "order_id", "order_version", "ledger_entry_id", "payment_match_id", "candidate_id", "conflict_id", "conflict_operation_id", "delivery_id", "redelivery_id", "event_id", "external_event_id", "account_id", "alipay_account_id", "client_id", "site_id", "site_name", "change_id",
  "request_fingerprint", "result_fingerprint", "membership_fingerprint", "q_fingerprint", "row_count", "snapshot", "filters", "source", "category", "action", "outcome", "actor_type", "source_address", "created_from", "created_to", "core_sequence", "activity_sequence", "captured_at",
  "revoked_sessions", "revoked_count", "session_id", "current_session_revoked", "conflict_type", "resolution_action", "terminal_status", "suppressed_since_previous",
  "requested_amount_cents", "payable_amount_cents", "received_amount_cents", "amount_cents", "currency", "payment_status", "checkout_status", "operation_type", "replayed",
  "scan_mode", "scan_interval_milliseconds", "provider_account_key", "ingest_run_id", "pages", "created_entries", "duplicate_entries", "isolated_details", "conflicts", "consecutive_failures",
  "processed_entries", "processed_orders", "auto_settled", "failures", "continuation_pending", "processed", "acknowledged", "failed", "pending", "dead_letters",
  "attempt_number", "delivery_outcome",
  "backup_name", "backup_size_bytes", "backup_sha256", "instance_id", "schema_version", "duration_ms", "count", "retained_count", "deleted_count", "deleted_backups", "recovered_temporary_files",
  "quarantine_name", "quarantine_sha256", "quarantine_size_bytes", "quarantined_database_name", "restore_completed",
  "lock_kind", "lock_fingerprint", "lock_created_at", "lock_readable", "force_abandon_lease", "finalize_interrupted_restore",
  "command", "exit_code", "rebuild_state", "quarantine_unreadable", "force_unreadable_lock",
  "source_id", "source_sequence", "gap_count", "missing_events", "after_sequence", "through_sequence", "pruned_through_at", "signal",
]);
const SENSITIVE_FIELD = /password|secret|token|cookie|private|credential|authorization|signature|code[_-]?payload|collection[_-]?code|public[_-]?key/i;
function safeJsonValue(value: unknown, depth = 0): AuditJsonValue | undefined {
  if (depth > 8) return undefined;
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) return value.map(entry => safeJsonValue(entry, depth + 1) ?? null);
  if (!isObject(value)) return undefined;
  const output: Record<string, AuditJsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SENSITIVE_FIELD.test(key) || key === "__proto__" || key === "constructor" || key === "prototype") continue;
    const safe = safeJsonValue(entry, depth + 1);
    if (safe !== undefined) output[key] = safe;
  }
  return output;
}
/** Old metadata was never a public schema. Expose a bounded, explicit projection. */
function safeDetails(raw: unknown): Readonly<Record<string, AuditJsonValue>> {
  const value = jsonObject(raw);
  const output: Record<string, AuditJsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!SAFE_DETAIL_KEYS.has(key) || (SENSITIVE_FIELD.test(key) && key !== "field")) continue;
    if (isObject(entry)) {
      const projected: Record<string, AuditJsonValue> = {};
      for (const [nestedKey, nestedValue] of Object.entries(entry)) if (SAFE_DETAIL_KEYS.has(nestedKey) && !SENSITIVE_FIELD.test(nestedKey)) {
        const safe = safeJsonValue(nestedValue);
        if (safe !== undefined) projected[nestedKey] = safe;
      }
      output[key] = projected;
    } else {
      const safe = safeJsonValue(entry);
      if (safe !== undefined) output[key] = safe;
    }
  }
  return output;
}
function changes(raw: unknown): readonly AuditChange[] {
  if (raw === null || raw === undefined) return [];
  const context = jsonObject(raw);
  if (context.version !== 1 || !Array.isArray(context.changes)) throw unavailable();
  const result: AuditChange[] = [];
  for (const change of context.changes) {
    if (!isObject(change) || typeof change.field !== "string" || !["value", "redacted_change"].includes(String(change.kind))) throw unavailable();
    const redacted = change.kind === "redacted_change" || SENSITIVE_FIELD.test(change.field);
    const before = redacted ? undefined : safeJsonValue(change.before);
    const after = redacted ? undefined : safeJsonValue(change.after);
    result.push({ field: change.field, kind: redacted ? "redacted_change" : "value",
      ...(before !== undefined ? { before } : {}), ...(after !== undefined ? { after } : {}),
      ...(typeof change.configured_before === "boolean" ? { configured_before: change.configured_before } : {}),
      ...(typeof change.configured_after === "boolean" ? { configured_after: change.configured_after } : {}) });
  }
  return result;
}
function relatedProjection(row: AuditRow): AuditRelatedEvent {
  return { source: row.source as AuditSource, event_id: String(row.event_id), action: String(row.action),
    occurred_at: iso(row.occurred_at), outcome: row.outcome as AuditOutcome };
}
export function queryAuditEvent(database: ReadDatabase, source: string, eventId: string, now = Date.now()): AuditEventDetail {
  const missing = () => new AuditQueryError(404, "audit_event_not_found", "审计记录不存在，或活动记录已按保留期限清理");
  if (!AUDIT_SOURCES.includes(source as AuditSource) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(eventId)) throw missing();
  return database.read(db => {
    requireAuditTables(db);
    const row = db.prepare(`${source === "core" ? coreProjection(true) : activityProjection(true)} WHERE ${source === "core" ? "e." : ""}event_id = ?${source === "activity" ? " AND occurred_at >= ?" : ""}`)
      .get(eventId, ...(source === "activity" ? [Math.max(0, now - ACTIVITY_RETENTION_DAYS * DAY)] : [])) as AuditRow | undefined;
    if (!row) throw missing();
    const activityId = textOrNull(row.activity_id);
    const related: AuditRelatedEvent[] = [];
    if (activityId) {
      const core = db.prepare("SELECT 'core' AS source, e.event_id, e.action, e.occurred_at, e.outcome FROM audit_events e JOIN audit_event_context c USING(event_id) WHERE c.activity_id = ? ORDER BY e.sequence").all(activityId) as AuditRow[];
      const activities = db.prepare("SELECT 'activity' AS source, event_id, action, occurred_at, outcome FROM activity_events WHERE activity_id = ? AND occurred_at >= ? ORDER BY sequence").all(activityId, Math.max(0, now - ACTIVITY_RETENTION_DAYS * DAY)) as AuditRow[];
      related.push(...[...core, ...activities].filter(entry => entry.source !== source || entry.event_id !== eventId).map(relatedProjection));
    }
    if (source === "activity") {
      let explicitIds: unknown;
      try { explicitIds = JSON.parse(String(row.core_event_ids_json)); } catch { throw unavailable(); }
      if (!Array.isArray(explicitIds) || explicitIds.length > 10_000 || explicitIds.some(id => typeof id !== "string" || id.length > 128)) throw unavailable();
      const ids = [...new Set(explicitIds as string[])];
      if (ids.length > 0) {
        const explicit = db.prepare(`SELECT 'core' AS source, event_id, action, occurred_at, outcome FROM audit_events WHERE event_id IN (${ids.map(() => "?").join(",")})`).all(...ids) as AuditRow[];
        const seen = new Set(related.map(entry => entry.source + ":" + entry.event_id));
        for (const entry of explicit) if (!seen.has("core:" + String(entry.event_id))) related.push(relatedProjection(entry));
      }
    }
    related.sort((left, right) => right.occurred_at.localeCompare(left.occurred_at) || right.source.localeCompare(left.source) || right.event_id.localeCompare(left.event_id));
    return { ...item(row), details: safeDetails(row.details_json), changes: changes(row.context_json),
      event_hash: textOrNull(row.event_hash), previous_hash: textOrNull(row.previous_hash), context_fingerprint: textOrNull(row.context_fingerprint), remote_address_hash: textOrNull(row.remote_address_hash),
      related_events: related, related_activity_available: activityId === null ? null : source === "activity" || related.some(entry => entry.source === "activity") };
  });
}
export interface RawAuditCaptureState {
  readonly state: "healthy" | "degraded";
  readonly bufferedEvents: number; readonly droppedEvents: number; readonly writeFailures: number;
  readonly lastFlushAt: number | null; readonly lastErrorCode: string | null; readonly spoolLastImportAt: number | null;
  readonly spoolFailures: number; readonly spoolGapCount: number;
}
export function projectAuditCaptureState(value: RawAuditCaptureState | null | undefined): AuditCaptureState {
  if (!value) return { state: "unavailable", buffered_events: 0, dropped_events: 0, write_failures: 0,
    last_flush_at: null, last_error_code: null, spool_last_import_at: null, spool_failures: 0, spool_gap_count: 0 };
  return { state: value.state, buffered_events: safeInteger(value.bufferedEvents), dropped_events: safeInteger(value.droppedEvents), write_failures: safeInteger(value.writeFailures),
    last_flush_at: value.lastFlushAt === null ? null : iso(value.lastFlushAt), last_error_code: value.lastErrorCode,
    spool_last_import_at: value.spoolLastImportAt === null ? null : iso(value.spoolLastImportAt), spool_failures: safeInteger(value.spoolFailures), spool_gap_count: safeInteger(value.spoolGapCount) };
}
interface MetadataFact {
  readonly sequence: number; readonly eventId: string; readonly occurredAt: number;
  readonly action: string; readonly category: AuditCategory;
  readonly siteId: string | null; readonly siteName: string | null;
}
interface MetadataSource {
  readonly sequence: number; readonly headEventId: string | null;
  readonly actions: Map<string, MetadataFact>; readonly sites: Map<string, MetadataFact>;
}
interface MetadataCatalog {
  readonly dataVersion: number; readonly schemaVersion: number; readonly cutoff: number;
  readonly core: MetadataSource; readonly activity: MetadataSource;
}
// The connection owns its catalog: closing/replacing it cannot retain an old
// instance's historical choices or keep a global collection of databases alive.
const metadataCatalogs = new WeakMap<DatabaseSync, MetadataCatalog>();
function metadataFact(row: AuditRow): MetadataFact {
  return { sequence: safeInteger(row.sequence), eventId: String(row.event_id), occurredAt: safeInteger(row.occurred_at),
    action: String(row.action), category: row.category as AuditCategory, siteId: textOrNull(row.site_id), siteName: textOrNull(row.site_name) };
}
function laterFact(left: MetadataFact, right: MetadataFact): boolean {
  return left.occurredAt > right.occurredAt || (left.occurredAt === right.occurredAt && left.sequence > right.sequence);
}
function rememberFact(map: Map<string, MetadataFact>, key: string, fact: MetadataFact): void {
  const previous = map.get(key);
  if (!previous || laterFact(fact, previous)) map.set(key, fact);
}
function metadataProjection(source: AuditSource): string {
  return source === "core"
    ? `SELECT e.sequence, e.event_id, e.occurred_at, e.action, ${CORE_CATEGORY} AS category,
        COALESCE(c.site_id, CASE WHEN e.subject_type = 'website' AND e.subject_id != 'defaults' THEN e.subject_id END) AS site_id, c.site_name
        FROM audit_events e LEFT JOIN audit_event_context c USING(event_id)`
    : `SELECT sequence, event_id, occurred_at, action, ${ACTIVITY_CATEGORY} AS category, site_id, site_name FROM activity_events`;
}
function activityWitnessesPresent(db: DatabaseSync, state: MetadataSource): boolean {
  // Normal minute-counter updates do not change metadata. Verify just the
  // representative events so local retention/deletions cannot leave ghost
  // choices, without counting or rescanning the retained activity table.
  const facts = new Map([...state.actions.values(), ...state.sites.values()].map(fact => [fact.sequence, fact]));
  const sequences = [...facts.keys()];
  for (let offset = 0; offset < sequences.length; offset += 500) {
    const chunk = sequences.slice(offset, offset + 500);
    const rows = db.prepare(`${metadataProjection("activity")} WHERE sequence IN (${chunk.map(() => "?").join(",")})`).all(...chunk);
    if (rows.length !== chunk.length) return false;
    for (const row of rows) if (JSON.stringify(metadataFact(row)) !== JSON.stringify(facts.get(safeInteger(row.sequence)))) return false;
  }
  return true;
}
function readMetadataSource(db: DatabaseSync, source: AuditSource, cutoff: number, previous?: MetadataSource): MetadataSource {
  const table = source === "core" ? "audit_events" : "activity_events";
  const head = db.prepare(`SELECT sequence, event_id FROM ${table} ORDER BY sequence DESC LIMIT 1`).get();
  const sequence = head ? safeInteger(head.sequence) : 0, headEventId = head ? String(head.event_id) : null;
  let saved = previous;
  if (saved && (sequence < saved.sequence || (sequence === saved.sequence && headEventId !== saved.headEventId))) saved = undefined;
  if (saved && sequence > saved.sequence && saved.sequence > 0 &&
    db.prepare(`SELECT event_id FROM ${table} WHERE sequence = ?`).get(saved.sequence)?.event_id !== saved.headEventId) saved = undefined;
  if (saved && source === "activity") {
    saved = { ...saved,
      actions: new Map([...saved.actions].filter(([, fact]) => fact.occurredAt >= cutoff)),
      sites: new Map([...saved.sites].filter(([, fact]) => fact.occurredAt >= cutoff)) };
    if (!activityWitnessesPresent(db, saved)) saved = undefined;
  }
  const actions = new Map(saved?.actions), sites = new Map(saved?.sites);
  if (!saved || sequence > saved.sequence) {
    const minimum = saved?.sequence ?? 0;
    const where = "sequence > ? AND sequence <= ?" + (source === "activity" ? " AND occurred_at >= ?" : "");
    const values = source === "activity" ? [minimum, sequence, cutoff] : [minimum, sequence];
    const projection = metadataProjection(source);
    // A cold connection builds the historical catalog once. All subsequent
    // appends are read by sequence, including delayed events with old timestamps.
    // SQLite's single MAX selects a representative row at that latest time.
    for (const row of db.prepare(`SELECT *, MAX(occurred_at) AS occurred_at FROM (${projection}) WHERE ${where} GROUP BY action, category`).all(...values)) {
      const fact = metadataFact(row);
      rememberFact(actions, JSON.stringify([fact.category, fact.action]), fact);
    }
    // On a cold activity catalog, enumerate the small site-key index and seek
    // each site's latest retained event. Sorting every activity row by site
    // would otherwise dominate the first metadata request on busy instances.
    const siteRows = source === "activity" && !saved
      ? db.prepare(`${projection} WHERE sequence IN (
          SELECT (SELECT sequence FROM activity_events recent WHERE recent.site_id = keys.site_id
            AND occurred_at >= ? AND sequence <= ? ORDER BY occurred_at DESC, sequence DESC LIMIT 1)
          FROM (SELECT DISTINCT site_id FROM activity_events WHERE site_id IS NOT NULL) keys
        )`).all(cutoff, sequence)
      : db.prepare(`SELECT * FROM (
          SELECT *, ROW_NUMBER() OVER (PARTITION BY site_id ORDER BY occurred_at DESC, sequence DESC) AS site_rank
          FROM (${projection}) WHERE ${where} AND site_id IS NOT NULL
        ) WHERE site_rank = 1`).all(...values);
    for (const row of siteRows) {
      const fact = metadataFact(row);
      rememberFact(sites, fact.siteId!, fact);
    }
  }
  return { sequence, headEventId, actions, sites };
}
export function queryAuditMetadata(database: ReadDatabase, capture?: AuditCaptureState, now = Date.now()): AuditMetadata {
  return database.read(db => {
    requireAuditTables(db);
    const cutoff = Math.max(0, now - ACTIVITY_RETENTION_DAYS * DAY);
    const dataVersion = Number(db.prepare("PRAGMA data_version").get()!.data_version);
    const schemaVersion = Number(db.prepare("PRAGMA schema_version").get()!.schema_version);
    // Never publish uncommitted facts. An external writer/schema replacement or
    // backwards clock movement invalidates the catalog before its next use.
    const cached = db.isTransaction ? undefined : metadataCatalogs.get(db);
    const previous = cached?.dataVersion === dataVersion && cached.schemaVersion === schemaVersion && cached.cutoff <= cutoff ? cached : undefined;
    const core = readMetadataSource(db, "core", cutoff, previous?.core);
    const activity = readMetadataSource(db, "activity", cutoff, previous?.activity);
    if (!db.isTransaction) metadataCatalogs.set(db, { dataVersion, schemaVersion, cutoff, core, activity });
    const actionFacts = new Map([...core.actions, ...activity.actions]);
    const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
    const actions = [...actionFacts.values()].map(fact => ({ action: fact.action, category: fact.category }))
      .sort((left, right) => compare(left.category, right.category) || compare(left.action, right.action));
    const siteFacts = new Map(core.sites);
    for (const [id, fact] of activity.sites) {
      const coreFact = siteFacts.get(id);
      if (!coreFact || fact.occurredAt > coreFact.occurredAt) siteFacts.set(id, fact);
    }
    const sites = new Map([...siteFacts].map(([id, fact]) => [id, { site_id: id, site_name: fact.siteName, deleted: true }]));
    if (hasTable(db, "sites")) for (const row of db.prepare("SELECT client_id, json_extract(configuration, '$.name') AS name, deleted_at FROM sites").all()) {
      sites.set(String(row.client_id), { site_id: String(row.client_id), site_name: textOrNull(row.name), deleted: row.deleted_at !== null });
    }
    return { actions, sites: [...sites.values()].sort((left, right) => (left.site_name ?? left.site_id).localeCompare(right.site_name ?? right.site_id)),
      capture: capture ?? projectAuditCaptureState(null), retention: { activity_days: ACTIVITY_RETENTION_DAYS, core: "indefinite" } };
  });
}
function csvTimestamp(value: string): string { return new Date(Date.parse(value) + 8 * 3_600_000).toISOString().replace("T", " ").replace("Z", " +08:00"); }
export function exportAuditEvents(database: ReadDatabase, input: unknown, now = Date.now()): AuditExportResult {
  const parsed = auditExportSchema.safeParse(input);
  if (!parsed.success) throw new ListQueryError("请选择有效的审计导出范围");
  const filters = validateFilters(parsed.data);
  const dates = createdDateRange(filters.created_from, filters.created_to)!;
  if (dates.days > 366) throw new ListQueryError("审计导出日期跨度最多 366 天，请缩小范围");
  const result = database.read(db => {
    requireAuditTables(db);
    const boundary = snapshot(db, now);
    // One SELECT materializes a consistent SQLite read snapshot, including open minute counters.
    return { boundary, rows: selectRows(db, filters, boundary, null, MAX_AUDIT_EXPORT_ROWS + 1, true, now) };
  });
  if (result.rows.length > MAX_AUDIT_EXPORT_ROWS) throw new ListQueryError("导出结果超过 10,000 条，请缩小筛选范围");
  const header = ["来源", "记录编号", "首次发生时间", "最后发生时间", "类别", "动作", "结果", "操作者类型", "操作者", "关联类型", "关联编号", "业务网站ID", "业务网站名称", "来源IP", "设备User-Agent", "请求ID", "内部活动ID", "次数", "累计耗时ms", "HTTP方法", "路由", "HTTP状态", "安全详情", "字段变化", "事件哈希", "前一事件哈希", "上下文指纹"];
  const rows = result.rows.map(row => {
    const entry = item(row);
    return [entry.source === "core" ? "核心审计" : "运行活动", entry.event_id, csvTimestamp(entry.first_occurred_at), csvTimestamp(entry.last_occurred_at), AUDIT_CATEGORY_LABELS[entry.category], entry.action,
      entry.outcome === "SUCCESS" ? "成功" : "失败", entry.actor_type, entry.actor_id ?? "", entry.subject_type ?? "", entry.subject_id ?? "", entry.site_id ?? "", entry.site_name ?? "",
      entry.source_address ?? "", entry.user_agent ?? "", entry.request_id ?? "", entry.activity_id ?? "", String(entry.event_count), entry.duration_ms === null ? "" : String(entry.duration_ms),
      entry.http_method ?? "", entry.route ?? "", entry.http_status === null ? "" : String(entry.http_status), JSON.stringify(safeDetails(row.details_json)), JSON.stringify(changes(row.context_json)),
      textOrNull(row.event_hash) ?? "", textOrNull(row.previous_hash) ?? "", textOrNull(row.context_fingerprint) ?? ""];
  });
  const { q, ...safeFilters } = filters;
  return { csv: "\uFEFF" + [header, ...rows].map(row => row.map(csvCell).join(",")).join("\r\n") + "\r\n",
    summary: { row_count: rows.length, snapshot: result.boundary, filters: { ...safeFilters, q_fingerprint: q ? createHash("sha256").update(q).digest("hex") : null } } };
}
