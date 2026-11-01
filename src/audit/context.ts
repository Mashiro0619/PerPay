// SPDX-License-Identifier: MIT
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { normalizeIpAddress } from "../infrastructure/network/ip-policy.ts";

export type AuditActorType = "SYSTEM" | "ANONYMOUS" | "ADMIN" | "API_CLIENT";
export type AuditJsonValue = null | boolean | number | string | AuditJsonValue[] | { [key: string]: AuditJsonValue };
export interface AuditChange {
  readonly field: string;
  readonly kind: "value" | "redacted_change";
  readonly before?: AuditJsonValue | undefined;
  readonly after?: AuditJsonValue | undefined;
  readonly configured_before?: boolean | undefined;
  readonly configured_after?: boolean | undefined;
}
export interface AuditContextInput {
  readonly activityId?: string | null | undefined;
  readonly requestId?: string | null | undefined;
  readonly sourceAddress?: string | null | undefined;
  readonly userAgent?: string | null | undefined;
  readonly actorType?: AuditActorType | undefined;
  readonly actorId?: string | null | undefined;
  readonly siteId?: string | null | undefined;
  readonly siteName?: string | null | undefined;
  readonly changes?: readonly AuditChange[] | undefined;
}
export interface AuditScope {
  activityId: string;
  requestId: string | null;
  sourceAddress: string | null;
  userAgent: string | null;
  actorType: AuditActorType;
  actorId: string | null;
  siteId: string | null;
  siteName: string | null;
  subjectType: string | null;
  subjectId: string | null;
  coreEventIds: string[];
  errorCode: string | null;
}
export interface StoredAuditContext {
  readonly version: 1;
  readonly activity_id: string | null;
  readonly request_id: string | null;
  readonly source_address: string | null;
  readonly user_agent: string | null;
  readonly site_id: string | null;
  readonly site_name: string | null;
  readonly changes: readonly AuditChange[];
}

export const MAX_AUDIT_CONTEXT_BYTES = 64 * 1024;
const scopeStorage = new AsyncLocalStorage<AuditScope>();
const sensitiveField = /password|secret|token|cookie|private|credential|authorization|signature|code[_-]?payload|collection[_-]?code|public[_-]?key/i;

export function normalizeAuditAddress(value: string | null | undefined): string | null {
  return normalizeIpAddress(value ?? undefined) ?? null;
}
export function normalizeAuditUserAgent(value: string | null | undefined): string | null {
  if (typeof value !== "string" || !value.isWellFormed() || /\p{Cc}/u.test(value) || Buffer.byteLength(value, "utf8") > 1024) return null;
  return value.trim() || null;
}
export function createAuditContext(input: AuditContextInput = {}): AuditScope {
  return {
    activityId: input.activityId ?? randomUUID(),
    requestId: boundedText(input.requestId, 128),
    sourceAddress: normalizeAuditAddress(input.sourceAddress),
    userAgent: normalizeAuditUserAgent(input.userAgent),
    actorType: input.actorType ?? "SYSTEM",
    actorId: boundedText(input.actorId, 128),
    siteId: boundedText(input.siteId, 128),
    siteName: boundedText(input.siteName, 256),
    subjectType: null,
    subjectId: null,
    coreEventIds: [],
    errorCode: null,
  };
}
export function currentAuditContext(): AuditScope | undefined { return scopeStorage.getStore(); }
export function runWithAuditContext<T>(context: AuditScope, operation: () => T): T {
  return scopeStorage.run(context, operation);
}
export function auditContextAvailable(connection: DatabaseSync): boolean {
  if (connection.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'audit_event_context'").get() !== undefined) return true;
  if (connection.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'").get() &&
    Number(connection.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version ?? 0) >= 39) {
    throw new Error("audit context storage is unavailable");
  }
  return false;
}
export function auditSiteContext(connection: DatabaseSync, siteId: string | null): Pick<AuditContextInput, "siteId" | "siteName"> {
  if (siteId === null) return { siteId: null, siteName: null };
  const available = connection.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'sites'").get();
  const row = available ? connection.prepare("SELECT json_extract(configuration, '$.name') AS name FROM sites WHERE client_id = ?").get(siteId) : undefined;
  return { siteId, siteName: typeof row?.name === "string" ? row.name : null };
}

/** Only explicitly selected fields enter an audit diff. Never pass whole HTTP bodies. */
export function auditChanges(
  before: unknown,
  after: unknown,
  fields: readonly string[],
  redactedFields: readonly string[] = [],
): AuditChange[] {
  const changes: AuditChange[] = [];
  for (const field of fields) {
    const left = fieldValue(before, field), right = fieldValue(after, field);
    if (canonicalAuditJson(left) === canonicalAuditJson(right)) continue;
    if (sensitiveField.test(field) || redactedFields.includes(field)) {
      changes.push(redactedAuditChange(field, configured(left), configured(right)));
    } else {
      changes.push({ field, kind: "value", before: safeValue(left, field), after: safeValue(right, field) });
    }
  }
  return changes;
}
export function redactedAuditChange(field: string, before = true, after = true): AuditChange {
  return { field, kind: "redacted_change", configured_before: before, configured_after: after };
}

export function serializeAuditContext(input: AuditContextInput = {}): { value: StoredAuditContext; json: string; fingerprint: string } {
  const scope = currentAuditContext();
  const choose = <T>(specified: T | undefined, inherited: T | undefined): T | undefined => specified === undefined ? inherited : specified;
  const value: StoredAuditContext = {
    version: 1,
    activity_id: boundedText(choose(input.activityId, scope?.activityId), 128),
    request_id: boundedText(choose(input.requestId, scope?.requestId), 128),
    source_address: normalizeAuditAddress(choose(input.sourceAddress, scope?.sourceAddress)),
    user_agent: normalizeAuditUserAgent(choose(input.userAgent, scope?.userAgent)),
    site_id: boundedText(choose(input.siteId, scope?.siteId), 128),
    site_name: boundedText(choose(input.siteName, scope?.siteName), 256),
    changes: (input.changes ?? []).map(change => {
      if (change.kind === "redacted_change" || sensitiveField.test(change.field)) {
        return redactedAuditChange(change.field,
          change.configured_before ?? configured(change.before), change.configured_after ?? configured(change.after));
      }
      return { field: change.field, kind: "value" as const, before: safeValue(change.before, change.field), after: safeValue(change.after, change.field) };
    }),
  };
  let json = canonicalAuditJson(value);
  if (Buffer.byteLength(json, "utf8") > MAX_AUDIT_CONTEXT_BYTES) {
    const changes = value.changes.map(change => change.kind === "redacted_change" ? change : {
      ...change, before: summarizeValue(change.before), after: summarizeValue(change.after),
    });
    const compact = { ...value, changes };
    json = canonicalAuditJson(compact);
    if (Buffer.byteLength(json, "utf8") > MAX_AUDIT_CONTEXT_BYTES) {
      // Field paths stay intact; only the optional value previews are removed.
      for (const change of changes) {
        if (change.kind !== "value") continue;
        for (const item of [change.before, change.after]) {
          if (item && typeof item === "object" && !Array.isArray(item) && item.truncated === true) item.preview = "";
        }
      }
      json = canonicalAuditJson(compact);
    }
    if (Buffer.byteLength(json, "utf8") > MAX_AUDIT_CONTEXT_BYTES) throw new Error("audit context field paths exceed the allowed size");
    return { value: compact, json, fingerprint: auditContextFingerprint(json) };
  }
  return { value, json, fingerprint: auditContextFingerprint(json) };
}
export function auditContextFingerprint(json: string): string {
  return createHash("sha256").update("perpay-audit-context-v1\0").update(json, "utf8").digest("hex");
}
export function canonicalAuditJson(value: unknown): string {
  const sort = (entry: unknown): unknown => {
    if (typeof entry === "bigint") return entry.toString();
    if (Array.isArray(entry)) return entry.map(sort);
    if (entry && typeof entry === "object") return Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, sort(child)]));
    return entry;
  };
  return JSON.stringify(sort(value));
}

function boundedText(value: string | null | undefined, maximum: number): string | null {
  if (typeof value !== "string" || !value.isWellFormed() || /\p{Cc}/u.test(value)) return null;
  return value.trim().slice(0, maximum) || null;
}
function fieldValue(record: unknown, field: string): unknown {
  let value = record;
  for (const key of field.split(".")) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, key)) return null;
    value = (value as Record<string, unknown>)[key];
  }
  return value ?? null;
}
function configured(value: unknown): boolean { return value !== null && value !== undefined && value !== "" && value !== false; }
function safeValue(value: unknown, field = "", depth = 0): AuditJsonValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") {
    if (/url|origin/i.test(field)) {
      try { const url = new URL(value); url.username = ""; url.password = ""; url.search = ""; url.hash = ""; return url.toString(); } catch { return "[地址不可用]"; }
    }
    return value.toWellFormed();
  }
  if (depth >= 8) return "[嵌套内容省略]";
  if (Array.isArray(value)) return value.map(item => safeValue(item, field, depth + 1));
  if (typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !sensitiveField.test(key) && !["__proto__", "constructor", "prototype"].includes(key))
    .map(([key, entry]) => [key, safeValue(entry, key, depth + 1)]));
  return null;
}
function summarizeValue(value: AuditJsonValue | undefined): AuditJsonValue {
  const json = canonicalAuditJson(value ?? null);
  if (Buffer.byteLength(json, "utf8") <= 512) return value ?? null;
  return { truncated: true, preview: Array.from(typeof value === "string" ? value : json).slice(0, 128).join(""), bytes: Buffer.byteLength(json, "utf8"), sha256: createHash("sha256").update(json).digest("hex") };
}
