import type { AdminWorkItem } from "../api/client";

const labels: Record<string, string> = {
  UNMATCHED_CREDIT: "收入尚未匹配订单", UNMATCHED_DEBIT: "支出尚未匹配订单", AMBIGUOUS_MATCH: "存在多个匹配候选",
  CHECKOUT_ENDED_PAYMENT: "收银台结束后收到付款", DUPLICATE_PAYMENT: "订单重复付款", AMOUNT_MISMATCH: "实收金额不符",
  UNLINKED_REFUND: "退款流水尚未关联", RECONCILIATION_CONFLICT: "对账结果冲突", RAW_PAGE_VARIANT: "账单原始页发生变化",
  DUPLICATE_EXTERNAL_ID: "外部流水号重复", MISSING_EXTERNAL_ID: "缺少外部流水号", INVALID_AMOUNT: "流水金额无法解析",
  INVALID_TIMESTAMP: "流水时间无法解析", INVALID_DIRECTION: "收支方向无效", INVALID_SHAPE: "流水结构无效",
  CREATED: "订单已创建", CHECKOUT_CLOSED: "收银台已关闭", CHECKOUT_EXPIRED: "收银台已过期", PAYMENT_CONFIRMED: "付款已确认",
  PAYMENT_DISPUTED: "付款存在争议", REFUND_UPDATED: "退款记录已更新", ACKNOWLEDGED: "业务方已确认", HTTP_ERROR: "HTTP 错误",
  NETWORK_ERROR: "网络连接失败", TIMEOUT: "请求超时", INVALID_ACKNOWLEDGEMENT: "确认响应无效", IN_FLIGHT: "投递中",
  STARTED: "投递已开始", RETRYABLE_FAILURE: "可重试的投递失败", PERMANENT_FAILURE: "不可重试的投递失败", OUTCOME_UNKNOWN: "投递结果未知",
  KEEP_EXISTING: "保留已有流水", ACKNOWLEDGE_ISOLATED: "确认隔离记录", CONFIRM_VARIANT: "原始页变更已确认",
  healthy: "运行正常", running: "运行中", catching_up: "补采历史账单", degraded: "运行异常", idle: "等待执行", stopped: "已停止",
  UNALLOCATED: "未分配", CANDIDATE: "存在匹配候选", ALLOCATED: "已分配", CONFLICT: "存在冲突", ISOLATED: "已隔离", IGNORED: "已忽略",
};

export function label(value: string | null | undefined): string { return value ? labels[value] ?? value : "—"; }

export function workItemTitle(item: AdminWorkItem): string {
  if (item.type === "FINANCIAL_EXCEPTION") return label(item.exception_type);
  if (item.type === "LEDGER_CONFLICT") return label(item.conflict_type);
  return item.status === "DEAD_LETTER" ? "业务通知已停止重试" : "业务通知正在等待重试";
}

export function workItemHref(item: AdminWorkItem): string {
  return item.type === "NOTIFICATION_FAILURE" ? `/notifications/${item.resource_id}`
    : `/reconciliation/${item.type === "LEDGER_CONFLICT" ? "conflicts" : "exceptions"}/${item.resource_id}`;
}
