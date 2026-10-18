import { Badge } from "@/components/ui/badge";
import { CircleCheck, CircleDashed, CircleAlert, Clock3 } from "lucide-react";

const states = {
  CONFIRMED: ["收款已确认", "success", CircleCheck],
  UNPAID: ["待付款", "secondary", CircleDashed],
  DISPUTED: ["收款有争议", "destructive", CircleAlert],
  OPEN: ["开放中", "outline"],
  CLOSED: ["已关闭", "secondary"],
  EXPIRED: ["已过期", "secondary"],
  ACKNOWLEDGED: ["通知已确认", "success", CircleCheck],
  PENDING: ["等待投递", "secondary", Clock3],
  LEASED: ["投递中", "warning", Clock3],
  RETRY_WAIT: ["等待重试", "warning", Clock3],
  DEAD_LETTER: ["已停止重试", "destructive", CircleAlert],
  SETTLED: ["已关联", "success", CircleCheck],
  REVERSED: ["已撤销", "secondary"],
  RESOLVED: ["已处理", "success", CircleCheck],
  IGNORED: ["已隔离", "secondary"],
  ready: ["收款就绪", "success", CircleCheck],
  degraded: ["需要关注", "warning", CircleAlert],
  not_ready: ["尚未就绪", "destructive", CircleAlert],
  ADMIN_REFUND_MARK: ["已标记退款", "destructive"],
  NONE: ["无", "secondary"],
  PARTIAL: ["部分退款", "outline"],
  FULL: ["全额退款", "secondary"],
  MANUAL: ["人工关联", "outline"],
  AMOUNT_INFERRED: ["金额推断", "secondary"],
  INFERRED: ["金额推断", "secondary"],
  FINANCIAL_EXCEPTION: ["账务异常", "destructive", CircleAlert],
  LEDGER_CONFLICT: ["账本冲突", "destructive", CircleAlert],
  NOTIFICATION_FAILURE: ["通知失败", "destructive", CircleAlert],
  CREDIT: ["收入", "outline"],
  DEBIT: ["支出", "secondary"],
  ELIGIBLE: ["可匹配", "outline"],
  SELECTED: ["已选用", "success", CircleCheck],
  SUPERSEDED: ["已替代", "secondary"],
} as const;

export function StatusBadge({
  value,
  label,
}: {
  value: string;
  label?: string | undefined;
}) {
  const [text, variant, Icon] = states[value as keyof typeof states] ?? [
    value,
    "secondary",
  ];
  return (
    <Badge variant={variant} className="h-auto min-h-5 max-w-full whitespace-normal wrap-anywhere">
      {Icon && <Icon data-icon="inline-start" />}
      {label ?? text}
    </Badge>
  );
}

export function paymentBasisDescription(basis: string): string | null {
  if (basis === "INFERRED") return "PerPay 按金额和付款时间推断";
  if (basis === "MANUAL") return "管理员人工关联";
  return null;
}
