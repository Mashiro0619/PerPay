import { Badge } from "@/components/ui/badge";
import { CircleCheck, CircleDashed, CircleAlert, Clock3 } from "lucide-react";

const states = {
  CONFIRMED: ["已确认", "outline", CircleCheck],
  UNPAID: ["未付款", "secondary", CircleDashed],
  DISPUTED: ["有争议", "destructive", CircleAlert],
  OPEN: ["开放中", "outline"],
  CLOSED: ["已关闭", "secondary"],
  EXPIRED: ["已过期", "secondary"],
  ACKNOWLEDGED: ["已确认送达", "outline", CircleCheck],
  PENDING: ["等待投递", "secondary", Clock3],
  LEASED: ["投递中", "outline", Clock3],
  RETRY_WAIT: ["等待重试", "outline", Clock3],
  DEAD_LETTER: ["投递失败", "destructive", CircleAlert],
  SETTLED: ["已关联", "outline", CircleCheck],
  REVERSED: ["已撤销", "secondary"],
  RESOLVED: ["已处理", "outline", CircleCheck],
  IGNORED: ["已隔离", "secondary"],
  ready: ["收款就绪", "outline", CircleCheck],
  degraded: ["需要关注", "outline", CircleAlert],
  not_ready: ["尚未就绪", "destructive", CircleAlert],
  ADMIN_REFUND_MARK: ["已标记退款", "destructive"],
  NONE: ["无", "secondary"],
  PARTIAL: ["部分退款", "outline"],
  FULL: ["全额退款", "secondary"],
  MANUAL: ["人工确认", "outline"],
  AMOUNT_INFERRED: ["金额推断", "secondary"],
  INFERRED: ["金额推断", "secondary"],
  FINANCIAL_EXCEPTION: ["账务异常", "outline"],
  LEDGER_CONFLICT: ["账本冲突", "outline"],
  NOTIFICATION_FAILURE: ["通知失败", "outline"],
  CREDIT: ["收入", "outline"],
  DEBIT: ["支出", "secondary"],
  ELIGIBLE: ["可匹配", "outline"],
  SELECTED: ["已选用", "outline"],
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
    <Badge variant={variant}>
      {Icon && <Icon data-icon="inline-start" />}
      {label ?? text}
    </Badge>
  );
}
