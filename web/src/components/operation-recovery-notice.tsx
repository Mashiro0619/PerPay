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
                ? "服务返回冲突，请关闭并刷新，核对原操作是否生效。"
                : "操作可能已生效。重试将沿用原请求，找回结果或完成原操作。"}
              <p>
                关闭不会撤销操作。核对前请勿发起新操作。
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
