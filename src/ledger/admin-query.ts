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
export interface AdminLedgerCursor {
  readonly occurred_at_ms: number;
  readonly external_event_id: string;
}

export interface AdminLedgerQuery {
  readonly environment: ProviderEnvironment;
  readonly q?: string;
  readonly direction?: LedgerDirection;
  readonly state?: LedgerEntryState;
  readonly occurredFrom?: string;
  readonly occurredTo?: string;
  readonly minAmountCents?: number;
  readonly maxAmountCents?: number;
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
  readonly states: readonly LedgerEntryState[];
  readonly source_record_count: number;
  readonly content_consistent: boolean;
  readonly has_conflicts: boolean;
  readonly active_match_count: number;
  readonly active_match: (AdminLedgerMatch & { readonly status: "SETTLED" }) | null;
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

interface SourceRow {
  ledger_entry_id: string;
  external_event_id: string;
  provider_account_key: string;
  app_id: string;
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
  sort_at: bigint | number;
  sources_json: string;
  matches_json: string;
  conflicts_json: string;
}

/** One SELECT captures the source facts, decisions and conflicts in one read snapshot. */
export function readAdminLedgerPage(
  database: AdminLedgerDatabase,
  query: AdminLedgerQuery,
): AdminLedgerPage {
  const { endpoint, where, parameters, limit, order, cursor } = normalizeQuery(query);
  const statement = groupedQuery(endpoint, where, parameters, order, cursor, limit + 1);
  const rows = database.read(db => db.prepare(statement.sql).all(...statement.parameters)) as unknown as GroupRow[];
  const selected = rows.slice(0, limit);
  const last = selected.at(-1);
  return {
    items: selected.map(row => summarize(row, query.environment).summary),
    next_cursor: rows.length > limit && last ? {
      occurred_at_ms: safeInteger(last.sort_at),
      external_event_id: last.external_event_id,
    } : null,
  };
}

/** Any real member ID resolves the complete group in the requested environment. */
export function readAdminLedgerDetail(
  database: AdminLedgerDatabase,
  environment: ProviderEnvironment,
  ledgerEntryId: string,
): AdminLedgerDetail | null {
  const endpoint = environmentEndpoint(environment);
  if (!UUID.test(ledgerEntryId)) return null;
  const statement = groupedQuery(endpoint, ["entry.ledger_entry_id = ?"], [ledgerEntryId], "desc", null, 1);
  const row = database.read(db => db.prepare(statement.sql).get(...statement.parameters)) as unknown as GroupRow | undefined;
  if (!row) return null;
  const { summary, sources, matches, conflicts } = summarize(row, environment);
  return { ...summary, sources, matches, conflicts };
}

function environmentEndpoint(environment: ProviderEnvironment): string {
  if (environment !== "PRODUCTION" && environment !== "SANDBOX") {
    throw new ListQueryError("支付宝环境无效");
  }
  return providerEndpoint(environment);
}

function normalizeQuery(query: AdminLedgerQuery) {
  const endpoint = environmentEndpoint(query.environment);
  const limit = query.limit ?? 20;
  const order = query.sortOrder ?? "desc";
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new ListQueryError("流水每页条数须为 1 至 100");
  }
  if (order !== "asc" && order !== "desc") throw new ListQueryError("流水排序方向无效");
  const keyword = normalizeKeyword(query.q ?? "");
  const search = listSearch([
    "entry.ledger_entry_id", "entry.external_event_id", "entry.alipay_order_no",
    "entry.merchant_order_no", "entry.other_account", "entry.trans_memo",
    "entry.provider_account_key", "binding.external_account_id",
  ], keyword);
  const orderSearch = listSearch(["linked_order.order_id", "linked_order.merchant_order_no"], keyword);
  const where: string[] = search.where ? [`(${search.where} OR EXISTS (
    SELECT 1 FROM payment_matches AS linked_match
    JOIN payment_orders AS linked_order ON linked_order.order_id = linked_match.order_id
    WHERE linked_match.ledger_entry_id = entry.ledger_entry_id AND ${orderSearch.where}
  ))`] : [];
  const parameters: Array<string | number> = [...search.parameters, ...orderSearch.parameters];
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
  const cursor = query.cursor ?? null;
  if (cursor && (!Number.isSafeInteger(cursor.occurred_at_ms) || cursor.occurred_at_ms < 0 ||
    typeof cursor.external_event_id !== "string" || cursor.external_event_id.length < 1 ||
    cursor.external_event_id.length > 256 || cursor.external_event_id.includes("\0") ||
    !cursor.external_event_id.isWellFormed())) {
    throw new ListQueryError("流水分页游标无效");
  }
  return { endpoint, where, parameters, limit, order, cursor };
}

function groupedQuery(
  endpoint: string,
  predicates: readonly string[],
  filterParameters: readonly (string | number)[],
  order: "asc" | "desc",
  cursor: AdminLedgerCursor | null,
  limit: number,
) {
  const seek = listKeyset("sort_at", ["external_event_id"], order, cursor ? {
    value: cursor.occurred_at_ms, keys: [cursor.external_event_id],
  } : null);
  // Eligibility selects event identities only. Hydration always includes every
  // source member, even when just one variant matched a date, amount or state.
  const sql = `WITH eligible_ids AS MATERIALIZED (
    SELECT DISTINCT entry.external_event_id
      FROM provider_account_bindings AS binding
      CROSS JOIN ledger_entries AS entry
     WHERE entry.provider_account_key = binding.provider_account_key
       AND binding.provider_endpoint = ?${predicates.length ? " AND " + predicates.join(" AND ") : ""}
  ), members AS MATERIALIZED (
    SELECT entry.*, binding.external_account_id AS app_id,
           ROW_NUMBER() OVER (
             PARTITION BY entry.external_event_id
             ORDER BY activation.sequence IS NOT NULL, activation.sequence,
                      binding.bound_at, binding.provider_account_key
           ) AS source_rank
      FROM eligible_ids AS eligible
      JOIN ledger_entries AS entry ON entry.external_event_id = eligible.external_event_id
      JOIN provider_account_bindings AS binding ON binding.provider_account_key = entry.provider_account_key
      LEFT JOIN provider_account_activations AS activation ON activation.provider_account_key = binding.provider_account_key
     WHERE binding.provider_endpoint = ?
  ), event_groups AS (
    -- Unactivated legacy bindings precede recorded generations. Generations
    -- activate once in append-only sequence order. A later source
    -- may dispute transaction facts but cannot move an existing group's anchor.
    SELECT external_event_id, occurred_at AS sort_at FROM members WHERE source_rank = 1
  ), selected_groups AS MATERIALIZED (
    SELECT * FROM event_groups ${seek.where ? "WHERE " + seek.where : ""}
     ORDER BY ${seek.orderBy} LIMIT ?
  ), selected_members AS MATERIALIZED (
    SELECT member.* FROM members AS member
      JOIN selected_groups AS selected ON selected.external_event_id = member.external_event_id
  ), source_payloads AS (
    SELECT external_event_id, json_group_array(json_object(
      'ledger_entry_id', ledger_entry_id, 'external_event_id', external_event_id,
      'provider_account_key', provider_account_key, 'app_id', app_id,
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
       AND conflict.external_event_id = member.external_event_id
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
   ORDER BY selected.sort_at ${order === "asc" ? "ASC" : "DESC"}, selected.external_event_id ${order === "asc" ? "ASC" : "DESC"}`;
  return { sql, parameters: [endpoint, ...filterParameters, endpoint, ...seek.parameters, limit] };
}

function summarize(row: GroupRow, environment: ProviderEnvironment) {
  const sourceRows = JSON.parse(row.sources_json) as SourceRow[];
  const sources: AdminLedgerSource[] = sourceRows.map(source => ({
    ledger_entry_id: source.ledger_entry_id, external_event_id: source.external_event_id,
    provider_account_key: source.provider_account_key, app_id: source.app_id, environment,
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
  const contentConsistent = duplicateConflicts.length === 0 && new Set(sources.map(source => source.semantic_fingerprint)).size === 1;
  const summary: AdminLedgerSummary = {
    ...facts, ledger_entry_id: sources[0]!.ledger_entry_id, external_event_id: row.external_event_id,
    environment, states: STATES.filter(state => sources.some(source => source.state === state)),
    source_record_count: sources.length, content_consistent: contentConsistent,
    has_conflicts: !contentConsistent || conflicts.length > 0 || active.length > 1,
    active_match_count: active.length, active_match: active.length === 1 ? active[0]! : null,
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
