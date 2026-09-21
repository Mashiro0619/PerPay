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
} from "@/components/ui/alert-dialog";

export function OperationNavigationDialog({
  navigation,
  operationId,
  pending,
  onLeave,
  finalFocus,
  title = "操作结果尚未确认，仍要离开？",
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
                  ? "正在等待服务端响应。离开只会停止本页等待，操作仍可能完成。"
                  : "本次操作可能已生效。离开不会撤销操作，但会关闭本页的原操作重试入口。"}
                <p>
                  建议留在此页找回结果。若要离开，请先保留操作编号，稍后核查相关记录，勿直接发起另一笔操作。
                </p>
              </>
            )}
            {navigation.hasDrafts && (
              <p>此页面还有未保存的修改，离开后也不会保存。</p>
            )}
          </AlertDialogDescription>
          {operationId && (
            <Field>
              <FieldTitle>操作编号</FieldTitle>
              <CopyValue value={operationId} label="复制操作编号" />
            </Field>
          )}
        </div>
        <AlertDialogFooter className="shrink-0 flex-row flex-wrap justify-end">
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
