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
}: {
  operationId: string;
  conflict: boolean;
  error: unknown;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <Alert>
        <AlertCircle />
        <AlertTitle>操作结果待确认</AlertTitle>
        <AlertDescription>
          {conflict
            ? "服务返回状态冲突。请关闭并刷新，核对原操作是否已经生效，再决定下一步。"
            : "未收到完整响应，操作可能已生效。重试将使用原对象、理由和操作编号，找回结果或完成这一次操作。"}
          <p>关闭不会撤销已执行的操作。请先核对结果，勿直接发起另一笔操作。</p>
        </AlertDescription>
      </Alert>
      <Field>
        <FieldTitle>操作编号</FieldTitle>
        <CopyValue value={operationId} label="复制操作编号" />
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
