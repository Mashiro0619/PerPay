import { useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
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
  return (
    <Dialog
      open
      onOpenChange={(open, event) => {
        if (!open) {
          if (mutation.isPending) event.cancel();
          else onClose();
        }
      }}
    >
      <DialogContent
        showCloseButton={!mutation.isPending}
        finalFocus={finalFocus}
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            if (reason.trim() && !mutation.isPending) mutation.mutate();
          }}
        >
          <FieldGroup>
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
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={mutation.isPending}
            >
              取消
            </Button>
            <Button
              type="submit"
              disabled={!reason.trim() || mutation.isPending}
            >
              {mutation.isPending && (
                <Spinner aria-hidden="true" data-icon="inline-start" />
              )}
              {action}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
