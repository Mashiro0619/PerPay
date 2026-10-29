import { createHash } from "node:crypto";
import type { AppDatabase } from "../database/database.ts";
import {
  ADMIN_LEDGER_SORT_FIELDS, type AdminLedgerAssociationStatus, type AdminLedgerCursor,
  type AdminLedgerQuery, type AdminLedgerSort,
} from "../ledger/admin-query.ts";
import type { LedgerDirection, LedgerEntryState } from "../ledger/model.ts";
import { providerEndpoint, type ProviderEnvironment } from "../settings/model.ts";
import { createdDateRange, CreatedDateError } from "../shared/created-dates.ts";
import { ListQueryError, normalizeKeyword } from "../shared/list-query.ts";

type ReadDatabase = Pick<AppDatabase, "read">;
export interface AdminLedgerPageQuery extends Omit<AdminLedgerQuery, "environment"> {
  readonly environment: ProviderEnvironment | null;
  readonly q: string;
  readonly sortBy: AdminLedgerSort;
  readonly sortOrder: "asc" | "desc";
  readonly limit: number;
  readonly cursor: AdminLedgerCursor | null;
}
const QUERY_KEYS = new Set([
  "q", "direction", "state", "occurred_from", "occurred_to", "min_amount_cents",
  "max_amount_cents", "sort_by", "sort_order", "limit", "cursor",
  "association_status", "has_reversals", "associated_from", "associated_to",
  "alipay_account_id",
]);
const STATES: readonly LedgerEntryState[] = [
  "UNALLOCATED", "CANDIDATE", "ALLOCATED", "CONFLICT", "ISOLATED", "IGNORED",
];
const CURSOR_PREFIX = "perpay:admin-ledger:v1";
const EXTENDED_CURSOR_PREFIX = "perpay:admin-ledger:v2";

function endpointEnvironment(endpoint: unknown): ProviderEnvironment | null {
  if (endpoint === providerEndpoint("PRODUCTION")) return "PRODUCTION";
  if (endpoint === providerEndpoint("SANDBOX")) return "SANDBOX";
  return null;
}

/** Historical evidence stays readable when provider configuration is unavailable. */
export function resolveAdminLedgerEnvironment(
  database: ReadDatabase,
  currentEnvironment: () => ProviderEnvironment | null | undefined,
): ProviderEnvironment | null {
  try {
    const environment = currentEnvironment();
    if (environment === "PRODUCTION" || environment === "SANDBOX") return environment;
  } catch {
    // Only configuration lookup may fall back; database read failures still propagate.
  }
  return database.read(db => {
    const row = db.prepare(`SELECT provider_endpoint FROM (
      SELECT binding.provider_endpoint, 0 AS priority, activation.sequence AS position
        FROM provider_account_activations AS activation
        JOIN provider_account_bindings AS binding USING (provider_account_key)
      UNION ALL
      SELECT provider_endpoint, 1 AS priority, bound_at AS position
        FROM provider_account_bindings
    ) ORDER BY priority, position DESC, provider_endpoint LIMIT 1`).get();
    return endpointEnvironment(row?.provider_endpoint);
  });
}

/** Detail lookup follows the real source identity, independent of current settings. */
export function adminLedgerEntryEnvironment(database: ReadDatabase, ledgerEntryId: string): ProviderEnvironment | null {
  return database.read(db => endpointEnvironment(db.prepare(`
    SELECT binding.provider_endpoint FROM ledger_entries AS entry
    JOIN provider_account_bindings AS binding USING (provider_account_key)
    WHERE entry.ledger_entry_id = ?`).get(ledgerEntryId)?.provider_endpoint));
}

export function readAdminLedgerPageQuery(values: URLSearchParams, environment: ProviderEnvironment | null): AdminLedgerPageQuery {
  for (const key of values.keys()) {
    if (!QUERY_KEYS.has(key) || values.getAll(key).length !== 1) {
      throw new ListQueryError("流水筛选条件无效或重复，请重新设置筛选条件");
    }
  }
  const sortBy = values.get("sort_by") ?? "occurred_at";
  const alipayAccountId = values.get("alipay_account_id");
  if (alipayAccountId !== null && !/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(alipayAccountId)) throw new ListQueryError("收款账号筛选无效，请重新选择");
  if (!ADMIN_LEDGER_SORT_FIELDS.includes(sortBy as AdminLedgerSort)) throw new ListQueryError("流水排序方式无效，请重新选择");
  const sortOrder = values.get("sort_order") ?? "desc";
  if (sortOrder !== "asc" && sortOrder !== "desc") throw new ListQueryError("流水排序方向无效，请重新选择");
  const limitText = values.get("limit") ?? "20";
  if (!/^[1-9][0-9]{0,2}$/.test(limitText) || Number(limitText) > 100) throw new ListQueryError("流水每页条数须为 1 至 100");
  const direction = values.get("direction");
  if (direction !== null && direction !== "CREDIT" && direction !== "DEBIT") throw new ListQueryError("请选择收入或支出，或清除收支筛选");
  const state = values.get("state");
  if (state !== null && !STATES.includes(state as LedgerEntryState)) throw new ListQueryError("PerPay 处理状态筛选无效，请重新选择");
  const associationStatus = values.get("association_status");
  if (associationStatus !== null && !["UNMATCHED", "MATCHED", "MULTIPLE"].includes(associationStatus)) throw new ListQueryError("收款关联状态筛选无效，请重新选择");
  const hasReversals = values.get("has_reversals");
  if (hasReversals !== null && hasReversals !== "true" && hasReversals !== "false") throw new ListQueryError("关联撤销历史筛选无效，请重新选择");
  const occurredFrom = values.get("occurred_from") ?? undefined;
  const occurredTo = values.get("occurred_to") ?? undefined;
  const associatedFrom = values.get("associated_from") ?? undefined;
  const associatedTo = values.get("associated_to") ?? undefined;
  try {
    createdDateRange(occurredFrom, occurredTo);
    createdDateRange(associatedFrom, associatedTo);
  } catch (error) {
    if (error instanceof CreatedDateError) throw new ListQueryError(error.message);
    throw error;
  }
  const amount = (key: string) => {
    const value = values.get(key);
    if (value === null) return undefined;
    if (!/^(0|[1-9][0-9]{0,11})$/.test(value) || Number(value) > 999_999_999_999) throw new ListQueryError("流水金额范围无效，请重新设置金额筛选");
    return Number(value);
  };
  const minAmountCents = amount("min_amount_cents"), maxAmountCents = amount("max_amount_cents");
  if (minAmountCents !== undefined && maxAmountCents !== undefined && minAmountCents > maxAmountCents) throw new ListQueryError("流水最小金额不能大于最大金额");
  const query: AdminLedgerPageQuery = {
    ...(alipayAccountId !== null ? { alipayAccountId } : {}),
    environment, q: normalizeKeyword(values.get("q") ?? ""), sortBy: sortBy as AdminLedgerSort, sortOrder, limit: Number(limitText), cursor: null,
    ...(direction !== null ? { direction: direction as LedgerDirection } : {}),
    ...(state !== null ? { state: state as LedgerEntryState } : {}),
    ...(associationStatus !== null ? { associationStatus: associationStatus as AdminLedgerAssociationStatus } : {}),
    ...(hasReversals !== null ? { hasReversals: hasReversals === "true" } : {}),
    ...(occurredFrom !== undefined ? { occurredFrom, occurredTo: occurredTo! } : {}),
    ...(associatedFrom !== undefined ? { associatedFrom, associatedTo: associatedTo! } : {}),
    ...(minAmountCents !== undefined ? { minAmountCents } : {}),
    ...(maxAmountCents !== undefined ? { maxAmountCents } : {}),
  };
  return { ...query, cursor: values.has("cursor") ? decodeAdminLedgerCursor(values.get("cursor")!, query) : null };
}

function fingerprint(query: AdminLedgerPageQuery, legacy = false): string {
  const values: unknown[] = [
    query.environment, query.q, query.direction ?? null, query.state ?? null,
    query.occurredFrom ?? null, query.occurredTo ?? null,
    query.minAmountCents ?? null, query.maxAmountCents ?? null,
    query.sortBy, query.sortOrder, query.limit,
  ];
  if (!legacy) values.push(query.associationStatus ?? null, query.hasReversals ?? null, query.associatedFrom ?? null, query.associatedTo ?? null);
  if (query.alipayAccountId !== undefined) values.push(query.alipayAccountId);
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}

function legacyQuery(query: AdminLedgerPageQuery): boolean {
  return query.alipayAccountId === undefined && query.sortBy === "occurred_at" && query.associationStatus === undefined && query.hasReversals === undefined &&
    query.associatedFrom === undefined && query.associatedTo === undefined;
}

export function encodeAdminLedgerCursor(position: AdminLedgerCursor | null, query: AdminLedgerPageQuery): string | null {
  const legacy = legacyQuery(query);
  return position ? Buffer.from(JSON.stringify([
    legacy ? CURSOR_PREFIX : EXTENDED_CURSOR_PREFIX, fingerprint(query, legacy),
    "sort_value" in position ? position.sort_value : position.occurred_at_ms, position.external_event_id,
  ]), "utf8").toString("base64url") : null;
}

function decodeAdminLedgerCursor(value: string, query: AdminLedgerPageQuery): AdminLedgerCursor {
  const invalid = () => new ListQueryError("翻页信息无效或与当前筛选不符，请返回第一页重新查询");
  if (!/^[A-Za-z0-9_-]{1,4096}$/.test(value)) throw invalid();
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) throw invalid();
  let parts: unknown;
  try { parts = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw invalid(); }
  if (!Array.isArray(parts) || parts.length !== 4) throw invalid();
  const legacy = parts[0] === CURSOR_PREFIX;
  if ((legacy ? !legacyQuery(query) : parts[0] !== EXTENDED_CURSOR_PREFIX) || parts[1] !== fingerprint(query, legacy) ||
      (parts[2] !== null && (!Number.isSafeInteger(parts[2]) || parts[2] < 0)) ||
      (query.sortBy === "occurred_at" && parts[2] === null) || typeof parts[3] !== "string" ||
      parts[3].length < 1 || parts[3].length > (query.environment === null || query.alipayAccountId !== undefined ? 2048 : 256) || parts[3].includes("\0") || !parts[3].isWellFormed()) throw invalid();
  return query.sortBy === "occurred_at"
    ? { occurred_at_ms: parts[2], external_event_id: parts[3] }
    : { sort_value: parts[2], external_event_id: parts[3] };
}
