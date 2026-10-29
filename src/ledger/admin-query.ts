import type { DatabaseSync } from "node:sqlite";

import type { AppDatabase } from "../database/database.ts";
import { listCreatedDates, listKeyset, listSearch } from "../database/list-query.ts";
import { providerEndpoint, type ProviderEnvironment } from "../settings/model.ts";
import { CreatedDateError } from "../shared/created-dates.ts";
import { ListQueryError, normalizeKeyword } from "../shared/list-query.ts";
import {
  parseAmountCents,
  parseDirection,
  parseOccurredAtWithPrecision,
  type LedgerConflictStatus,
  type LedgerConflictType,
  type LedgerDirection,
  type LedgerEntryState,
} from "./model.ts";

/** The cursor belongs to a grouped provider event, never to one source copy. */
export type AdminLedgerCursor = { readonly external_event_id: string } & (
  | { readonly occurred_at_ms: number; readonly sort_value?: never }
  | { readonly sort_value: number | null; readonly occurred_at_ms?: never }
);

export const ADMIN_LEDGER_SORT_FIELDS = ["occurred_at", "associated_at", "handled_at", "amount_cents", "event_sequence"] as const;
export type AdminLedgerSort = (typeof ADMIN_LEDGER_SORT_FIELDS)[number];
export type AdminLedgerAssociationStatus = "UNMATCHED" | "MATCHED" | "MULTIPLE";

export interface AdminLedgerQuery {
  readonly environment: ProviderEnvironment | null;
  readonly alipayAccountId?: string;
  readonly q?: string;
  readonly direction?: LedgerDirection;
  readonly state?: LedgerEntryState;
  readonly associationStatus?: AdminLedgerAssociationStatus;
  readonly hasReversals?: boolean;
  readonly associatedFrom?: string;
  readonly associatedTo?: string;
  readonly occurredFrom?: string;
  readonly occurredTo?: string;
  readonly minAmountCents?: number;
  readonly maxAmountCents?: number;
  readonly sortBy?: AdminLedgerSort;
  readonly sortOrder?: "asc" | "desc";
  readonly limit?: number;
  readonly cursor?: AdminLedgerCursor | null;
}

/** A disputed field is null; source records preserve each original value. */
export interface AdminLedgerFacts {
  readonly amount_cents: number | null;
  readonly occurred_at: string | null;
  readonly occurred_at_precision_milliseconds: 1 | 10 | 100 | 1000 | null;
  readonly occurred_at_interval_end_exclusive: string | null;
  readonly direction: LedgerDirection | null;
  readonly currency: "CNY" | null;
  readonly provider_order_no: string | null;
  readonly merchant_order_no: string | null;
  readonly other_account: string | null;
  readonly memo: string | null;
}

export interface AdminLedgerMatch {
  readonly payment_match_id: string;
  /** The member actually used by this financial decision. */
  readonly ledger_entry_id: string;
  readonly order_id: string;
  readonly merchant_order_no: string;
  readonly product_name: string;
  readonly api_client_id: string;
  readonly site_name: string | null;
  readonly evidence_type: "AMOUNT_INFERRED" | "MANUAL";
  readonly status: "SETTLED" | "REVERSED";
  readonly created_at: string;
  readonly resolved_at: string | null;
}

export interface AdminLedgerSummary extends AdminLedgerFacts {
  /** A real source ID for reading this group; never a settlement input. */
  readonly ledger_entry_id: string;
  readonly external_event_id: string;
  readonly environment: ProviderEnvironment;
  readonly alipay_account_id: string | null;
  readonly alipay_account_name: string | null;
  readonly states: readonly LedgerEntryState[];
  readonly source_record_count: number;
  readonly content_consistent: boolean;
  readonly has_conflicts: boolean;
  readonly active_match_count: number;
  readonly active_match: (AdminLedgerMatch & { readonly status: "SETTLED" }) | null;
  readonly reversed_match_count: number;
  readonly last_associated_at: string | null;
  readonly last_handled_at: string | null;
  /** First source observation and latest source update, respectively. */
  readonly created_at: string;
  readonly updated_at: string;
}

export interface AdminLedgerSource extends AdminLedgerFacts {
  readonly ledger_entry_id: string;
  readonly external_event_id: string;
  readonly provider_account_key: string;
  readonly app_id: string;
  readonly environment: ProviderEnvironment;
  readonly alipay_account_id: string | null;
  readonly alipay_account_name: string | null;
  readonly raw_event_id: string;
  readonly semantic_fingerprint: string;
  readonly state: LedgerEntryState;
  readonly amount_cents: number;
  readonly occurred_at: string;
  readonly occurred_at_precision_milliseconds: 1 | 10 | 100 | 1000;
  readonly occurred_at_interval_end_exclusive: string;
  readonly direction: LedgerDirection;
  readonly currency: "CNY";
  readonly created_at: string;
  readonly updated_at: string;
}

export interface AdminLedgerConflict {
  readonly conflict_id: string;
  readonly conflict_type: LedgerConflictType;
  readonly status: LedgerConflictStatus;
  readonly existing_ledger_entry_id: string | null;
  readonly created_at: string;
  readonly resolved_at: string | null;
}

export interface AdminLedgerDetail extends AdminLedgerSummary {
  readonly sources: readonly AdminLedgerSource[];
  readonly matches: readonly AdminLedgerMatch[];
  readonly conflicts: readonly AdminLedgerConflict[];
}

export interface AdminLedgerPage {
  readonly items: readonly AdminLedgerSummary[];
  /** HTTP encodes this validated position in its query-bound opaque cursor. */
  readonly next_cursor: AdminLedgerCursor | null;
}

export type AdminLedgerDatabase = Pick<AppDatabase, "read">;

const STATES: readonly LedgerEntryState[] = [
  "UNALLOCATED", "CANDIDATE", "ALLOCATED", "CONFLICT", "ISOLATED", "IGNORED",
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FACT_KEYS = [
  "amount_cents", "occurred_at", "occurred_at_precision_milliseconds",
  "occurred_at_interval_end_exclusive", "direction", "currency",
  "provider_order_no", "merchant_order_no", "other_account", "memo",
] as const satisfies readonly (keyof AdminLedgerFacts)[];
const duplicateFactConnections = new WeakSet<DatabaseSync>();

interface SourceRow {
  ledger_entry_id: string;
  external_event_id: string;
  provider_account_key: string;
  app_id: string;
  provider_endpoint: string;
  alipay_account_id: string | null;
  alipay_account_name: string | null;
  raw_event_id: string;
  semantic_fingerprint: string;
  state: LedgerEntryState;
  amount_cents: number;
  occurred_at: number;
  occurred_at_precision_ms: 1 | 10 | 100 | 1000;
  direction: LedgerDirection;
  currency: "CNY";
  alipay_order_no: string | null;
  merchant_order_no: string | null;
  other_account: string | null;
  trans_memo: string | null;
  created_at: number;
  updated_at: number;
}
interface MatchRow extends Omit<AdminLedgerMatch, "created_at" | "resolved_at"> {
  created_at: number;
  resolved_at: number | null;
}
interface ConflictRow extends Omit<AdminLedgerConflict, "created_at" | "resolved_at"> {
  created_at: number;
  resolved_at: number | null;
  incoming_semantic_fingerprint: string | null;
  occurred_at_text: string | null;
  amount_text: string | null;
  direction_text: string | null;
  alipay_order_no: string | null;
  merchant_order_no: string | null;
  other_account: string | null;
  trans_memo: string | null;
}
interface GroupRow {
  external_event_id: string;
  sort_at: bigint | number | null;
  sources_json: string;
  matches_json: string;
  conflicts_json: string;
}

/** One SELECT captures the source facts, decisions and conflicts in one read snapshot. */
export function readAdminLedgerPage(
  database: AdminLedgerDatabase,
  query: AdminLedgerQuery,
): AdminLedgerPage {
  const normalized = normalizeQuery(query);
  const { limit, sortBy, includeDuplicateVariants } = normalized;
  const rows = database.read(db => {
    if (includeDuplicateVariants) registerDuplicateFacts(db);
    const statement = groupedQuery(normalized, limit + 1, query.environment === null || query.alipayAccountId !== undefined);
    return db.prepare(statement.sql).all(...statement.parameters);
  }) as unknown as GroupRow[];
  const selected = rows.slice(0, limit);
  const last = selected.at(-1);
  return {
    items: selected.map(row => summarize(row, query.environment).summary),
    next_cursor: rows.length > limit && last ? sortBy === "occurred_at" ? {
      occurred_at_ms: safeInteger(last.sort_at!), external_event_id: last.external_event_id,
    } : {
      sort_value: last.sort_at === null ? null : safeInteger(last.sort_at), external_event_id: last.external_event_id,
    } : null,
  };
}

/** Any real member ID resolves the complete group in the requested environment. */
export function readAdminLedgerDetail(
  database: AdminLedgerDatabase,
  environment: ProviderEnvironment,
  ledgerEntryId: string,
  accounts = false,
): AdminLedgerDetail | null {
  const endpoint = environmentEndpoint(environment);
  if (!UUID.test(ledgerEntryId)) return null;
  const row = database.read(db => {
    const statement = groupedQuery({
    endpoint, where: ["entry.ledger_entry_id = ?"], parameters: [ledgerEntryId], order: "desc",
    sortBy: "occurred_at", cursor: null, includeDuplicateVariants: false, groupWhere: [], groupParameters: [],
    includeMatchMetrics: false,
    }, 1, accounts);
    return db.prepare(statement.sql).get(...statement.parameters);
  }) as unknown as GroupRow | undefined;
  if (!row) return null;
  const { summary, sources, matches, conflicts } = summarize(row, environment);
  return { ...summary, sources, matches, conflicts };
}

function environmentEndpoint(environment: ProviderEnvironment | null): string | null {
  if (environment === null) return null;
  if (environment !== "PRODUCTION" && environment !== "SANDBOX") {
    throw new ListQueryError("支付宝环境无效");
  }
  return providerEndpoint(environment);
}

function normalizeQuery(query: AdminLedgerQuery) {
  const endpoint = environmentEndpoint(query.environment);
  const limit = query.limit ?? 20;
  const order = query.sortOrder ?? "desc";
  const sortBy = query.sortBy ?? "occurred_at";
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new ListQueryError("流水每页条数须为 1 至 100");
  }
  if (order !== "asc" && order !== "desc") throw new ListQueryError("流水排序方向无效");
  if (!ADMIN_LEDGER_SORT_FIELDS.includes(sortBy)) throw new ListQueryError("流水排序方式无效");
  const keyword = normalizeKeyword(query.q ?? "");
  const search = listSearch([
    "entry.ledger_entry_id", "entry.external_provider_event_id", "entry.alipay_order_no",
    "entry.merchant_order_no", "entry.other_account", "entry.trans_memo",
    "entry.provider_account_key", "binding.external_account_id",
  ], keyword);
  const orderSearch = listSearch([
    "linked_match.payment_match_id", "linked_order.order_id", "linked_order.merchant_order_no", "linked_order.product_name",
  ], keyword);
  const where: string[] = search.where ? [`(${search.where} OR EXISTS (
    SELECT 1 FROM payment_matches AS linked_match
    JOIN payment_orders AS linked_order ON linked_order.order_id = linked_match.order_id
    WHERE linked_match.ledger_entry_id = entry.ledger_entry_id AND ${orderSearch.where}
  ))`] : [];
  const parameters: Array<string | number> = [...search.parameters, ...orderSearch.parameters];
  if (query.alipayAccountId !== undefined) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(query.alipayAccountId)) throw new ListQueryError("收款账号筛选无效");
    where.push("entry.alipay_account_id = ?"); parameters.push(query.alipayAccountId);
  }
  try {
    const dates = listCreatedDates("entry.occurred_at", query.occurredFrom, query.occurredTo);
    if (dates.where) where.push(dates.where);
    parameters.push(...dates.parameters);
  } catch (error) {
    if (error instanceof CreatedDateError) throw new ListQueryError(error.message);
    throw error;
  }
  if (query.direction !== undefined) {
    if (query.direction !== "CREDIT" && query.direction !== "DEBIT") throw new ListQueryError("流水收支方向无效");
    where.push("entry.direction = ?"); parameters.push(query.direction);
  }
  if (query.state !== undefined) {
    if (!STATES.includes(query.state)) throw new ListQueryError("流水状态无效");
    where.push("entry.state = ?"); parameters.push(query.state);
  }
  for (const [value, compare] of [[query.minAmountCents, ">="], [query.maxAmountCents, "<="]] as const) {
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 0 || value > 999_999_999_999) {
      throw new ListQueryError("流水金额须为有效的整数分");
    }
    where.push("entry.amount_cents " + compare + " ?"); parameters.push(value);
  }
  if (query.minAmountCents !== undefined && query.maxAmountCents !== undefined && query.minAmountCents > query.maxAmountCents) {
    throw new ListQueryError("流水最小金额不能大于最大金额");
  }
  const groupWhere: string[] = [], groupParameters: Array<string | number> = [];
  if (query.associationStatus !== undefined) {
    const counts = { UNMATCHED: "= 0", MATCHED: ">= 1", MULTIPLE: "> 1" } as const;
    if (!Object.hasOwn(counts, query.associationStatus)) throw new ListQueryError("收款关联状态无效");
    groupWhere.push("COALESCE(match_metrics.active_match_count, 0) " + counts[query.associationStatus]);
  }
  if (query.hasReversals !== undefined) {
    if (typeof query.hasReversals !== "boolean") throw new ListQueryError("关联撤销历史筛选无效");
    groupWhere.push("COALESCE(match_metrics.reversed_match_count, 0) " + (query.hasReversals ? "> 0" : "= 0"));
  }
  try {
    const dates = listCreatedDates("associated_match.created_at", query.associatedFrom, query.associatedTo);
    if (dates.where) {
      groupWhere.push(`EXISTS (SELECT 1 FROM members AS associated_member
        CROSS JOIN payment_matches AS associated_match
        WHERE associated_member.external_event_id = anchor.external_event_id
          AND associated_match.ledger_entry_id = associated_member.ledger_entry_id AND ${dates.where})`);
      groupParameters.push(...dates.parameters);
    }
  } catch (error) {
    if (error instanceof CreatedDateError) throw new ListQueryError(error.message);
    throw error;
  }
  const cursor = query.cursor ?? null;
  const cursorValue = cursor && ("sort_value" in cursor ? cursor.sort_value : cursor.occurred_at_ms);
  if (cursor && ((cursorValue !== null && (!Number.isSafeInteger(cursorValue) || cursorValue === undefined || cursorValue < 0)) ||
    (sortBy === "occurred_at" && cursorValue === null) ||
    (sortBy !== "occurred_at" && !("sort_value" in cursor)) ||
    typeof cursor.external_event_id !== "string" || cursor.external_event_id.length < 1 ||
    cursor.external_event_id.length > (query.environment === null || query.alipayAccountId !== undefined ? 2048 : 256) || cursor.external_event_id.includes("\0") ||
    !cursor.external_event_id.isWellFormed())) {
    throw new ListQueryError("流水分页游标无效");
  }
  const includeDuplicateVariants = !!keyword || query.direction !== undefined || sortBy === "amount_cents" ||
    query.occurredFrom !== undefined || query.minAmountCents !== undefined || query.maxAmountCents !== undefined;
  const includeMatchMetrics = query.associationStatus !== undefined || query.hasReversals !== undefined ||
    sortBy === "associated_at" || sortBy === "handled_at" || sortBy === "event_sequence";
  return { endpoint, where, parameters, limit, order, sortBy, cursor, includeDuplicateVariants, groupWhere, groupParameters, includeMatchMetrics };
}

/** Connection-local scalar functions do not change persisted data or the read snapshot. */
function registerDuplicateFacts(database: DatabaseSync) {
  if (duplicateFactConnections.has(database)) return;
  database.function("perpay_admin_ledger_duplicate_facts", { deterministic: true, directOnly: true }, (amount, occurredAt, direction) => {
    if (typeof amount !== "string" || typeof occurredAt !== "string" || typeof direction !== "string") return null;
    try {
      return JSON.stringify({
        amount_cents: parseAmountCents(amount),
        occurred_at: parseOccurredAtWithPrecision(occurredAt).milliseconds,
        direction: parseDirection(direction),
      });
    } catch { return null; }
  });
  duplicateFactConnections.add(database);
}

function groupedQuery(
  options: Omit<ReturnType<typeof normalizeQuery>, "limit">,
  limit: number,
  accounts: boolean,
) {
  const { endpoint, where: predicates, parameters: filterParameters, order, sortBy, cursor,
    includeDuplicateVariants, groupWhere, groupParameters, includeMatchMetrics } = options;
  const scopedEntries = `account_entries AS NOT MATERIALIZED (
    SELECT scoped_ledger.ledger_entry_id, scoped_ledger.provider_account_key, scoped_ledger.raw_event_id,
           ${accounts ? "json_array(generation.account_id, identity.provider_endpoint, scoped_ledger.external_event_id)" : "scoped_ledger.external_event_id"} AS external_event_id,
           scoped_ledger.external_event_id AS external_provider_event_id,
           ${accounts ? "generation.account_id" : "NULL"} AS alipay_account_id,
           ${accounts ? "account.name" : "NULL"} AS alipay_account_name,
           scoped_ledger.semantic_fingerprint, scoped_ledger.occurred_at, scoped_ledger.occurred_at_precision_ms, scoped_ledger.amount_cents,
           scoped_ledger.direction, scoped_ledger.currency, scoped_ledger.alipay_order_no, scoped_ledger.merchant_order_no,
           scoped_ledger.trans_memo, scoped_ledger.other_account, scoped_ledger.state, scoped_ledger.created_at, scoped_ledger.updated_at
      FROM ledger_entries AS scoped_ledger
      ${accounts ? "LEFT JOIN alipay_account_generations AS generation ON generation.provider_account_key = scoped_ledger.provider_account_key LEFT JOIN alipay_accounts AS account ON account.account_id = generation.account_id JOIN provider_account_bindings AS identity ON identity.provider_account_key = scoped_ledger.provider_account_key" : ""}
  ), `;
  const seek = listKeyset("sort_at", ["external_event_id"], order, cursor ? {
    value: "sort_value" in cursor ? cursor.sort_value! : cursor.occurred_at_ms!, keys: [cursor.external_event_id],
  } : null, sortBy !== "occurred_at");
  const matchMetrics = includeMatchMetrics ? `match_metrics AS MATERIALIZED (
    SELECT member.external_event_id,
           SUM(match.status = 'SETTLED') AS active_match_count,
           SUM(match.status = 'REVERSED') AS reversed_match_count,
           MAX(match.created_at) AS last_associated_at,
           MAX(COALESCE(match.resolved_at, match.created_at)) AS last_handled_at,
           MAX(match_event.event_sequence) AS event_sequence
      FROM members AS member CROSS JOIN payment_matches AS match
      LEFT JOIN payment_match_events AS match_event
        ON match_event.payment_match_id = match.payment_match_id AND match_event.status = match.status
     WHERE match.ledger_entry_id = member.ledger_entry_id
     GROUP BY member.external_event_id
  ), ` : "";
  // A numerical sort must use the same agreed fact exposed in the response.
  // Invalid or disagreeing duplicate versions belong in the explicit null bucket.
  const amountMetrics = sortBy === "amount_cents" ? `amount_metrics AS MATERIALIZED (
    SELECT external_event_id,
           CASE WHEN COUNT(amount_cents) = COUNT(*) AND MIN(amount_cents) = MAX(amount_cents)
                THEN MIN(amount_cents) ELSE NULL END AS amount_cents
      FROM (
        SELECT external_event_id, amount_cents FROM members
        UNION ALL
        SELECT duplicate.external_event_id, json_extract(duplicate.facts, '$.amount_cents') AS amount_cents
          FROM duplicate_inputs AS duplicate
         WHERE EXISTS (SELECT 1 FROM members WHERE members.external_event_id = duplicate.external_event_id)
      ) GROUP BY external_event_id
  ), ` : "";
  const sortExpression = {
    occurred_at: "anchor.occurred_at", associated_at: "match_metrics.last_associated_at",
    handled_at: "match_metrics.last_handled_at", amount_cents: "amount_metrics.amount_cents",
    event_sequence: "match_metrics.event_sequence",
  }[sortBy];
  // Eligibility selects event identities only. Hydration always includes every
  // source member, even when just one variant matched a date, amount or state.
  const duplicateCandidates = includeDuplicateVariants ? `duplicate_sources AS MATERIALIZED (
    SELECT source.ledger_entry_id, source.provider_account_key, source.external_event_id, source.external_provider_event_id,
           source.alipay_account_id, source.alipay_account_name, source.state
      FROM provider_account_bindings AS binding
      CROSS JOIN account_entries AS source
     WHERE source.provider_account_key = binding.provider_account_key
       AND ${endpoint === null ? "1 = 1" : "binding.provider_endpoint = ?"}
  ), duplicate_links AS MATERIALIZED (
    SELECT source.*, conflict.raw_event_id
      FROM duplicate_sources AS source CROSS JOIN ledger_conflicts AS conflict
     WHERE conflict.existing_ledger_entry_id = source.ledger_entry_id
       AND conflict.conflict_type = 'DUPLICATE_EXTERNAL_ID'
    UNION
    SELECT source.*, conflict.raw_event_id
      FROM duplicate_sources AS source CROSS JOIN ledger_conflicts AS conflict
     WHERE conflict.provider_account_key = source.provider_account_key
       AND conflict.external_event_id = source.external_provider_event_id
       AND conflict.conflict_type = 'DUPLICATE_EXTERNAL_ID'
  ), duplicate_inputs AS MATERIALIZED (
    SELECT source.ledger_entry_id, source.provider_account_key, source.external_event_id, source.external_provider_event_id,
           source.alipay_account_id, source.alipay_account_name, source.state,
           raw.alipay_order_no, raw.merchant_order_no, raw.other_account, raw.trans_memo,
           perpay_admin_ledger_duplicate_facts(raw.amount_text, raw.occurred_at_text, raw.direction_text) AS facts
      FROM duplicate_links AS source
      CROSS JOIN provider_raw_events AS raw
     WHERE raw.raw_event_id = source.raw_event_id
  ), duplicate_variants AS (
    SELECT *, json_extract(facts, '$.amount_cents') AS amount_cents,
           json_extract(facts, '$.occurred_at') AS occurred_at,
           json_extract(facts, '$.direction') AS direction
      FROM duplicate_inputs WHERE facts IS NOT NULL
  ), ` : "";
  const duplicateEligibility = includeDuplicateVariants ? `
    UNION
    SELECT DISTINCT entry.external_event_id
      FROM provider_account_bindings AS binding
      CROSS JOIN duplicate_variants AS entry
     WHERE entry.provider_account_key = binding.provider_account_key
       AND ${endpoint === null ? "1 = 1" : "binding.provider_endpoint = ?"}${predicates.length ? " AND " + predicates.join(" AND ") : ""}` : "";
  const sql = `WITH ${scopedEntries}${duplicateCandidates}eligible_ids AS MATERIALIZED (
    SELECT DISTINCT entry.external_event_id
      FROM provider_account_bindings AS binding
      CROSS JOIN account_entries AS entry
     WHERE entry.provider_account_key = binding.provider_account_key
       AND ${endpoint === null ? "1 = 1" : "binding.provider_endpoint = ?"}${predicates.length ? " AND " + predicates.join(" AND ") : ""}${duplicateEligibility}
  ), members AS MATERIALIZED (
    SELECT entry.*, binding.external_account_id AS app_id, binding.provider_endpoint,
           ROW_NUMBER() OVER (
             PARTITION BY entry.external_event_id
             ORDER BY activation.sequence IS NOT NULL, activation.sequence,
                      binding.bound_at, binding.provider_account_key
           ) AS source_rank
      FROM eligible_ids AS eligible
      JOIN account_entries AS entry ON entry.external_event_id = eligible.external_event_id
      JOIN provider_account_bindings AS binding ON binding.provider_account_key = entry.provider_account_key
      LEFT JOIN provider_account_activations AS activation ON activation.provider_account_key = binding.provider_account_key
     WHERE ${endpoint === null ? "1 = 1" : "binding.provider_endpoint = ?"}
  ), ${matchMetrics}${amountMetrics}event_groups AS (
    -- Unactivated legacy bindings precede recorded generations. Generations
    -- activate once in append-only sequence order. A later source
    -- may dispute transaction facts but cannot move an existing group's anchor.
    SELECT anchor.external_event_id, ${sortExpression} AS sort_at FROM members AS anchor
      ${includeMatchMetrics ? "LEFT JOIN match_metrics ON match_metrics.external_event_id = anchor.external_event_id" : ""}
      ${sortBy === "amount_cents" ? "LEFT JOIN amount_metrics ON amount_metrics.external_event_id = anchor.external_event_id" : ""}
     WHERE anchor.source_rank = 1${groupWhere.length ? " AND " + groupWhere.join(" AND ") : ""}
  ), selected_groups AS MATERIALIZED (
    SELECT * FROM event_groups ${seek.where ? "WHERE " + seek.where : ""}
     ORDER BY ${seek.orderBy} LIMIT ?
  ), selected_members AS MATERIALIZED (
    SELECT member.* FROM members AS member
      JOIN selected_groups AS selected ON selected.external_event_id = member.external_event_id
  ), source_payloads AS (
    SELECT external_event_id, json_group_array(json_object(
      'ledger_entry_id', ledger_entry_id, 'external_event_id', external_provider_event_id,
      'provider_account_key', provider_account_key, 'app_id', app_id,
      'provider_endpoint', provider_endpoint,
      'alipay_account_id', alipay_account_id, 'alipay_account_name', alipay_account_name,
      'raw_event_id', raw_event_id, 'semantic_fingerprint', semantic_fingerprint,
      'state', state, 'amount_cents', amount_cents, 'occurred_at', occurred_at,
      'occurred_at_precision_ms', occurred_at_precision_ms, 'direction', direction,
      'currency', currency, 'alipay_order_no', alipay_order_no, 'merchant_order_no', merchant_order_no,
      'other_account', other_account, 'trans_memo', trans_memo, 'created_at', created_at, 'updated_at', updated_at
    )) AS sources_json
      FROM (SELECT * FROM selected_members ORDER BY external_event_id, source_rank)
     GROUP BY external_event_id
  ), match_payloads AS (
    SELECT external_event_id, json_group_array(json_object(
      'payment_match_id', payment_match_id, 'ledger_entry_id', ledger_entry_id,
      'order_id', order_id, 'merchant_order_no', merchant_order_no, 'product_name', product_name,
      'api_client_id', api_client_id, 'site_name', site_name, 'evidence_type', evidence_type,
      'status', status, 'created_at', created_at, 'resolved_at', resolved_at
    )) AS matches_json FROM (
      SELECT member.external_event_id, match.payment_match_id, match.ledger_entry_id,
             match.order_id, orders.merchant_order_no, orders.product_name, orders.api_client_id,
             json_extract(site.configuration, '$.name') AS site_name,
             match.evidence_type, match.status, match.created_at, match.resolved_at
        FROM selected_members AS member
        CROSS JOIN payment_matches AS match
        JOIN payment_orders AS orders ON orders.order_id = match.order_id
        LEFT JOIN sites AS site ON site.client_id = orders.api_client_id
       WHERE match.ledger_entry_id = member.ledger_entry_id
       ORDER BY match.created_at, match.payment_match_id
    ) GROUP BY external_event_id
  ), conflict_links AS MATERIALIZED (
    SELECT member.external_event_id, conflict.conflict_id
      FROM selected_members AS member
      CROSS JOIN ledger_conflicts AS conflict
     WHERE conflict.provider_account_key = member.provider_account_key
       AND conflict.external_event_id = member.external_provider_event_id
    UNION
    SELECT member.external_event_id, conflict.conflict_id
      FROM selected_members AS member
      CROSS JOIN ledger_conflicts AS conflict
     WHERE conflict.existing_ledger_entry_id = member.ledger_entry_id
  ), conflict_payloads AS (
    SELECT external_event_id, json_group_array(json_object(
      'conflict_id', conflict_id, 'conflict_type', conflict_type, 'status', status,
      'existing_ledger_entry_id', existing_ledger_entry_id, 'created_at', created_at, 'resolved_at', resolved_at,
      'incoming_semantic_fingerprint', incoming_semantic_fingerprint,
      'occurred_at_text', occurred_at_text, 'amount_text', amount_text, 'direction_text', direction_text,
      'alipay_order_no', alipay_order_no, 'merchant_order_no', merchant_order_no,
      'other_account', other_account, 'trans_memo', trans_memo
    )) AS conflicts_json FROM (
      SELECT link.external_event_id, conflict.conflict_id, conflict.conflict_type, conflict.status,
             conflict.existing_ledger_entry_id, conflict.created_at, conflict.resolved_at,
             conflict.incoming_semantic_fingerprint, raw.occurred_at_text, raw.amount_text, raw.direction_text,
             raw.alipay_order_no, raw.merchant_order_no, raw.other_account, raw.trans_memo
        FROM conflict_links AS link CROSS JOIN ledger_conflicts AS conflict
        LEFT JOIN provider_raw_events AS raw ON raw.raw_event_id = conflict.raw_event_id
       WHERE conflict.conflict_id = link.conflict_id
       ORDER BY conflict.created_at, conflict.conflict_id
    ) GROUP BY external_event_id
  )
  SELECT selected.external_event_id, selected.sort_at, sources.sources_json,
         COALESCE(matches.matches_json, '[]') AS matches_json,
         COALESCE(conflicts.conflicts_json, '[]') AS conflicts_json
    FROM selected_groups AS selected
    JOIN source_payloads AS sources ON sources.external_event_id = selected.external_event_id
    LEFT JOIN match_payloads AS matches ON matches.external_event_id = selected.external_event_id
    LEFT JOIN conflict_payloads AS conflicts ON conflicts.external_event_id = selected.external_event_id
   ORDER BY selected.sort_at ${order === "asc" ? "ASC" : "DESC"} NULLS LAST, selected.external_event_id ${order === "asc" ? "ASC" : "DESC"}`;
  return { sql, parameters: [
    ...(includeDuplicateVariants && endpoint !== null ? [endpoint] : []), ...(endpoint !== null ? [endpoint] : []), ...filterParameters,
    ...(includeDuplicateVariants ? [...(endpoint !== null ? [endpoint] : []), ...filterParameters] : []),
    ...(endpoint !== null ? [endpoint] : []), ...groupParameters, ...seek.parameters, limit,
  ] };
}

function summarize(row: GroupRow, environment: ProviderEnvironment | null) {
  const sourceRows = JSON.parse(row.sources_json) as SourceRow[];
  const sources: AdminLedgerSource[] = sourceRows.map(source => ({
    ledger_entry_id: source.ledger_entry_id, external_event_id: source.external_event_id,
    provider_account_key: source.provider_account_key, app_id: source.app_id,
    environment: environment ?? (source.provider_endpoint === providerEndpoint("SANDBOX") ? "SANDBOX" : "PRODUCTION"),
    alipay_account_id: source.alipay_account_id, alipay_account_name: source.alipay_account_name,
    raw_event_id: source.raw_event_id, semantic_fingerprint: source.semantic_fingerprint,
    state: source.state, amount_cents: safeInteger(source.amount_cents),
    occurred_at: iso(source.occurred_at), occurred_at_precision_milliseconds: source.occurred_at_precision_ms,
    occurred_at_interval_end_exclusive: iso(source.occurred_at + source.occurred_at_precision_ms),
    direction: source.direction, currency: source.currency, provider_order_no: source.alipay_order_no,
    merchant_order_no: source.merchant_order_no, other_account: source.other_account, memo: source.trans_memo,
    created_at: iso(source.created_at), updated_at: iso(source.updated_at),
  }));
  if (!sources.length) throw new Error("ledger group has no source evidence");
  const matches: AdminLedgerMatch[] = (JSON.parse(row.matches_json) as MatchRow[]).map(match => ({
    ...match, created_at: iso(match.created_at), resolved_at: match.resolved_at === null ? null : iso(match.resolved_at),
  }));
  const conflictRows = JSON.parse(row.conflicts_json) as ConflictRow[];
  const conflicts: AdminLedgerConflict[] = conflictRows.map(conflict => ({
    conflict_id: conflict.conflict_id, conflict_type: conflict.conflict_type, status: conflict.status,
    existing_ledger_entry_id: conflict.existing_ledger_entry_id, created_at: iso(conflict.created_at),
    resolved_at: conflict.resolved_at === null ? null : iso(conflict.resolved_at),
  }));
  const variants: AdminLedgerFacts[] = [...sources];
  let incompleteVariant = false;
  const duplicateConflicts = conflictRows.filter(conflict => conflict.conflict_type === "DUPLICATE_EXTERNAL_ID");
  for (const conflict of duplicateConflicts) {
    try {
      const occurred = parseOccurredAtWithPrecision(conflict.occurred_at_text);
      variants.push({
        amount_cents: parseAmountCents(conflict.amount_text), occurred_at: iso(occurred.milliseconds),
        occurred_at_precision_milliseconds: occurred.precisionMilliseconds,
        occurred_at_interval_end_exclusive: iso(occurred.milliseconds + occurred.precisionMilliseconds),
        direction: parseDirection(conflict.direction_text), currency: "CNY",
        provider_order_no: conflict.alipay_order_no, merchant_order_no: conflict.merchant_order_no,
        other_account: conflict.other_account, memo: conflict.trans_memo,
      });
    } catch {
      incompleteVariant = true;
    }
  }
  const facts = Object.fromEntries(FACT_KEYS.map(key => [key,
    !incompleteVariant && variants.every(variant => variant[key] === variants[0]![key]) ? variants[0]![key] : null,
  ])) as unknown as AdminLedgerFacts;
  const active = matches.filter((match): match is AdminLedgerMatch & { status: "SETTLED" } => match.status === "SETTLED");
  const latest = (values: readonly string[]) => values.reduce<string | null>((last, value) => last === null || value > last ? value : last, null);
  const contentConsistent = duplicateConflicts.length === 0 && new Set(sources.map(source => source.semantic_fingerprint)).size === 1;
  const summary: AdminLedgerSummary = {
    ...facts, ledger_entry_id: sources[0]!.ledger_entry_id, external_event_id: sources[0]!.external_event_id,
    alipay_account_id: sources[0]!.alipay_account_id, alipay_account_name: sources[0]!.alipay_account_name,
    environment: sources[0]!.environment, states: STATES.filter(state => sources.some(source => source.state === state)),
    source_record_count: sources.length, content_consistent: contentConsistent,
    has_conflicts: !contentConsistent || conflicts.length > 0 || active.length > 1,
    active_match_count: active.length, active_match: active.length === 1 ? active[0]! : null,
    reversed_match_count: matches.filter(match => match.status === "REVERSED").length,
    last_associated_at: latest(matches.map(match => match.created_at)),
    last_handled_at: latest(matches.map(match => match.resolved_at ?? match.created_at)),
    created_at: iso(sourceRows.reduce((value, source) => Math.min(value, source.created_at), sourceRows[0]!.created_at)),
    updated_at: iso(sourceRows.reduce((value, source) => Math.max(value, source.updated_at), sourceRows[0]!.updated_at)),
  };
  return { summary, sources, matches, conflicts };
}

function safeInteger(value: bigint | number): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error("ledger projection contains an invalid integer");
  return result;
}


function iso(value: bigint | number): string {
  return new Date(safeInteger(value)).toISOString();
}
