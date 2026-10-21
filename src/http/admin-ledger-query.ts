import { createHash } from "node:crypto";
import type { AppDatabase } from "../database/database.ts";
import type { AdminLedgerCursor, AdminLedgerQuery } from "../ledger/admin-query.ts";
import type { LedgerDirection, LedgerEntryState } from "../ledger/model.ts";
import { providerEndpoint, type ProviderEnvironment } from "../settings/model.ts";
import { createdDateRange, CreatedDateError } from "../shared/created-dates.ts";
import { ListQueryError, normalizeKeyword } from "../shared/list-query.ts";

type ReadDatabase = Pick<AppDatabase, "read">;
export interface AdminLedgerPageQuery extends Omit<AdminLedgerQuery, "environment"> {
  readonly environment: ProviderEnvironment | null;
  readonly q: string;
  readonly sortOrder: "asc" | "desc";
  readonly limit: number;
  readonly cursor: AdminLedgerCursor | null;
}
const QUERY_KEYS = new Set([
  "q", "direction", "state", "occurred_from", "occurred_to", "min_amount_cents",
  "max_amount_cents", "sort_by", "sort_order", "limit", "cursor",
]);
const STATES: readonly LedgerEntryState[] = [
  "UNALLOCATED", "CANDIDATE", "ALLOCATED", "CONFLICT", "ISOLATED", "IGNORED",
];
const CURSOR_PREFIX = "perpay:admin-ledger:v1";

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
  if ((values.get("sort_by") ?? "occurred_at") !== "occurred_at") throw new ListQueryError("流水排序方式无效，请按交易时间排序");
  const sortOrder = values.get("sort_order") ?? "desc";
  if (sortOrder !== "asc" && sortOrder !== "desc") throw new ListQueryError("请选择按交易时间从新到旧或从旧到新排序");
  const limitText = values.get("limit") ?? "20";
  if (!/^[1-9][0-9]{0,2}$/.test(limitText) || Number(limitText) > 100) throw new ListQueryError("流水每页条数须为 1 至 100");
  const direction = values.get("direction");
  if (direction !== null && direction !== "CREDIT" && direction !== "DEBIT") throw new ListQueryError("请选择收入或支出，或清除收支筛选");
  const state = values.get("state");
  if (state !== null && !STATES.includes(state as LedgerEntryState)) throw new ListQueryError("PerPay 处理状态筛选无效，请重新选择");
  const occurredFrom = values.get("occurred_from") ?? undefined;
  const occurredTo = values.get("occurred_to") ?? undefined;
  try { createdDateRange(occurredFrom, occurredTo); } catch (error) {
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
    environment, q: normalizeKeyword(values.get("q") ?? ""), sortOrder, limit: Number(limitText), cursor: null,
    ...(direction !== null ? { direction: direction as LedgerDirection } : {}),
    ...(state !== null ? { state: state as LedgerEntryState } : {}),
    ...(occurredFrom !== undefined ? { occurredFrom, occurredTo: occurredTo! } : {}),
    ...(minAmountCents !== undefined ? { minAmountCents } : {}),
    ...(maxAmountCents !== undefined ? { maxAmountCents } : {}),
  };
  return { ...query, cursor: values.has("cursor") ? decodeAdminLedgerCursor(values.get("cursor")!, query) : null };
}

function fingerprint(query: AdminLedgerPageQuery): string {
  return createHash("sha256").update(JSON.stringify([
    query.environment, query.q, query.direction ?? null, query.state ?? null,
    query.occurredFrom ?? null, query.occurredTo ?? null,
    query.minAmountCents ?? null, query.maxAmountCents ?? null,
    "occurred_at", query.sortOrder, query.limit,
  ])).digest("hex");
}

export function encodeAdminLedgerCursor(position: AdminLedgerCursor | null, query: AdminLedgerPageQuery): string | null {
  return position ? Buffer.from(JSON.stringify([
    CURSOR_PREFIX, fingerprint(query), position.occurred_at_ms, position.external_event_id,
  ]), "utf8").toString("base64url") : null;
}

function decodeAdminLedgerCursor(value: string, query: AdminLedgerPageQuery): AdminLedgerCursor {
  const invalid = () => new ListQueryError("翻页信息无效或与当前筛选不符，请返回第一页重新查询");
  if (!/^[A-Za-z0-9_-]{1,4096}$/.test(value)) throw invalid();
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) throw invalid();
  let parts: unknown;
  try { parts = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw invalid(); }
  if (!Array.isArray(parts) || parts.length !== 4 || parts[0] !== CURSOR_PREFIX || parts[1] !== fingerprint(query) ||
      !Number.isSafeInteger(parts[2]) || parts[2] < 0 || typeof parts[3] !== "string" ||
      parts[3].length < 1 || parts[3].length > 256 || parts[3].includes("\0") || !parts[3].isWellFormed()) throw invalid();
  return { occurred_at_ms: parts[2], external_event_id: parts[3] };
}
