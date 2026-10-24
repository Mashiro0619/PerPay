import { useRef, type ReactNode } from "react";
import { CopyValue } from "@/components/copy-value";
import { Field, FieldTitle } from "@/components/ui/field";
import { useOperationNavigation } from "@/drafts";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/admin-dialog";

export function OperationNavigationDialog({
  navigation,
  operationId,
  pending,
  onLeave,
  finalFocus,
  title = "结果未确认，仍要离开？",
  description,
}: {
  navigation: ReturnType<typeof useOperationNavigation>;
  operationId: string | undefined;
  pending: boolean;
  onLeave: () => void;
  finalFocus: () => HTMLElement | null;
  title?: string;
  description?: ReactNode;
}) {
  const stayButton = useRef<HTMLButtonElement>(null);
  return (
    <AlertDialog
      open={navigation.blocked}
      onOpenChange={(open) => {
        if (!open) navigation.stay();
      }}
    >
      <AlertDialogContent
        initialFocus={stayButton}
        finalFocus={finalFocus}
        className="flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] flex-col overflow-hidden"
      >
        <AlertDialogHeader className="shrink-0">
          <AlertDialogTitle>{title}</AlertDialogTitle>
        </AlertDialogHeader>
        <div className="-mx-4 flex min-h-0 flex-col gap-4 overflow-y-auto px-4 pb-1">
          <AlertDialogDescription
            render={<div />}
            className="flex flex-col gap-2"
          >
            {description ?? (
              <>
                {pending
                  ? "操作仍可能完成，离开仅停止本页等待。"
                  : "操作可能已生效，离开会关闭本页的重试入口。"}
                <p>
                  离开不会撤销操作。请保留操作编号，核查结果后再操作。
                </p>
              </>
            )}
            {navigation.hasDrafts && (
              <p>离开不会保存页面修改。</p>
            )}
          </AlertDialogDescription>
          {operationId && (
            <Field>
              <FieldTitle>操作编号</FieldTitle>
              <CopyValue tooltip value={operationId} label="复制操作编号" />
            </Field>
          )}
        </div>
        <AlertDialogFooter safeActionFirst className="shrink-0 flex-row flex-wrap justify-end">
          <AlertDialogCancel ref={stayButton} variant="default">
            留在此页
          </AlertDialogCancel>
          <AlertDialogAction
            variant="outline"
            onClick={() => navigation.proceed(onLeave)}
          >
            离开并稍后核查
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
