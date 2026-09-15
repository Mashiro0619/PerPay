import type { AdminOrderEvent, FinancialException, MatchCandidate, WebhookAttempt } from "../api/client";
import { BUSINESS_TIME_ZONE, money } from "./format";

const timestampFormatters = [0, 3].map(digits => new Intl.DateTimeFormat("zh-CN", {
  timeZone: BUSINESS_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  ...(digits ? { fractionalSecondDigits: 3 as const } : {}),
}));
export function detailTimestamp(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return timestampFormatters[date.getUTCMilliseconds() ? 1 : 0]!.format(date);
}

export function textField(record: Record<string, unknown> | null | undefined, name: string): string | null {
  const value = record?.[name];
  return typeof value === "string" && value.trim() ? value : null;
}
export function numberField(record: Record<string, unknown> | null | undefined, name: string): number | null {
  const value = record?.[name];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}
export function candidateFacts(candidate: MatchCandidate): Array<[string, string]> {
  const evidence = candidate.evidence;
  if (evidence.schema !== "perpay:match-candidate:v3") return [];
  const amount = numberField(evidence, "amount_cents");
  const occurred = numberField(evidence, "occurred_at");
  const start = numberField(evidence, "slot_occupied_from");
  const end = numberField(evidence, "slot_released_at");
  return [
    ...(amount !== null && amount > 0 ? [["匹配金额", money(amount)] as [string, string]] : []),
    ...(occurred !== null && occurred >= 0 ? [["流水发生时间", detailTimestamp(occurred)] as [string, string]] : []),
    ...(start !== null && start >= 0 ? [["金额占用窗口", detailTimestamp(start) + " 至 " + (end !== null && end >= start ? detailTimestamp(end) : evidence.slot_released_at === null ? "记录时尚未释放" : "终点未记录")] as [string, string]] : []),
  ];
}
export function isHistoricalException(exception: FinancialException): boolean {
  return exception.status !== "OPEN" || exception.reminder_ignored || ["UNMATCHED_DEBIT", "UNLINKED_REFUND"].includes(exception.exception_type);
}
export function exceptionStateLabel(exception: FinancialException): string {
  if (["UNMATCHED_DEBIT", "UNLINKED_REFUND"].includes(exception.exception_type)) return "历史记录";
  if (exception.status === "RESOLVED") return "已处理";
  return exception.reminder_ignored ? "已忽略提醒" : "待处理";
}
export function exceptionExplanation(exception: FinancialException): string {
  const details = exception.details;
  switch (exception.exception_type) {
    case "UNMATCHED_CREDIT": return "这笔收入尚未找到符合金额与付款时间窗口的订单，不代表付款失败。";
    case "UNMATCHED_DEBIT": case "UNLINKED_REFUND": return "这是旧版支出提示，保留原始记录，不再作为待处理提醒。";
    case "AMBIGUOUS_MATCH": {
      const count = numberField(details, "candidate_count");
      return count !== null && count > 1 ? "同一笔收入存在 " + count + " 个匹配候选，无法唯一确认订单。" : "这笔收入存在多个匹配候选，不能仅凭金额确认归属。";
    }
    case "AMOUNT_MISMATCH": {
      const expected = numberField(details, "expected_amount_cents"); const actual = numberField(details, "actual_amount_cents");
      return expected !== null && actual !== null ? "流水金额 " + money(actual) + " 与可能关联订单的应付 " + money(expected) + " 不一致；此关联仅为推断。" : "流水金额与可能关联订单的应付金额不同，尚不能确认归属。";
    }
    case "CHECKOUT_ENDED_PAYMENT": return "流水发生在收银台关闭或过期之后，系统未自动确认该订单付款。";
    case "DUPLICATE_PAYMENT": return "可能对应的订单已存在收款关联，本笔收入未被重复计入。";
    case "RECONCILIATION_CONFLICT": return details.reason === "settlement_reversed" ? "原收款关联已被撤销，订单进入争议状态；原始流水和操作记录仍保留。" : "当前对账证据存在冲突，不能直接视为有效收款。";
  }
}
export function exceptionResolution(exception: FinancialException): string | null {
  const resolution = textField(exception.resolution, "resolution");
  const labels: Record<string, string> = { auto_settled: "已由系统建立收款关联。", manually_settled: "已由管理员建立收款关联。", superseded_by_settlement: "该流水已关联到另一订单，本条候选异常已结束。" };
  if (resolution && labels[resolution]) return labels[resolution];
  return exception.status === "RESOLVED" ? "该异常已处理，原始决定见技术详情。" : null;
}
export function eventExplanation(event: AdminOrderEvent): string {
  switch (event.event_type) {
    case "CREATED": return "已生成订单及付款窗口。";
    case "PAYMENT_CONFIRMED": return event.details.evidence_type === "MANUAL" ? "管理员关联收入后确认付款。" : event.details.evidence_type === "AMOUNT_INFERRED" ? "系统按金额及付款时间窗口推断确认。" : "付款状态已确认，依据见收款记录。";
    case "PAYMENT_DISPUTED": return "付款进入争议状态，需结合关联记录查看。";
    case "CHECKOUT_CLOSED": return "收银台已关闭，不改变已有付款事实。";
    case "CHECKOUT_EXPIRED": return "付款窗口已结束，不代表已确认的付款失效。";
    case "REFUND_UPDATED": return "旧版退款记录发生变化，按历史语义保留。";
  }
}
export function latestAttempt(attempts: readonly WebhookAttempt[]): WebhookAttempt | undefined {
  return attempts.reduce<WebhookAttempt | undefined>((latest, attempt) => !latest || attempt.attempt_number > latest.attempt_number ? attempt : latest, undefined);
}
const notificationErrorNames: Record<string, string> = {
  INVALID_ACKNOWLEDGEMENT: "业务确认响应无效", TIMEOUT: "请求超时", NETWORK_ERROR: "网络连接失败",
  http_status_not_ack: "HTTP 状态不符合确认要求", ack_content_type_invalid: "确认响应类型不正确",
  ack_content_encoding_invalid: "确认响应编码不正确", ack_json_invalid: "确认响应不是有效 JSON",
  ack_shape_invalid: "业务确认响应格式不正确", ack_event_mismatch: "确认的事件编号不匹配", ack_delivery_mismatch: "确认的投递编号不匹配",
  transport_timeout: "请求超时", transport_network: "网络连接失败", transport_cancelled: "投递请求已取消",
  dns_no_addresses: "通知域名未解析到地址", dns_failed: "通知域名解析失败", tls_verification_failed: "通知地址的 TLS 证书验证失败",
  target_address_forbidden: "通知地址被安全规则拦截", target_address_limit: "通知地址数量超出限制", webhook_target_invalid: "通知地址无效",
  response_headers_invalid: "响应头无效", response_body_too_large: "响应内容过大", request_body_too_large: "请求内容过大", request_headers_invalid: "请求头无效",
  lease_expired_outcome_unknown: "投递执行超时，结果未知",
};
export function notificationErrorName(code: string): string { return notificationErrorNames[code] ?? code; }
export function attemptResult(attempt: WebhookAttempt | undefined): string {
  if (!attempt) return "尚未开始投递";
  const http = attempt.http_status === null ? "未收到 HTTP 响应" : "HTTP " + attempt.http_status;
  if (attempt.outcome === "ACKNOWLEDGED") return http + " · ACK 已确认";
  if (attempt.outcome === "STARTED") return "投递进行中，尚未确认结果";
  const result = attempt.error_code ?? attempt.ack_code;
  return http + " · " + (result ? notificationErrorName(result) : attempt.outcome === "OUTCOME_UNKNOWN" ? "结果未知" : "未获得有效 ACK");
}
