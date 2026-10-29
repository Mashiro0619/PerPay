import { Link } from "@/navigation";
import type { ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { AlertCircle, WifiOff } from "lucide-react";
import { ApiError } from "@/api/client";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Skeleton } from "@/components/ui/skeleton";

export function ErrorNotice({
  error,
  retry,
  showDiagnostics = true,
  retainedData = false,
}: {
  error: unknown;
  retry?: (() => void) | undefined;
  showDiagnostics?: boolean;
  retainedData?: boolean;
}) {
  if (!error) return null;
  return (
    <Alert variant="destructive">
      <AlertCircle />
      <AlertDescription>
        <p>
          {error instanceof Error ? error.message : "请求失败，请稍后重试。"}
        </p>
        {retainedData && <p>更新未完成，以下保留上次成功读取的内容。</p>}
        {error instanceof ApiError && error.code === "site_scope_conflict" && <Link global to="/reconciliation">前往对账（全部网站）</Link>}
        {error instanceof ApiError && (
          <>
            {error.retryAfter !== null && (
              <p>{error.retryAfter} 秒后可重试。</p>
            )}
            {showDiagnostics && error.requestId && (
              <Collapsible>
                <CollapsibleTrigger
                  render={<Button variant="link" size="sm" />}
                >
                  错误详情
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <p className="break-all">请求编号：{error.requestId}</p>
                </CollapsibleContent>
              </Collapsible>
            )}
          </>
        )}
        {retry && (
          <Button variant="outline" size="sm" onClick={retry}>
            重试
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}

export function Loading({ label = "正在读取…" }: { label?: string }) {
  return (
    <div className="flex flex-col gap-3" role="status">
      <span className="sr-only">{label}</span>
      <Skeleton className="h-8 w-2/3" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}

export function ReadPausedNotice({ retainedData = false }: { retainedData?: boolean }) {
  return <Alert role="status" data-read-paused>
    <WifiOff aria-hidden="true" />
    <AlertTitle>等待网络恢复</AlertTitle>
    <AlertDescription>
      {retainedData ? "当前显示上次成功读取的内容。网络恢复后会继续更新。" : "网络恢复后会继续读取。"}
    </AlertDescription>
  </Alert>;
}

export function QueryView<T>({
  query,
  children,
  loading,
}: {
  query: UseQueryResult<T, Error>;
  children: (data: T) => ReactNode;
  loading?: ReactNode;
}) {
  if (query.isPending) return query.isPaused ? <ReadPausedNotice /> : (loading ?? <Loading />);
  if (query.data === undefined)
    return (
      <ErrorNotice
        error={query.error}
        retry={() => {
          void query.refetch();
        }}
      />
    );
  return (
    <>
      {query.isPaused ? <ReadPausedNotice retainedData /> : <ErrorNotice
        error={query.error}
        retainedData
        retry={() => {
          void query.refetch();
        }}
      />}
      {children(query.data)}
    </>
  );
}
