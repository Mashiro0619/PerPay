import type { AppDatabase } from "../database/database.ts";

export const ADMIN_WORK_ITEM_TYPES = [
  "ALL",
  "FINANCIAL_EXCEPTION",
  "LEDGER_CONFLICT",
  "NOTIFICATION_FAILURE",
] as const;

export type AdminWorkItemType = (typeof ADMIN_WORK_ITEM_TYPES)[number];
export type AdminWorkItemKind = Exclude<AdminWorkItemType, "ALL">;

export interface AdminWorkItemCursor {
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
}

export interface AdminFinancialExceptionWorkItem extends AdminWorkItemBase {
  readonly kind: "FINANCIAL_EXCEPTION";
  readonly status: "OPEN";
  readonly exceptionType: string;
  readonly candidateId: string | null;
}

export interface AdminLedgerConflictWorkItem extends AdminWorkItemBase {
  readonly kind: "LEDGER_CONFLICT";
  readonly status: "OPEN";
  readonly conflictType: string;
  readonly externalEventId: string | null;
}

export interface AdminNotificationFailureWorkItem extends AdminWorkItemBase {
  readonly kind: "NOTIFICATION_FAILURE";
  readonly status: "RETRY_WAIT" | "DEAD_LETTER";
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
  readonly type: AdminWorkItemType;
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
  readonly status: "OPEN" | "RETRY_WAIT" | "DEAD_LETTER";
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
}

const WORK_ITEM_KINDS = new Set<AdminWorkItemKind>([
  "FINANCIAL_EXCEPTION",
  "LEDGER_CONFLICT",
  "NOTIFICATION_FAILURE",
]);
const WORK_ITEM_TYPES = new Set<AdminWorkItemType>(ADMIN_WORK_ITEM_TYPES);
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function adminWorkItemPage(
  database: AppDatabase,
  input: AdminWorkItemPageInput,
): AdminWorkItemPage {
  validateInput(input);
  return database.read((connection) => {
    const rows = connection.prepare(`
      WITH work_items AS (
        SELECT
          'FINANCIAL_EXCEPTION' AS kind,
          exception.exception_id AS item_id,
          exception.provider_account_key,
          exception.status,
          exception.exception_type AS category,
          exception.order_id,
          exception.ledger_entry_id,
          exception.candidate_id,
          NULL AS external_event_id,
          NULL AS attempt_count,
          NULL AS next_attempt_at,
          NULL AS last_error_code,
          NULL AS dead_lettered_at,
          exception.created_at,
          exception.created_at AS actionable_at,
          NULL AS updated_at
        FROM financial_exceptions AS exception
        WHERE exception.status = 'OPEN'

        UNION ALL

        SELECT
          'LEDGER_CONFLICT' AS kind,
          conflict.conflict_id AS item_id,
          conflict.provider_account_key,
          conflict.status,
          conflict.conflict_type AS category,
          NULL AS order_id,
          conflict.existing_ledger_entry_id AS ledger_entry_id,
          NULL AS candidate_id,
          conflict.external_event_id,
          NULL AS attempt_count,
          NULL AS next_attempt_at,
          NULL AS last_error_code,
          NULL AS dead_lettered_at,
          conflict.created_at,
          conflict.created_at AS actionable_at,
          NULL AS updated_at
        FROM ledger_conflicts AS conflict
        WHERE conflict.status = 'OPEN'

        UNION ALL

        SELECT
          'NOTIFICATION_FAILURE' AS kind,
          delivery.delivery_id AS item_id,
          COALESCE(profile_provider.provider_account_key, profile.provider_account_key)
            AS provider_account_key,
          delivery.status,
          outbox.event_type AS category,
          outbox.aggregate_id AS order_id,
          NULL AS ledger_entry_id,
          NULL AS candidate_id,
          NULL AS external_event_id,
          delivery.attempt_count,
          delivery.next_attempt_at,
          delivery.last_error_code,
          delivery.dead_lettered_at,
          delivery.created_at,
          CASE
            WHEN delivery.status = 'DEAD_LETTER'
              THEN COALESCE(delivery.dead_lettered_at, delivery.updated_at)
            ELSE delivery.updated_at
          END AS actionable_at,
          delivery.updated_at
        FROM webhook_deliveries AS delivery
        JOIN outbox_events AS outbox
          ON outbox.outbox_event_id = delivery.outbox_event_id
        JOIN payment_orders AS orders
          ON orders.order_id = outbox.aggregate_id
        JOIN collection_profiles AS profile
          ON profile.profile_id = orders.collection_profile_id
        LEFT JOIN collection_profile_provider_accounts AS profile_provider
          ON profile_provider.profile_id = profile.profile_id
        WHERE
          delivery.status = 'RETRY_WAIT' OR
          (
            delivery.status = 'DEAD_LETTER' AND
            NOT EXISTS (
              SELECT 1
              FROM webhook_deliveries AS successor
              WHERE successor.predecessor_delivery_id = delivery.delivery_id
            )
          )
      )
      SELECT *
      FROM work_items
      WHERE (? = 'ALL' OR kind = ?)
        AND (
          ? IS NULL OR actionable_at < ? OR
          (actionable_at = ? AND kind < ?) OR
          (actionable_at = ? AND kind = ? AND item_id < ?)
        )
      ORDER BY actionable_at DESC, kind DESC, item_id DESC
      LIMIT ?
    `).all(
      input.type,
      input.type,
      input.cursor?.actionableAt ?? null,
      input.cursor?.actionableAt ?? null,
      input.cursor?.actionableAt ?? null,
      input.cursor?.kind ?? null,
      input.cursor?.actionableAt ?? null,
      input.cursor?.kind ?? null,
      input.cursor?.itemId ?? null,
      input.limit + 1,
    ) as unknown as WorkItemRow[];

    const selected = rows.slice(0, input.limit);
    const last = selected.at(-1);
    return Object.freeze({
      items: Object.freeze(selected.map(mapWorkItem)),
      nextCursor: rows.length > input.limit && last
        ? Object.freeze({
            actionableAt: safeInteger(
              last.actionable_at,
              "administrator work item cursor time",
            ),
            kind: last.kind,
            itemId: last.item_id,
          })
        : null,
    });
  });
}

function validateInput(input: AdminWorkItemPageInput): void {
  if (!WORK_ITEM_TYPES.has(input.type)) {
    throw new RangeError("administrator work item type is invalid");
  }
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 200) {
    throw new RangeError("administrator work item page limit is invalid");
  }
  if (input.cursor === null) return;
  if (
    !Number.isSafeInteger(input.cursor.actionableAt) ||
    input.cursor.actionableAt < 0 ||
    !WORK_ITEM_KINDS.has(input.cursor.kind) ||
    !UUID_V4_PATTERN.test(input.cursor.itemId)
  ) {
    throw new RangeError("administrator work item cursor is invalid");
  }
}

function mapWorkItem(row: WorkItemRow): AdminWorkItem {
  const base = {
    itemId: row.item_id,
    providerAccountKey: row.provider_account_key,
    createdAt: safeInteger(row.created_at, "administrator work item creation time"),
    actionableAt: safeInteger(row.actionable_at, "administrator work item actionable time"),
    orderId: row.order_id,
    ledgerEntryId: row.ledger_entry_id,
  } as const;
  switch (row.kind) {
    case "FINANCIAL_EXCEPTION":
      if (row.status !== "OPEN") throw new Error("financial work item status is invalid");
      return Object.freeze({
        ...base,
        kind: row.kind,
        status: row.status,
        exceptionType: row.category,
        candidateId: row.candidate_id,
      });
    case "LEDGER_CONFLICT":
      if (row.status !== "OPEN") throw new Error("ledger work item status is invalid");
      return Object.freeze({
        ...base,
        kind: row.kind,
        status: row.status,
        conflictType: row.category,
        externalEventId: row.external_event_id,
      });
    case "NOTIFICATION_FAILURE":
      if (row.status !== "RETRY_WAIT" && row.status !== "DEAD_LETTER") {
        throw new Error("notification work item status is invalid");
      }
      return Object.freeze({
        ...base,
        kind: row.kind,
        status: row.status,
        eventType: row.category,
        attemptCount: safeInteger(row.attempt_count, "webhook delivery attempt count"),
        nextAttemptAt: safeInteger(row.next_attempt_at, "webhook next attempt time"),
        lastErrorCode: row.last_error_code,
        deadLetteredAt: nullableSafeInteger(row.dead_lettered_at, "webhook dead-letter time"),
        updatedAt: safeInteger(row.updated_at, "webhook delivery update time"),
      });
  }
}

function safeInteger(value: number | bigint | null, label: string): number {
  if (value === null) throw new Error(`${label} is invalid`);
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error(`${label} is invalid`);
  return result;
}

function nullableSafeInteger(value: number | bigint | null, label: string): number | null {
  return value === null ? null : safeInteger(value, label);
}
