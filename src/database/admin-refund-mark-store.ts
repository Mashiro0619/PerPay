import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { AppDatabase } from "./database.ts";
import { AdminOperationError, adminFingerprint, adminOperationIdSchema, adminOperationTime,
  recordAdminOperation, replayAdminOperation, type AdminOperationContext } from "./admin-operation-store.ts";

export const refundMarkRequestSchema = z.object({
  operation_id: adminOperationIdSchema,
  version: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1),
  marked: z.boolean(),
  note: z.string().refine((s) => s.isWellFormed(), "must contain Unicode scalar values")
    .refine((s) => Array.from(s).length <= 500, "must contain at most 500 characters")
    .refine((s) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(s), "must not contain non-whitespace control characters").trim().optional(),
}).strict();
export interface AdminRefundMark {
  readonly marked: boolean; readonly version: number; readonly note: string | null;
  readonly updated_at: string | null; readonly updated_by: string | null;
}
export interface AdminRefundMarkEvent extends AdminRefundMark { readonly operation_id: string; }
const EMPTY_MARK: AdminRefundMark = Object.freeze({ marked: false, version: 0, note: null, updated_at: null, updated_by: null });
interface MarkRow { order_id: string; operation_id: string; marked: number | bigint; version: number | bigint; note: string | null; created_at: number | bigint; actor_id: string; }
const EVENT_SELECT = `SELECT event.order_id, event.operation_id, event.version, event.marked, event.note, op.created_at, op.actor_id
  FROM admin_refund_mark_events AS event JOIN admin_operation_log AS op ON op.operation_id = event.operation_id`;

export function adminRefundMarks(database: AppDatabase, orderIds: readonly string[]): ReadonlyMap<string, AdminRefundMark> {
  if (!orderIds.length) return new Map();
  return database.read((connection) => {
    const rows = connection.prepare(EVENT_SELECT + " JOIN admin_refund_marks AS current ON current.order_id = event.order_id AND current.version = event.version WHERE event.order_id IN (" + orderIds.map(() => "?").join(",") + ")")
      .all(...orderIds) as unknown as MarkRow[];
    const values = new Map<string, AdminRefundMark>(orderIds.map((id) => [id, EMPTY_MARK]));
    for (const row of rows) values.set(row.order_id, mapMark(row));
    return values;
  });
}
export function adminRefundMarkHistory(database: AppDatabase, orderId: string): readonly AdminRefundMarkEvent[] {
  return database.read((connection) => (connection.prepare(EVENT_SELECT + " WHERE event.order_id = ? ORDER BY event.version DESC")
    .all(orderId) as unknown as MarkRow[]).map((row) => ({ ...mapMark(row), operation_id: row.operation_id })));
}
export function setAdminRefundMark(database: AppDatabase, orderId: string, input: z.infer<typeof refundMarkRequestSchema>, context: AdminOperationContext): { operation_id: string; refund_mark: AdminRefundMark } {
  adminOperationIdSchema.parse(orderId);
  const request = refundMarkRequestSchema.parse(input);
  const note = request.note || null;
  const fingerprint = adminFingerprint({ order_id: orderId, version: request.version, marked: request.marked, note });
  return database.write((connection) => {
    const replay = replayAdminOperation<{ operation_id: string; refund_mark: AdminRefundMark }>(connection, request.operation_id, "orders.refund_mark", fingerprint, context.actorId);
    if (replay) return replay;
    const order = connection.prepare("SELECT payment_status, received_amount_cents FROM payment_orders WHERE order_id = ?").get(orderId) as { payment_status: string; received_amount_cents: number | bigint | null } | undefined;
    if (!order) throw new AdminOperationError(404, "order_not_found", "订单不存在");
    const version = currentVersion(connection, orderId);
    if (version !== request.version) throw new AdminOperationError(409, "refund_mark_version_conflict", "退款标记已变化，请刷新后重试");
    if (request.marked && (!["CONFIRMED", "DISPUTED"].includes(order.payment_status) || Number(order.received_amount_cents ?? 0) <= 0)) {
      throw new AdminOperationError(409, "refund_mark_not_allowed", "只有存在实收金额的已确认或争议订单可以标记退款");
    }
    const now = adminOperationTime(connection, context.now);
    const result = { operation_id: request.operation_id, refund_mark: { marked: request.marked, version: version + 1, note,
      updated_at: new Date(now).toISOString(), updated_by: context.actorId } };
    recordAdminOperation(connection, { operationId: request.operation_id, action: "orders.refund_mark", requestFingerprint: fingerprint,
      result, now, context, subjectId: orderId });
    connection.prepare("INSERT INTO admin_refund_mark_events(operation_id, order_id, version, marked, note) VALUES (?, ?, ?, ?, ?)")
      .run(request.operation_id, orderId, version + 1, request.marked ? 1 : 0, note);
    if (version === 0) {
      connection.prepare("INSERT INTO admin_refund_marks(order_id, version) VALUES (?, 1)").run(orderId);
    } else {
      connection.prepare("UPDATE admin_refund_marks SET version = ? WHERE order_id = ? AND version = ?").run(version + 1, orderId, version);
    }
    return result;
  });
}
function currentVersion(connection: DatabaseSync, orderId: string): number {
  const row = connection.prepare("SELECT version FROM admin_refund_marks WHERE order_id = ?").get(orderId) as { version: bigint | number } | undefined;
  return Number(row?.version ?? 0);
}
function mapMark(row: MarkRow): AdminRefundMark {
  return { marked: Number(row.marked) === 1, version: Number(row.version), note: row.note,
    updated_at: new Date(Number(row.created_at)).toISOString(), updated_by: row.actor_id };
}
