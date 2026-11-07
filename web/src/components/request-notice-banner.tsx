import { useEffect, useState } from "react";
import { useIsFetching } from "@tanstack/react-query";
import { AlertCircle, WifiOff } from "lucide-react";
import { ApiError } from "@/api/client";
import { Link } from "@/navigation";
import { useRequestConnectionOnline, useRequestNotices, type RequestNotice, type RequestRetryRenderer } from "@/lib/request-notices";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Spinner } from "@/components/ui/spinner";

export function RequestNoticeBanner({ showRuntimeLink = true, renderRetry }: {
  showRuntimeLink?: boolean;
  renderRetry?: RequestRetryRenderer;
}) {
  const notices = useRequestNotices();
  const online = useRequestConnectionOnline();
  const unique = new Map<unknown, RequestNotice>();
  for (const notice of notices) {
    if (!notice.error) continue;
    const previous = unique.get(notice.error);
    if (!previous || (!previous.retry && notice.retry)) unique.set(notice.error, notice);
  }
  const failures = [...unique.values()];
  const fetching = useIsFetching({ predicate: query => unique.has(query.state.error) }) > 0;
  const paused = !online || notices.some(notice => notice.paused);
  const retained = notices.some(notice => notice.retainedData);
  const retryAt = Math.max(0, ...failures.map(notice => notice.retryAt));
  const [clock, setClock] = useState(Date.now);
  const remaining = Math.max(0, Math.ceil((retryAt - Math.max(clock, Date.now())) / 1000));
  useEffect(() => {
    if (retryAt <= Date.now()) return;
    let timer: number;
    const tick = () => {
      const now = Date.now();
      setClock(now);
      if (now < retryAt) timer = window.setTimeout(tick, Math.min(1000, retryAt - now));
    };
    timer = window.setTimeout(tick, Math.min(1000, retryAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [retryAt]);

  if (!notices.length) return null;
  const message = paused ? "等待网络恢复"
    : failures.length === 1 && failures[0]!.error instanceof Error ? failures[0]!.error.message
      : "服务暂时不可用，请稍后重试。";
  const detail = paused ? retained
    ? "当前显示上次成功读取的内容。网络恢复后会继续更新。"
    : "网络恢复后会继续读取。"
    : retained ? "更新未完成，以下保留上次成功读取的内容。" : null;
  const diagnostics = failures.filter(notice => notice.showDiagnostics && notice.error instanceof ApiError && notice.error.requestId);
  const retry = () => {
    if (paused || fetching || Date.now() < retryAt) return;
    // Preserve each read's original recovery, including the failed next-page cursor.
    // Shared query errors are the same object, so sibling consumers retry it once.
    for (const notice of failures) notice.retry?.();
  };
  const retryProps = {
    disabled: paused || fetching || remaining > 0,
    onClick: retry,
    children: <>{fetching && <Spinner data-icon="inline-start" aria-hidden="true" />}重试</>,
  };

  return <Alert variant={paused ? "default" : "destructive"}
    role={paused ? "status" : "alert"} aria-label="服务连接提示" data-request-notice>
    {paused ? <WifiOff aria-hidden="true" /> : <AlertCircle aria-hidden="true" />}
    <AlertDescription className="flex min-w-0 flex-wrap items-start justify-between gap-2">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div>{message}</div>
        {detail && <div>{detail}</div>}
        {remaining > 0 && !paused && <div aria-live="off">{remaining} 秒后可重试。</div>}
        {diagnostics.length > 0 && <Collapsible>
          <CollapsibleTrigger render={<Button variant="link" size="sm" />}>
            错误详情
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul className="flex min-w-0 flex-col gap-2 break-all">
              {diagnostics.map((notice, index) => <li key={index}>
                {failures.length > 1 && <div>{(notice.error as ApiError).message}</div>}
                <div>请求编号：{(notice.error as ApiError).requestId}</div>
              </li>)}
            </ul>
          </CollapsibleContent>
        </Collapsible>}
      </div>
      <div className="flex max-w-full flex-wrap items-center gap-2">
        {failures.some(notice => notice.retry) && (renderRetry
          ? renderRetry(retryProps)
          : <Button variant="outline" size="sm" {...retryProps} />)}
        {showRuntimeLink && <Link global to="/system" className={buttonVariants({ variant: "ghost", size: "sm" })}>运行状态</Link>}
      </div>
    </AlertDescription>
  </Alert>;
}
