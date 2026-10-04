import type { LedgerDiagnostics } from "@/api/generated/types.gen";
import { CircleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { BUSINESS_TIME_ZONE } from "@/lib/format";

const time = new Intl.DateTimeFormat("zh-CN", {
  timeZone: BUSINESS_TIME_ZONE, dateStyle: "short", timeStyle: "medium", hour12: false,
});
function timestamp(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "时间不可用" : time.format(parsed);
}

export function LedgerIngestionDiagnostics({ diagnostics }: { diagnostics: LedgerDiagnostics | undefined }) {
  if (!diagnostics) return null;
  if (!diagnostics.available) return (
    <Alert><CircleAlert /><AlertTitle>采集诊断暂不可用</AlertTitle>
      <AlertDescription>暂时无法读取失败记录，请稍后刷新运行状态；这不表示采集已恢复。</AlertDescription>
    </Alert>
  );
  const failures = diagnostics.consecutive_failures ?? 0;
  if (failures === 0) return null;
  const latest = diagnostics.latest_failure;
  return (
    <Alert variant={failures >= 3 ? "destructive" : "default"}>
      <CircleAlert />
      <AlertTitle>{failures >= 3 ? "采集持续失败" : "采集失败，等待恢复"}</AlertTitle>
      <AlertDescription>
        <div className="flex flex-col gap-2">
          <p>账户级连续失败 {failures} 次，不代表同一账单页重复失败的次数。</p>
          {latest && <>
            <p>{latest.scan_kind === "NORMAL"
              ? "最近失败属于正常采集，该查询窗口尚未完成；收款是否暂停以当前就绪状态为准。"
              : "最近失败属于历史补采，不代表正常采集也已停止；历史流水核对可能延迟。"}</p>
            <p>{latest.reason}（{latest.error_code}）</p>
            <p>失败窗口：{timestamp(latest.window_start)} 至 {timestamp(latest.window_end)}</p>
            <p>最近失败：{timestamp(latest.occurred_at)}</p>
          </>}
          <p>{diagnostics.in_flight ? "正在采集，请等待本轮结果。"
            : diagnostics.next_retry_at ? `计划下次尝试：${timestamp(diagnostics.next_retry_at)}`
            : "下次尝试时间尚未确定，请检查采集任务运行状态。"}</p>
          <p>检查网络和支付宝配置；持续失败时保留失败窗口与错误记录，按
            <a href="https://github.com/Mashiro0619/PerPay/blob/main/docs/maintenance.md#采集持续失败"
              target="_blank" rel="noopener noreferrer">安全恢复指引</a>处理。不要删除游标或跳过账单。</p>
        </div>
      </AlertDescription>
    </Alert>
  );
}
