import type { DatabaseSync } from "node:sqlite";
import { ARCHIVE_BUSINESS_TABLES } from "./schema.ts";

export interface ArchiveTable {
  readonly name: string;
  readonly primaryKey: readonly string[];
  readonly columns: readonly string[];
}

export interface ArchiveRelation {
  readonly child: string;
  readonly parent: string;
  readonly pairs: readonly { from: string; to: string }[];
  readonly joinSql?: string;
}

export interface HistoryArchivePlan {
  readonly tables: readonly ArchiveTable[];
  readonly relations: readonly ArchiveRelation[];
  readonly counts: Readonly<Record<string, number>>;
  readonly eligibleOrders: number;
}

export function quoted(name: string): string { return `"${name.replaceAll('"', '""')}"`; }
export function selectedTable(name: string): string { return quoted(`archive_selected_${name}`); }

export function buildHistoryArchivePlan(connection: DatabaseSync, before: number): HistoryArchivePlan {
  const allTables = (connection.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as {name: string}[]).map(row => row.name);
  const tables = ARCHIVE_BUSINESS_TABLES.map(name => {
    const columns = connection.prepare(`PRAGMA table_info(${quoted(name)})`).all() as {name: string; pk: number | bigint}[];
    return { name, columns: columns.map(column => column.name), primaryKey: columns.filter(column => Number(column.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk)).map(column => column.name) };
  });
  const included = new Set<string>(tables.map(table => table.name));
  const relations: ArchiveRelation[] = [];
  for (const name of allTables) {
    const keys = connection.prepare(`PRAGMA foreign_key_list(${quoted(name)})`).all() as {id: number | bigint; table: string; from: string; to: string}[];
    const groups = new Map<number, typeof keys>();
    for (const key of keys) {
      const group = groups.get(Number(key.id)) ?? [];
      group.push(key);
      groups.set(Number(key.id), group);
    }
    for (const group of groups.values()) {
      if (included.has(group[0]!.table)) relations.push({ child: name, parent: group[0]!.table, pairs: group.map(key => ({from: key.from, to: key.to})) });
    }
  }
  for (const [kind, parent, key] of [["FINANCIAL_EXCEPTION", "financial_exceptions", "exception_id"],
    ["LEDGER_CONFLICT", "ledger_conflicts", "conflict_id"], ["NOTIFICATION_FAILURE", "webhook_deliveries", "delivery_id"]] as const) {
    relations.push({ child: "admin_work_item_operations", parent, pairs: [],
      joinSql: `child.kind = '${kind}' AND child.item_id = parent.${quoted(key)}` });
    relations.push({ child: "admin_operation_log", parent, pairs: [],
      joinSql: `child.action = 'work_items.restore' AND json_extract(child.result_json, '$.type') = '${kind}'
        AND json_extract(child.result_json, '$.resource_id') = parent.${quoted(key)}` });
  }
  // Deduplicated conflicts are also evidence for later observations of the same archived identity.
  relations.push({ child: "provider_raw_events", parent: "ledger_conflicts", pairs: [],
    joinSql: `parent.conflict_type = 'DUPLICATE_EXTERNAL_ID' AND parent.existing_ledger_entry_id IS NULL
      AND child.provider_account_key = parent.provider_account_key AND child.external_event_id = parent.external_event_id` });

  for (const table of tables) {
    connection.exec(`DROP TABLE IF EXISTS temp.${selectedTable(table.name)};
      CREATE TEMP TABLE ${selectedTable(table.name)}(source_rowid INTEGER PRIMARY KEY);`);
    const dates = ["created_at", "updated_at", "occurred_at", "received_at", "observed_at", "started_at", "completed_at", "finished_at", "resolved_at", "released_at", "closed_at"]
      .filter(column => table.columns.includes(column));
    const conditions = dates.map(column => `(${quoted(column)} IS NULL OR ${quoted(column)} < ${before})`);
    const terminal: Record<string, string> = {
      payment_orders: "checkout_status != 'OPEN' AND payment_status != 'DISPUTED'",
      amount_slots: "released_at IS NOT NULL",
      ledger_entries: `state IN ('ALLOCATED', 'IGNORED', 'UNALLOCATED') AND NOT EXISTS (
        SELECT 1 FROM payment_orders AS open_order JOIN collection_profile_provider_accounts AS binding
          ON binding.profile_id = open_order.collection_profile_id
        WHERE open_order.checkout_status = 'OPEN' AND binding.provider_account_key = ledger_entries.provider_account_key
          AND open_order.payable_amount_cents = ledger_entries.amount_cents
          AND open_order.eligible_from < ledger_entries.occurred_at + ledger_entries.occurred_at_precision_ms
          AND open_order.expires_at > ledger_entries.occurred_at)`,
      // Observation numbering continues from the highest online sequence.
      ingest_runs: `status != 'RUNNING' AND ingest_run_id != COALESCE((
        SELECT ingest_run_id FROM ingest_run_page_observations
        ORDER BY observation_sequence DESC LIMIT 1), '')`,
      match_candidates: "status != 'ELIGIBLE'",
      financial_exceptions: "status = 'RESOLVED'",
      ledger_conflicts: "status != 'OPEN'",
      ledger_transactions: "status = 'POSTED'",
      webhook_deliveries: "status IN ('ACKNOWLEDGED', 'DEAD_LETTER')",
      webhook_attempts: "finished_at IS NOT NULL",
      admin_refund_mark_events: `EXISTS (SELECT 1 FROM admin_operation_log AS operation WHERE operation.operation_id = admin_refund_mark_events.operation_id AND operation.created_at < ${before})`,
    };
    if (terminal[table.name]) conditions.push(terminal[table.name]!);
    connection.exec(`INSERT INTO ${selectedTable(table.name)} SELECT rowid FROM ${quoted(table.name)} ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}`);
  }
  const eligibleOrders = countSelected(connection, "payment_orders");

  // Removing one member removes its dependent group. Repeating reaches a closed
  // set whose records can live independently of current business activity.
  let changed: number;
  do {
    changed = 0;
    for (const relation of relations) {
      const join = relation.joinSql ?? relation.pairs.map(pair => `child.${quoted(pair.from)} = parent.${quoted(pair.to)}`).join(" AND ");
      if (included.has(relation.child)) {
        changed += Number(connection.prepare(`DELETE FROM ${selectedTable(relation.child)} WHERE source_rowid IN (
          SELECT child.rowid FROM ${quoted(relation.child)} AS child JOIN ${quoted(relation.parent)} AS parent ON ${join}
          WHERE NOT EXISTS (SELECT 1 FROM ${selectedTable(relation.parent)} WHERE source_rowid = parent.rowid))`).run().changes);
      }
      changed += Number(connection.prepare(`DELETE FROM ${selectedTable(relation.parent)} WHERE source_rowid IN (
        SELECT parent.rowid FROM ${quoted(relation.parent)} AS parent JOIN ${quoted(relation.child)} AS child ON ${join}
        ${included.has(relation.child) ? `WHERE NOT EXISTS (SELECT 1 FROM ${selectedTable(relation.child)} WHERE source_rowid = child.rowid)` : ""})`).run().changes);
    }
    // Stability conflicts also reference their previous page inside JSON.
    const conflictPage = `page.provider_account_key = conflict.provider_account_key AND (
      page.raw_page_id = json_extract(conflict.details_json, '$.existing_raw_page_id') OR
      page.raw_page_id = json_extract(conflict.details_json, '$.incoming_raw_page_id') OR
      page.request_fingerprint = json_extract(conflict.details_json, '$.request_fingerprint'))`;
    changed += Number(connection.prepare(`DELETE FROM ${selectedTable("provider_raw_pages")} WHERE source_rowid IN (
      SELECT page.rowid FROM provider_raw_pages AS page JOIN ledger_conflicts AS conflict ON ${conflictPage}
      WHERE NOT EXISTS (SELECT 1 FROM ${selectedTable("ledger_conflicts")} WHERE source_rowid = conflict.rowid))`).run().changes);
    changed += Number(connection.prepare(`DELETE FROM ${selectedTable("ledger_conflicts")} WHERE source_rowid IN (
      SELECT conflict.rowid FROM ledger_conflicts AS conflict JOIN provider_raw_pages AS page ON ${conflictPage}
      WHERE NOT EXISTS (SELECT 1 FROM ${selectedTable("provider_raw_pages")} WHERE source_rowid = page.rowid))`).run().changes);

    // Keep a continuous online suffix for each account and payable amount.
    changed += Number(connection.prepare(`DELETE FROM ${selectedTable("amount_slots")} WHERE source_rowid IN (
      SELECT slot.rowid FROM amount_slots AS slot WHERE EXISTS (
        SELECT 1 FROM amount_slots AS earlier WHERE earlier.alipay_account_id = slot.alipay_account_id
          AND earlier.payable_amount_cents = slot.payable_amount_cents AND earlier.generation < slot.generation
          AND NOT EXISTS (SELECT 1 FROM ${selectedTable("amount_slots")} WHERE source_rowid = earlier.rowid)))`).run().changes);
  } while (changed > 0);

  return { tables, relations: relations.filter(relation => included.has(relation.child)),
    counts: Object.fromEntries(tables.map(table => [table.name, countSelected(connection, table.name)])), eligibleOrders };
}

function countSelected(connection: DatabaseSync, table: string): number {
  return Number(connection.prepare(`SELECT COUNT(*) AS count FROM ${selectedTable(table)}`).get()!.count);
}

export function dropHistoryArchivePlan(connection: DatabaseSync, plan: HistoryArchivePlan): void {
  for (const table of plan.tables) connection.exec(`DROP TABLE IF EXISTS temp.${selectedTable(table.name)}`);
}
