import type { DatabaseSync } from "node:sqlite";
import { adminFingerprint, adminOperationIdSchema } from "./admin-operation-store.ts";
import { refundMarkRequestSchema } from "./admin-refund-mark-store.ts";

const tables = ["admin_operation_log", "admin_work_item_operations", "admin_work_item_states", "admin_refund_mark_events", "admin_refund_marks"];
const resourceTables: Record<string, [string, string]> = {
  FINANCIAL_EXCEPTION: ["financial_exceptions", "exception_id"],
  LEDGER_CONFLICT: ["ledger_conflicts", "conflict_id"],
  NOTIFICATION_FAILURE: ["webhook_deliveries", "delivery_id"],
};
interface OperationRow { operation_id: string; action: string; actor_id: string; request_fingerprint: string; result_json: string; created_at: number | bigint; }
interface Member { kind: string; item_id: string; }
interface AuditRow { actor_id: string; action: string; subject_id: string; occurred_at: number | bigint; details_json: string; }

/** Offline/backup checks also bind mutable projections and immutable operation results to the audit chain. */
export function countAdminOperationViolations(connection: DatabaseSync): number {
  const present = tables.filter((table) => connection.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table));
  if (present.length === 0) return 0; // Pre-schema-23 backups remain verifiable before migration.
  if (present.length !== tables.length) return 1;
  let violations = 0;
  const audits = new Map<string, AuditRow[]>();
  for (const row of connection.prepare("SELECT actor_id, action, subject_id, occurred_at, details_json FROM audit_events WHERE actor_type = 'ADMIN' AND subject_type = 'admin_operation' AND outcome = 'SUCCESS'").all() as unknown as AuditRow[]) {
    const details = JSON.parse(row.details_json) as { operation_id?: string };
    if (!details.operation_id) { violations += 1; continue; }
    audits.set(details.operation_id, [...(audits.get(details.operation_id) ?? []), row]);
  }
  const membership = connection.prepare("SELECT kind, item_id FROM admin_work_item_operations WHERE operation_id = ? ORDER BY kind, item_id");
  const markEvent = connection.prepare("SELECT order_id, version, marked, note FROM admin_refund_mark_events WHERE operation_id = ?");
  for (const op of connection.prepare("SELECT * FROM admin_operation_log").iterate() as Iterable<OperationRow>) {
    const result = JSON.parse(op.result_json) as Record<string, unknown>;
    const members = membership.all(op.operation_id) as unknown as Member[];
    const event = markEvent.get(op.operation_id) as { order_id: string; version: number | bigint; marked: number | bigint; note: string | null } | undefined;
    const linked = audits.get(op.operation_id) ?? []; audits.delete(op.operation_id);
    const audit = linked[0];
    const details = audit ? JSON.parse(audit.details_json) as Record<string, unknown> : {};
    if (!adminOperationIdSchema.safeParse(op.operation_id).success || linked.length !== 1 || audit?.actor_id !== op.actor_id || audit?.action !== op.action || Number(audit?.occurred_at) !== Number(op.created_at) || details.request_fingerprint !== op.request_fingerprint || details.result_fingerprint !== adminFingerprint(result)) violations += 1;
    let expected: unknown;
    let request: unknown;
    if (op.action === "work_items.ignore_all") {
      if (result.type !== "ALL" && !Object.hasOwn(resourceTables, String(result.type))) violations += 1;
      if (event || members.some((member) => result.type !== "ALL" && member.kind !== result.type) || details.membership_fingerprint !== adminFingerprint(members)) violations += 1;
      expected = { operation_id: op.operation_id, type: result.type, ignored_count: members.length };
      request = { type: result.type };
    } else if (op.action === "work_items.restore") {
      if (!Object.hasOwn(resourceTables, String(result.type)) || !adminOperationIdSchema.safeParse(result.resource_id).success || typeof result.restored !== "boolean" || event) violations += 1;
      if (result.restored === true ? members.length !== 1 || members[0]?.kind !== result.type || members[0]?.item_id !== result.resource_id : members.length !== 0) violations += 1;
      if (!resourceExists(connection, String(result.type), String(result.resource_id))) violations += 1;
      expected = { operation_id: op.operation_id, type: result.type, resource_id: result.resource_id, restored: result.restored };
      request = { type: result.type, resource_id: result.resource_id };
    } else if (op.action === "orders.refund_mark" && event) {
      const version = Number(event.version), marked = Number(event.marked) === 1;
      const valid = refundMarkRequestSchema.safeParse({ operation_id: op.operation_id, version: version - 1, marked, ...(event.note !== null ? { note: event.note } : {}) });
      if (!valid.success || members.length > 0 || (event.note !== null && (event.note.trim() !== event.note || !event.note))) violations += 1;
      expected = { operation_id: op.operation_id, refund_mark: { marked, version, note: event.note, updated_at: new Date(Number(op.created_at)).toISOString(), updated_by: op.actor_id } };
      request = { order_id: event.order_id, version: version - 1, marked, note: event.note };
    } else { violations += 1; }
    if (audit?.subject_id !== (event?.order_id ?? op.operation_id) || JSON.stringify(result) !== JSON.stringify(expected) || op.request_fingerprint !== adminFingerprint(request)) violations += 1;
    for (const member of members) if (!resourceExists(connection, member.kind, member.item_id)) violations += 1;
  }
  violations += audits.size;
  const count = (sql: string) => Number((connection.prepare(sql).get() as { count: number | bigint }).count);
  violations += count(`SELECT COUNT(*) AS count FROM admin_work_item_states AS state JOIN admin_operation_log AS op ON op.operation_id = state.operation_id
    WHERE state.updated_at != op.created_at OR op.action != CASE state.ignored WHEN 1 THEN 'work_items.ignore_all' ELSE 'work_items.restore' END
      OR EXISTS (SELECT 1 FROM admin_work_item_operations AS member JOIN admin_operation_log AS later ON later.operation_id = member.operation_id
        WHERE member.kind = state.kind AND member.item_id = state.item_id AND later.created_at > op.created_at)`);
  violations += count(`SELECT COUNT(*) AS count FROM (SELECT kind, item_id FROM admin_work_item_operations GROUP BY kind, item_id) AS member
    WHERE NOT EXISTS (SELECT 1 FROM admin_work_item_states AS state WHERE state.kind = member.kind AND state.item_id = member.item_id)`);
  violations += count(`SELECT COUNT(*) AS count FROM (SELECT event.order_id, MAX(event.version) AS latest, COUNT(*) AS revisions, current.version
    FROM admin_refund_mark_events AS event LEFT JOIN admin_refund_marks AS current ON current.order_id = event.order_id
    GROUP BY event.order_id HAVING current.version IS NULL OR current.version != MAX(event.version) OR COUNT(*) != MAX(event.version))`);
  return violations;
}
function resourceExists(connection: DatabaseSync, kind: string, id: string): boolean {
  const table = Object.hasOwn(resourceTables, kind) ? resourceTables[kind] : undefined;
  return !!table && !!connection.prepare("SELECT 1 FROM " + table[0] + " WHERE " + table[1] + " = ?").get(id);
}
