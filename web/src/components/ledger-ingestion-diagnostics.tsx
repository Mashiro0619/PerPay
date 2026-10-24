import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import type { LedgerDiagnostics } from "@/api/generated/types.gen";
import { CircleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { BUSINESS_TIME_ZONE } from "@/lib/format";

const time = new Intl.DateTimeFormat("zh-CN", {
  timeZone: BUSINESS_TIME_ZONE,
  dateStyle: "short",
  timeStyle: "medium",
  hour12: false,
});
function timestamp(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "时间不可用" : time.format(parsed);
}

export function LedgerIngestionDiagnostics({
  diagnostics,
}: {
  diagnostics: LedgerDiagnostics | undefined;
}) {
  if (!diagnostics) return null;
  if (!diagnostics.available)
    return (
      <Alert>
        <CircleAlert />
        <AlertTitle>查账诊断暂不可用</AlertTitle>
        <AlertDescription>
          失败记录暂不可读，请刷新。查账是否恢复尚未确认。
        </AlertDescription>
      </Alert>
    );
  const failures = diagnostics.consecutive_failures ?? 0;
  if (failures === 0) return null;
  const latest = diagnostics.latest_failure;
  return (
    <Alert variant={failures >= 3 ? "destructive" : "default"}>
      <CircleAlert />
      <AlertTitle>
        {failures >= 3 ? "查账持续失败" : "查账失败，等待恢复"}
      </AlertTitle>
      <AlertDescription>
        <div className="flex flex-col gap-2">
          <p>当前查账来源连续失败 {failures} 次。</p>
          {latest && (
            <>
              <p>
                {latest.scan_kind === "NORMAL" ? "正常查账" : "历史查账"}：
                {latest.reason}
              </p>
              <Collapsible>
                <CollapsibleTrigger
                  render={<Button variant="ghost" size="sm" />}
                >
                  失败详情
                </CollapsibleTrigger>
                <CollapsibleContent keepMounted className="flex flex-col gap-2">
                  <p>次数包含当前来源的正常与历史查账失败，并非同一账单页的重试次数。</p>
                  <p>原始错误码：<code className="wrap-anywhere">{latest.error_code}</code></p>
                  <p>
                    {latest.scan_kind === "NORMAL"
                      ? "本次正常查账未完成。是否暂停新订单请查看就绪状态。"
                      : "历史流水核对可能延迟，正常查账可能仍在运行。"}
                  </p>
                  <p>
                    失败窗口：{timestamp(latest.window_start)} 至{" "}
                    {timestamp(latest.window_end)}
                  </p>
                  <p>最近失败：{timestamp(latest.occurred_at)}</p>
                </CollapsibleContent>
              </Collapsible>
            </>
          )}
          <p>
            {diagnostics.in_flight
              ? "正在查账，请等待本轮结果。"
              : diagnostics.next_retry_at
                ? `计划下次尝试：${timestamp(diagnostics.next_retry_at)}`
                : "重试时间未定，请检查查账任务。"}
          </p>
          <p>
            检查网络与支付宝配置。持续失败时，请保留失败窗口和错误记录，按
            <a
              data-external-link
              href="https://github.com/Mashiro0619/PerPay/blob/main/docs/maintenance.md#采集持续失败"
              target="_blank"
              rel="noopener noreferrer"
            >
              安全恢复指引
            </a>
            处理。
          </p>
        </div>
      </AlertDescription>
    </Alert>
  );
}
