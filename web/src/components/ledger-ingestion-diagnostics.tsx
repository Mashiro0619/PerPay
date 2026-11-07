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
          读取失败，请刷新重试。
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
          <p>连续查账失败 {failures} 次。</p>
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
                  <p>原始错误码：<code className="wrap-anywhere">{latest.error_code}</code></p>
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
            检查网络与支付宝配置，或查看
            <a
              data-external-link
              href="https://github.com/Mashiro0619/PerPay/blob/main/docs/maintenance.md#采集持续失败"
              target="_blank"
              rel="noopener noreferrer"
            >
              排查步骤
            </a>
            。
          </p>
        </div>
      </AlertDescription>
    </Alert>
  );
}
