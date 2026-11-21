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
      <Alert>
        <AlertCircle />
        <AlertTitle ref={title} tabIndex={-1} aria-describedby={descriptionId}>
          {heading}
        </AlertTitle>
        <AlertDescription id={descriptionId}>
          {description ?? (
            <>
              {conflict
                ? "服务器数据已发生变化，请关闭窗口并刷新页面，核对刚才的操作是否已生效。"
                : "刚才的操作可能已生效。点击重试会安全核对原操作结果，不会重复提交。"}
              <p>
                关闭窗口不会撤销已生效的操作；核对结果前请勿重复提交。
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
