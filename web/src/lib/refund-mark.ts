import type {
  AdminRefundMarkEnvelope,
  AdminRefundMarkRequest,
} from "@/api/client";

export function refundMarkNoteError(note: string): string | null {
  if (/[\uD800-\uDFFF]/u.test(note))
    return "备注含有无效的 Unicode 字符，请删除后重新输入。";
  if (Array.from(note).length > 500) return "备注最多 500 字。";
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(note))
    return "备注含有不支持的控制字符；可以保留换行和制表符。";
  return null;
}

/** A replay is a receipt for this historical change, not the latest mark state. */
export function isRefundMarkReceipt(
  value: unknown,
  request: AdminRefundMarkRequest,
): value is AdminRefundMarkEnvelope {
  const data = (value as Partial<AdminRefundMarkEnvelope> | null | undefined)
    ?.data;
  const mark = data?.refund_mark;
  return (
    data?.operation_id === request.operation_id &&
    !!mark &&
    mark.version === request.version + 1 &&
    mark.marked === request.marked &&
    mark.note === (request.note || null) &&
    typeof mark.updated_by === "string" &&
    mark.updated_by.trim().length > 0 &&
    typeof mark.updated_at === "string" &&
    Number.isFinite(Date.parse(mark.updated_at))
  );
}
