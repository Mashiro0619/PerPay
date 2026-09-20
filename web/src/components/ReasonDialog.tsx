import { useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { ApiError, refreshOperationalData } from "@/api/client";
import { useOperationKey } from "@/lib/idempotency";
import { ErrorNotice } from "@/components/request-state";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { Field, FieldLabel, FieldGroup } from "@/components/ui/field";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
export function ReasonDialog({
  title,
  description,
  action,
  children,
  execute,
  onClose,
  onSuccess,
  finalFocus,
}: {
  title: string;
  description: string;
  action: string;
  children?: ReactNode;
  execute: (reason: string, operationId: string) => Promise<unknown>;
  onClose: () => void;
  onSuccess: () => void;
  finalFocus?: (() => HTMLElement | null) | undefined;
}) {
  const [reason, setReason] = useState("");
  const operationKey = useOperationKey();
  const mutation = useMutation({
    mutationFn: () => execute(reason.trim(), operationKey(reason.trim())),
    onSuccess,
  });
  // These commands use a captured snapshot; a conflict requires fresh evidence.
  const conflict =
    mutation.error instanceof ApiError && mutation.error.status === 409;
  function close() {
    if (mutation.isPending) return;
    onClose();
    if (conflict) void refreshOperationalData();
  }
  return (
    <Dialog
      open
      onOpenChange={(open, event) => {
        if (!open) {
          if (mutation.isPending) event.cancel();
          else close();
        }
      }}
    >
      <DialogContent
        showCloseButton={!mutation.isPending}
        finalFocus={
          conflict ? () => document.getElementById("main-content") : finalFocus
        }
        className="flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden"
      >
        <DialogHeader className="shrink-0">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            if (reason.trim() && !mutation.isPending && !conflict)
              mutation.mutate();
          }}
        >
          <FieldGroup className="-mx-4 min-h-0 w-auto overflow-y-auto px-4 pb-1">
            {children}
            <Field>
              <FieldLabel htmlFor="operation-reason">操作理由</FieldLabel>
              <Textarea
                id="operation-reason"
                name="reason"
                required
                maxLength={500}
                rows={3}
                value={reason}
                disabled={mutation.isPending}
                onChange={(event) => setReason(event.target.value)}
              />
            </Field>
            <ErrorNotice error={mutation.error} />
          </FieldGroup>
          <DialogFooter className="shrink-0">
            <Button
              type="button"
              variant="outline"
              onClick={close}
              disabled={mutation.isPending}
            >
              取消
            </Button>
            <Button
              type={conflict ? "button" : "submit"}
              onClick={conflict ? close : undefined}
              disabled={mutation.isPending || (!conflict && !reason.trim())}
            >
              {mutation.isPending && (
                <Spinner aria-hidden="true" data-icon="inline-start" />
              )}
              {conflict ? "关闭并刷新" : action}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
