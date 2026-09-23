import {
  ListQueryError,
  normalizeKeyword,
  normalizeListQuery,
  WORK_ITEM_SORT_FIELDS,
  type WorkItemSort,
  type ListQuery,
  type ListPosition,
} from "../shared/list-query.ts";
import { listKeyset, listSearch } from "../database/list-query.ts";
import type { AppDatabase } from "../database/database.ts";
import { z } from "zod";
import {
  AdminOperationError,
  adminFingerprint,
  adminOperationIdSchema,
  adminOperationTime,
  recordAdminOperation,
  replayAdminOperation,
  type AdminOperationContext,
} from "../database/admin-operation-store.ts";

export const ADMIN_WORK_ITEM_TYPES = [
  "ALL",
  "FINANCIAL_EXCEPTION",
  "LEDGER_CONFLICT",
  "NOTIFICATION_FAILURE",
] as const;
export const ADMIN_WORK_ITEM_VISIBILITIES = ["ACTIVE", "IGNORED"] as const;
export type AdminWorkItemType = (typeof ADMIN_WORK_ITEM_TYPES)[number];
export type AdminWorkItemKind = Exclude<AdminWorkItemType, "ALL">;
export type AdminWorkItemVisibility =
  (typeof ADMIN_WORK_ITEM_VISIBILITIES)[number];
export const ignoreAllWorkItemsSchema = z
  .object({
    operation_id: adminOperationIdSchema,
    type: z.enum(ADMIN_WORK_ITEM_TYPES),
    q: z.string().transform(normalizeKeyword).optional(),
  })
  .strict();
export const restoreWorkItemSchema = z
  .object({ operation_id: adminOperationIdSchema })
  .strict();
const kindSchema = z.enum([
  "FINANCIAL_EXCEPTION",
  "LEDGER_CONFLICT",
  "NOTIFICATION_FAILURE",
]);
export interface AdminWorkItemCursor {
  readonly position?: ListPosition;
  readonly actionableAt: number;
  readonly kind: AdminWorkItemKind;
  readonly itemId: string;
}
interface AdminWorkItemBase {
  readonly kind: AdminWorkItemKind;
  readonly itemId: string;
  readonly providerAccountKey: string;
  readonly createdAt: number;
  readonly actionableAt: number;
  readonly orderId: string | null;
  readonly ledgerEntryId: string | null;
  readonly ignoredAt: number | null;
  readonly ignoredBy: string | null;
  readonly ended: boolean;
}
export interface AdminFinancialExceptionWorkItem extends AdminWorkItemBase {
  readonly kind: "FINANCIAL_EXCEPTION";
  readonly status: "OPEN" | "RESOLVED";
  readonly exceptionType: string;
  readonly candidateId: string | null;
}
export interface AdminLedgerConflictWorkItem extends AdminWorkItemBase {
  readonly kind: "LEDGER_CONFLICT";
  readonly status: "OPEN" | "RESOLVED" | "IGNORED";
  readonly conflictType: string;
  readonly externalEventId: string | null;
}
export interface AdminNotificationFailureWorkItem extends AdminWorkItemBase {
  readonly kind: "NOTIFICATION_FAILURE";
  readonly status:
    "PENDING" | "LEASED" | "RETRY_WAIT" | "ACKNOWLEDGED" | "DEAD_LETTER";
  readonly eventType: string;
  readonly attemptCount: number;
  readonly nextAttemptAt: number;
  readonly lastErrorCode: string | null;
  readonly deadLetteredAt: number | null;
  readonly updatedAt: number;
}
export type AdminWorkItem =
  | AdminFinancialExceptionWorkItem
  | AdminLedgerConflictWorkItem
  | AdminNotificationFailureWorkItem;
export interface AdminWorkItemPageInput {
  readonly query?: ListQuery<WorkItemSort>;
  readonly type: AdminWorkItemType;
  readonly visibility?: AdminWorkItemVisibility;
  readonly cursor: AdminWorkItemCursor | null;
  readonly limit: number;
}
export interface AdminWorkItemPage {
  readonly items: readonly AdminWorkItem[];
  readonly nextCursor: AdminWorkItemCursor | null;
}
interface WorkItemRow {
  readonly kind: AdminWorkItemKind;
  readonly item_id: string;
  readonly provider_account_key: string;
  readonly status: string;
  readonly category: string;
  readonly order_id: string | null;
  readonly ledger_entry_id: string | null;
  readonly candidate_id: string | null;
  readonly external_event_id: string | null;
  readonly attempt_count: number | bigint | null;
  readonly next_attempt_at: number | bigint | null;
  readonly last_error_code: string | null;
  readonly dead_lettered_at: number | bigint | null;
  readonly created_at: number | bigint;
  readonly actionable_at: number | bigint;
  readonly updated_at: number | bigint | null;
  readonly ignored: number | bigint;
  readonly ignored_at: number | bigint | null;
  readonly ignored_by: string | null;
  readonly ended: number | bigint;
  readonly sort_at: number | bigint;
}

// One projection drives tabs, home-page reminders, bulk selection and restore checks.
// It includes ended records so ignored history survives the underlying resolution.
const WORK_ITEMS_CTE = `
  WITH resources AS (
    SELECT 'FINANCIAL_EXCEPTION' AS kind, exception.exception_id AS item_id,
      exception.provider_account_key, exception.status, exception.exception_type AS category,
      exception.order_id, exception.ledger_entry_id, exception.candidate_id,
      NULL AS external_event_id, NULL AS attempt_count, NULL AS next_attempt_at,
      NULL AS last_error_code, NULL AS dead_lettered_at,
      exception.created_at, exception.created_at AS actionable_at, NULL AS updated_at,
      CASE WHEN exception.status = 'OPEN' AND exception.exception_type NOT IN ('UNMATCHED_DEBIT', 'UNLINKED_REFUND') THEN 1 ELSE 0 END AS actionable,
      CASE WHEN exception.status = 'OPEN' AND exception.exception_type NOT IN ('UNMATCHED_DEBIT', 'UNLINKED_REFUND') THEN 0 ELSE 1 END AS ended
    FROM financial_exceptions AS exception
    UNION ALL
    SELECT 'LEDGER_CONFLICT', conflict.conflict_id, conflict.provider_account_key,
      conflict.status, conflict.conflict_type, NULL, conflict.existing_ledger_entry_id,
      NULL, conflict.external_event_id, NULL, NULL, NULL, NULL,
      conflict.created_at, conflict.created_at, NULL,
      CASE WHEN conflict.status = 'OPEN' THEN 1 ELSE 0 END,
      CASE WHEN conflict.status = 'OPEN' THEN 0 ELSE 1 END
    FROM ledger_conflicts AS conflict
    UNION ALL
    SELECT 'NOTIFICATION_FAILURE', delivery.delivery_id,
      COALESCE(account.provider_account_key, profile.provider_account_key),
      delivery.status, outbox.event_type, outbox.aggregate_id, NULL, NULL, NULL,
      delivery.attempt_count, delivery.next_attempt_at, delivery.last_error_code, delivery.dead_lettered_at,
      delivery.created_at,
      CASE WHEN delivery.status = 'DEAD_LETTER' THEN COALESCE(delivery.dead_lettered_at, delivery.updated_at) ELSE delivery.updated_at END,
      delivery.updated_at,
      CASE WHEN delivery.status IN ('RETRY_WAIT', 'DEAD_LETTER') AND NOT EXISTS (
        SELECT 1 FROM webhook_deliveries AS successor WHERE successor.predecessor_delivery_id = delivery.delivery_id
      ) THEN 1 ELSE 0 END,
      CASE WHEN delivery.status = 'ACKNOWLEDGED' OR EXISTS (
        SELECT 1 FROM webhook_deliveries AS successor WHERE successor.predecessor_delivery_id = delivery.delivery_id
      ) THEN 1 ELSE 0 END
    FROM webhook_deliveries AS delivery
    JOIN outbox_events AS outbox ON outbox.outbox_event_id = delivery.outbox_event_id
    JOIN payment_orders AS orders ON orders.order_id = outbox.aggregate_id
    JOIN collection_profiles AS profile ON profile.profile_id = orders.collection_profile_id
    LEFT JOIN collection_profile_provider_accounts AS account ON account.profile_id = profile.profile_id
  ), work_items AS (
    SELECT resources.*, COALESCE(state.ignored, 0) AS ignored,
      CASE WHEN state.ignored = 1 THEN state.updated_at ELSE NULL END AS ignored_at,
      CASE WHEN state.ignored = 1 THEN operation.actor_id ELSE NULL END AS ignored_by
    FROM resources
    LEFT JOIN admin_work_item_states AS state ON state.kind = resources.kind AND state.item_id = resources.item_id
    LEFT JOIN admin_operation_log AS operation ON operation.operation_id = state.operation_id
  )`;

function workItemSearch(q: string) {
  const direct = listSearch(
    [
      "work_items.item_id",
      "work_items.order_id",
      "work_items.ledger_entry_id",
      "work_items.candidate_id",
      "work_items.external_event_id",
      "work_items.category",
      "work_items.last_error_code",
    ],
    q,
  );
  if (!q) return direct;
  const orders = listSearch(
    ["searched_order.merchant_order_no", "searched_order.product_name"],
    q,
  );
  const entries = listSearch(["searched_entry.external_event_id"], q);
  const deliveries = listSearch(
    ["searched_delivery.outbox_event_id", "searched_target.target_url"],
    q,
  );
  return {
    where:
      "(" +
      direct.where +
      " OR EXISTS (SELECT 1 FROM payment_orders AS searched_order WHERE searched_order.order_id = work_items.order_id AND " +
      orders.where +
      ")" +
      " OR EXISTS (SELECT 1 FROM ledger_entries AS searched_entry WHERE searched_entry.ledger_entry_id = work_items.ledger_entry_id AND " +
      entries.where +
      ")" +
      " OR EXISTS (SELECT 1 FROM webhook_deliveries AS searched_delivery JOIN webhook_targets AS searched_target ON searched_target.target_id = searched_delivery.target_id WHERE work_items.kind = 'NOTIFICATION_FAILURE' AND searched_delivery.delivery_id = work_items.item_id AND " +
      deliveries.where +
      ")" +
      ")",
    parameters: [
      ...direct.parameters,
      ...orders.parameters,
      ...entries.parameters,
      ...deliveries.parameters,
    ],
  };
}

export function adminWorkItemPage(
  database: AppDatabase,
  input: AdminWorkItemPageInput,
): AdminWorkItemPage {
  validateInput(input);
  const visibility = input.visibility ?? "ACTIVE";
  const defaultSort = visibility === "IGNORED" ? "ignored_at" : "actionable_at";
  const query = normalizeListQuery(
    input.query,
    WORK_ITEM_SORT_FIELDS,
    defaultSort,
    "desc",
  );
  if (query.sortBy === "ignored_at" && visibility !== "IGNORED")
    throw new ListQueryError("忽略时间仅能用于已忽略视图");
  return database.read((connection) => {
    const sort = query.sortBy;
    const position =
      input.cursor?.position ??
      (input.cursor
        ? {
            value: input.cursor.actionableAt,
            keys: [input.cursor.kind, input.cursor.itemId],
          }
        : null);
    const seek = listKeyset(
      sort,
      ["kind", "item_id"],
      query.sortOrder,
      position,
    );
    const search = workItemSearch(query.q);
    const condition =
      visibility === "IGNORED"
        ? "ignored = 1"
        : "ignored = 0 AND actionable = 1";
    const rows = connection
      .prepare(
        WORK_ITEMS_CTE +
          `
      SELECT *, ${sort} AS sort_at FROM work_items
      WHERE (? = 'ALL' OR kind = ?) AND ${condition}
        ${seek.where ? "AND " + seek.where : ""}
        ${search.where ? "AND " + search.where : ""}
      ORDER BY ${seek.orderBy} LIMIT ?`,
      )
      .all(
        input.type,
        input.type,
        ...seek.parameters,
        ...search.parameters,
        input.limit + 1,
      ) as unknown as WorkItemRow[];
    const selected = rows.slice(0, input.limit);
    const last = selected.at(-1);
    return {
      items: Object.freeze(selected.map(mapWorkItem)),
      nextCursor:
        rows.length > input.limit && last
          ? {
              actionableAt: safeInteger(last.sort_at),
              kind: last.kind,
              itemId: last.item_id,
              ...(input.query
                ? {
                    position: {
                      value: safeInteger(last.sort_at),
                      keys: [last.kind, last.item_id],
                    },
                  }
                : {}),
            }
          : null,
    };
  });
}

/** Read reminder visibility in one query without changing the underlying resource state. */
export function adminIgnoredWorkItemIds(
  database: AppDatabase,
  kind: AdminWorkItemKind,
  ids: readonly string[],
): ReadonlySet<string> {
  if (ids.length === 0) return new Set();
  return database.read(
    (connection) =>
      new Set(
        (
          connection
            .prepare(
              "SELECT item_id FROM admin_work_item_states WHERE kind = ? AND ignored = 1 AND item_id IN (SELECT value FROM json_each(?))",
            )
            .all(kind, JSON.stringify(ids)) as Array<{ item_id: string }>
        ).map((row) => row.item_id),
      ),
  );
}

export interface IgnoreAllResult {
  readonly operation_id: string;
  readonly type: AdminWorkItemType;
  readonly ignored_count: number;
  readonly q?: string;
}
export function ignoreAllAdminWorkItems(
  database: AppDatabase,
  input: z.infer<typeof ignoreAllWorkItemsSchema>,
  context: AdminOperationContext,
): IgnoreAllResult {
  const parsed = ignoreAllWorkItemsSchema.parse(input);
  const q = parsed.q ?? "";
  const fingerprint = adminFingerprint({
    type: parsed.type,
    ...(q ? { q } : {}),
  });
  return database.write((connection) => {
    const replay = replayAdminOperation<IgnoreAllResult>(
      connection,
      parsed.operation_id,
      "work_items.ignore_all",
      fingerprint,
      context.actorId,
    );
    if (replay) return replay;
    const search = workItemSearch(q);
    const members = connection
      .prepare(
        WORK_ITEMS_CTE +
          "SELECT kind, item_id FROM work_items WHERE ignored = 0 AND actionable = 1 AND (? = 'ALL' OR kind = ?) " +
          (search.where ? "AND " + search.where : "") +
          " ORDER BY kind, item_id",
      )
      .all(parsed.type, parsed.type, ...search.parameters) as Array<{
      kind: AdminWorkItemKind;
      item_id: string;
    }>;
    const now = adminOperationTime(connection, context.now);
    const result = {
      operation_id: parsed.operation_id,
      type: parsed.type,
      ignored_count: members.length,
      ...(q ? { q } : {}),
    };
    recordAdminOperation(connection, {
      operationId: parsed.operation_id,
      action: "work_items.ignore_all",
      requestFingerprint: fingerprint,
      result,
      now,
      context,
      membershipFingerprint: adminFingerprint(members),
    });
    const member = connection.prepare(
      "INSERT INTO admin_work_item_operations(operation_id, kind, item_id) VALUES (?, ?, ?)",
    );
    const state =
      connection.prepare(`INSERT INTO admin_work_item_states(kind, item_id, ignored, operation_id, updated_at) VALUES (?, ?, 1, ?, ?)
      ON CONFLICT(kind, item_id) DO UPDATE SET ignored = 1, operation_id = excluded.operation_id, updated_at = excluded.updated_at`);
    for (const item of members) {
      member.run(parsed.operation_id, item.kind, item.item_id);
      state.run(item.kind, item.item_id, parsed.operation_id, now);
    }
    return result;
  });
}

export interface RestoreWorkItemResult {
  readonly operation_id: string;
  readonly type: AdminWorkItemKind;
  readonly resource_id: string;
  readonly restored: boolean;
}
export function restoreAdminWorkItem(
  database: AppDatabase,
  input: { operation_id: string; type: AdminWorkItemKind; resource_id: string },
  context: AdminOperationContext,
): RestoreWorkItemResult {
  adminOperationIdSchema.parse(input.operation_id);
  kindSchema.parse(input.type);
  adminOperationIdSchema.parse(input.resource_id);
  const fingerprint = adminFingerprint({
    type: input.type,
    resource_id: input.resource_id,
  });
  return database.write((connection) => {
    const replay = replayAdminOperation<RestoreWorkItemResult>(
      connection,
      input.operation_id,
      "work_items.restore",
      fingerprint,
      context.actorId,
    );
    if (replay) return replay;
    const item = connection
      .prepare(
        WORK_ITEMS_CTE +
          "SELECT * FROM work_items WHERE kind = ? AND item_id = ?",
      )
      .get(input.type, input.resource_id) as WorkItemRow | undefined;
    if (!item)
      throw new AdminOperationError(
        404,
        "work_item_not_found",
        "提醒对应的记录不存在",
      );
    if (Number(item.ended) === 1)
      throw new AdminOperationError(
        409,
        "work_item_ended",
        "事项已结束，无需恢复提醒",
      );
    const now = adminOperationTime(connection, context.now);
    const result = {
      operation_id: input.operation_id,
      type: input.type,
      resource_id: input.resource_id,
      restored: Number(item.ignored) === 1,
    };
    recordAdminOperation(connection, {
      operationId: input.operation_id,
      action: "work_items.restore",
      requestFingerprint: fingerprint,
      result,
      now,
      context,
    });
    if (result.restored) {
      connection
        .prepare(
          "INSERT INTO admin_work_item_operations(operation_id, kind, item_id) VALUES (?, ?, ?)",
        )
        .run(input.operation_id, input.type, input.resource_id);
      connection
        .prepare(
          "UPDATE admin_work_item_states SET ignored = 0, operation_id = ?, updated_at = ? WHERE kind = ? AND item_id = ?",
        )
        .run(input.operation_id, now, input.type, input.resource_id);
    }
    return result;
  });
}

function validateInput(input: AdminWorkItemPageInput): void {
  if (!ADMIN_WORK_ITEM_TYPES.includes(input.type))
    throw new RangeError("administrator work item type is invalid");
  if (!ADMIN_WORK_ITEM_VISIBILITIES.includes(input.visibility ?? "ACTIVE"))
    throw new RangeError("administrator work item visibility is invalid");
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 200
  )
    throw new RangeError("administrator work item page limit is invalid");
  if (
    input.cursor &&
    (!Number.isSafeInteger(input.cursor.actionableAt) ||
      input.cursor.actionableAt < 0 ||
      !kindSchema.safeParse(input.cursor.kind).success ||
      !adminOperationIdSchema.safeParse(input.cursor.itemId).success)
  ) {
    throw new RangeError("administrator work item cursor is invalid");
  }
}
function mapWorkItem(row: WorkItemRow): AdminWorkItem {
  const base = {
    itemId: row.item_id,
    providerAccountKey: row.provider_account_key,
    createdAt: safeInteger(row.created_at),
    actionableAt: safeInteger(row.actionable_at),
    orderId: row.order_id,
    ledgerEntryId: row.ledger_entry_id,
    ignoredAt: nullableInteger(row.ignored_at),
    ignoredBy: row.ignored_by,
    ended: Number(row.ended) === 1,
  };
  switch (row.kind) {
    case "FINANCIAL_EXCEPTION":
      if (row.status !== "OPEN" && row.status !== "RESOLVED")
        throw new Error("financial work item status is invalid");
      return {
        ...base,
        kind: row.kind,
        status: row.status,
        exceptionType: row.category,
        candidateId: row.candidate_id,
      };
    case "LEDGER_CONFLICT":
      if (!["OPEN", "RESOLVED", "IGNORED"].includes(row.status))
        throw new Error("ledger work item status is invalid");
      return {
        ...base,
        kind: row.kind,
        status: row.status as AdminLedgerConflictWorkItem["status"],
        conflictType: row.category,
        externalEventId: row.external_event_id,
      };
    case "NOTIFICATION_FAILURE":
      if (
        ![
          "PENDING",
          "LEASED",
          "RETRY_WAIT",
          "ACKNOWLEDGED",
          "DEAD_LETTER",
        ].includes(row.status)
      )
        throw new Error("notification work item status is invalid");
      return {
        ...base,
        kind: row.kind,
        status: row.status as AdminNotificationFailureWorkItem["status"],
        eventType: row.category,
        attemptCount: safeInteger(row.attempt_count),
        nextAttemptAt: safeInteger(row.next_attempt_at),
        lastErrorCode: row.last_error_code,
        deadLetteredAt: nullableInteger(row.dead_lettered_at),
        updatedAt: safeInteger(row.updated_at),
      };
  }
}
function safeInteger(value: number | bigint | null): number {
  if (
    value === null ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < 0
  )
    throw new Error("administrator work item value is invalid");
  return Number(value);
}
function nullableInteger(value: number | bigint | null): number | null {
  return value === null ? null : safeInteger(value);
}
