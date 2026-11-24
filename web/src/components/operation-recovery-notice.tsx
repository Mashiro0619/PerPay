import { useEffect, useId, useRef, type ReactNode } from "react";
import { AlertCircle } from "lucide-react";
import { CopyValue } from "@/components/copy-value";
import { ErrorNotice } from "@/components/request-state";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Field, FieldTitle } from "@/components/ui/field";

export function OperationRecoveryNotice({
  operationId,
  conflict,
  error,
  focusOnError = true,
  heading = "操作结果待确认",
  description,
}: {
  operationId: string;
  conflict: boolean;
  error: unknown;
  focusOnError?: boolean;
  heading?: string;
  description?: ReactNode;
}) {
  const title = useRef<HTMLDivElement>(null);
  const descriptionId = useId();
  useEffect(() => {
    // The user may be at the end of a long, scrolled form when this reply arrives.
    if (focusOnError && error != null) title.current?.focus();
  }, [error, focusOnError]);
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <Alert role="alert">
        <AlertCircle />
        <AlertTitle ref={title} tabIndex={-1} aria-describedby={descriptionId}>
          {heading}
        </AlertTitle>
        <AlertDescription id={descriptionId}>
          {description ?? (
            <>
              {conflict
                ? "服务器数据已发生变化，请离开页面或关闭窗口并刷新，核对刚才的操作是否已生效。"
                : "刚才的操作可能已生效。点击重试会沿用原请求：若已生效将直接返回结果，若未生效则会继续完成，不会重复执行。"}
              <p>
                离开页面或关闭窗口不会撤销已生效的操作；核对结果前请勿重复提交。
              </p>
            </>
          )}
        </AlertDescription>
      </Alert>
      <Field>
        <FieldTitle>操作编号</FieldTitle>
        <CopyValue tooltip value={operationId} label="复制操作编号" />
      </Field>
      {error != null && (
        <Collapsible>
          <CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>
            响应详情
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ErrorNotice error={error} />
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}
