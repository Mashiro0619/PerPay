import type { ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { AlertCircle } from "lucide-react";
import { ApiError } from "@/api/client";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
}: {
  error: unknown;
  retry?: (() => void) | undefined;
}) {
  if (!error) return null;
  return (
    <Alert variant="destructive">
      <AlertCircle />
      <AlertDescription>
        <p>
          {error instanceof Error ? error.message : "请求失败，请稍后重试。"}
        </p>
        {error instanceof ApiError && (
          <>
            {error.retryAfter !== null && (
              <p>{error.retryAfter} 秒后可重试。</p>
            )}
            {error.requestId && (
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

export function QueryView<T>({
  query,
  children,
}: {
  query: UseQueryResult<T, Error>;
  children: (data: T) => ReactNode;
}) {
  if (query.isPending) return <Loading />;
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
      <ErrorNotice
        error={query.error}
        retry={() => {
          void query.refetch();
        }}
      />
      {children(query.data)}
    </>
  );
}
