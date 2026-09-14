import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

import { appendAuditEvent } from "./identity-store.ts";

export const adminOperationIdSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
export type AdminOperationAction = "work_items.ignore_all" | "work_items.restore" | "orders.refund_mark";
export interface AdminOperationContext {
  readonly actorId: string;
  readonly requestId?: string | undefined;
  readonly remoteAddressHash?: string | undefined;
  readonly now?: number | undefined;
}
export type AdminOperationErrorCode = "admin_operation_conflict" | "work_item_not_found" | "work_item_ended"
  | "order_not_found" | "refund_mark_version_conflict" | "refund_mark_not_allowed" | "refund_recording_retired";
export class AdminOperationError extends Error {
  readonly status: 404 | 409 | 410;
  readonly code: AdminOperationErrorCode;
  constructor(status: 404 | 409 | 410, code: AdminOperationErrorCode, message: string) {
    super(message); this.name = "AdminOperationError"; this.status = status; this.code = code;
  }
}

export function adminFingerprint(value: unknown): string {
  return createHash("sha256").update("perpay:admin-operation:v1\0" + JSON.stringify(value)).digest("hex");
}

export function replayAdminOperation<T>(connection: DatabaseSync, operationId: string, action: AdminOperationAction,
  requestFingerprint: string, actorId: string): T | undefined {
  const row = connection.prepare("SELECT action, actor_id, request_fingerprint, result_json FROM admin_operation_log WHERE operation_id = ?")
    .get(operationId) as { action: string; actor_id: string; request_fingerprint: string; result_json: string } | undefined;
  if (!row) return undefined;
  if (row.action !== action || row.request_fingerprint !== requestFingerprint || row.actor_id !== actorId) {
    throw new AdminOperationError(409, "admin_operation_conflict", "操作编号已经用于其他请求，请刷新后重试");
  }
  return JSON.parse(row.result_json) as T;
}

export function adminOperationTime(connection: DatabaseSync, requested = Date.now()): number {
  if (!Number.isSafeInteger(requested) || requested < 0) throw new RangeError("administrator operation time is invalid");
  const row = connection.prepare("SELECT max(created_at) AS latest FROM admin_operation_log").get() as { latest: bigint | number | null };
  const now = Math.max(requested, row.latest === null ? 0 : Number(row.latest) + 1);
  if (!Number.isSafeInteger(now)) throw new RangeError("administrator operation clock is exhausted");
  return now;
}

export function recordAdminOperation(connection: DatabaseSync, input: {
  readonly operationId: string; readonly action: AdminOperationAction; readonly requestFingerprint: string;
  readonly result: unknown; readonly now: number; readonly context: AdminOperationContext;
  readonly subjectId?: string | undefined; readonly membershipFingerprint?: string | undefined;
}): void {
  connection.prepare("INSERT INTO admin_operation_log(operation_id, action, actor_id, request_fingerprint, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(input.operationId, input.action, input.context.actorId, input.requestFingerprint, JSON.stringify(input.result), input.now);
  appendAuditEvent(connection, {
    occurredAt: input.now, actorType: "ADMIN", actorId: input.context.actorId, action: input.action,
    outcome: "SUCCESS", subjectType: "admin_operation", subjectId: input.subjectId ?? input.operationId,
    requestId: input.context.requestId, remoteAddressHash: input.context.remoteAddressHash,
    details: { operation_id: input.operationId, request_fingerprint: input.requestFingerprint,
      result_fingerprint: adminFingerprint(input.result), ...(input.membershipFingerprint ? { membership_fingerprint: input.membershipFingerprint } : {}) },
  });
}
