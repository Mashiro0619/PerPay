import { useId, useRef, useState, type ReactNode } from "react";
import { refreshOperationalData } from "@/api/client";
import { useOperationKey } from "@/lib/idempotency";
import { operationReasonError, useFixedOperation } from "@/lib/fixed-operation";
import { ErrorNotice } from "@/components/request-state";
import { OperationRecoveryNotice } from "@/components/operation-recovery-notice";
import { OperationNavigationDialog } from "@/components/operation-navigation-dialog";
import { useOperationNavigation } from "@/drafts";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import {
  Field,
  FieldLabel,
  FieldGroup,
  FieldDescription,
  FieldError,
} from "@/components/ui/field";
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
  execute: (
    reason: string,
    operationId: string,
    signal?: AbortSignal,
  ) => Promise<unknown>;
  onClose: () => void;
  onSuccess: () => void;
  finalFocus?: (() => HTMLElement | null) | undefined;
}) {
  // The evidence being confirmed must not silently change under an open dialog.
  const [snapshot] = useState(() => ({
    title,
    description,
    action,
    children,
    execute,
  }));
  const [reason, setReason] = useState("");
  const [validation, setValidation] = useState<string | null>(null);
  const reasonField = useRef<HTMLTextAreaElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const hintId = useId();
  const operationKey = useOperationKey();
  const mutation = useFixedOperation({
    execute: (input: { reason: string; operationId: string }, signal) =>
      snapshot.execute(input.reason, input.operationId, signal),
    onSuccess,
  });
  const navigation = useOperationNavigation(
    mutation.isPending || !!mutation.recovery,
    () => mutation.isBusy() || !!mutation.recovery,
  );
  const needsRefresh = mutation.conflict || !!mutation.recovery;
  function close() {
    if (mutation.isBusy()) return;
    onClose();
    if (needsRefresh) void refreshOperationalData();
  }
  function submit() {
    if (mutation.isBusy() || mutation.conflict) return;
    if (mutation.recovery) {
      mutation.submit(mutation.recovery);
      return;
    }
    const error = operationReasonError(reason);
    setValidation(error);
    if (error) {
      reasonField.current?.focus();
      return;
    }
    mutation.submit({
      reason: reason.trim(),
      operationId: operationKey(reason.trim()),
    });
  }
  return (
    <Dialog
      open
      onOpenChange={(open, event) => {
        if (!open) {
          if (mutation.isBusy()) event.cancel();
          else close();
        }
      }}
    >
      <DialogContent
        ref={content}
        showCloseButton={!mutation.isPending}
        finalFocus={
          needsRefresh || navigation.blocked
            ? () =>
                document.getElementById("main-content") ??
                finalFocus?.() ??
                null
            : finalFocus
        }
        className="flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden"
      >
        <DialogHeader className="shrink-0 pr-8">
          <DialogTitle>{snapshot.title}</DialogTitle>
          <DialogDescription>{snapshot.description}</DialogDescription>
        </DialogHeader>
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <FieldGroup className="-mx-4 min-h-0 w-auto overflow-y-auto px-4 pb-1">
            {mutation.recovery && (
              <OperationRecoveryNotice
                operationId={mutation.recovery.operationId}
                conflict={mutation.conflict}
                error={mutation.error}
                focusOnError={!navigation.blocked}
              />
            )}
            {snapshot.children}
            <Field data-invalid={!!validation}>
              <FieldLabel htmlFor="operation-reason">操作理由</FieldLabel>
              <Textarea
                ref={reasonField}
                id="operation-reason"
                name="reason"
                required
                maxLength={500}
                rows={3}
                value={reason}
                disabled={mutation.isPending}
                readOnly={!!mutation.recovery}
                aria-invalid={!!validation}
                aria-describedby={
                  mutation.recovery || validation ? hintId : undefined
                }
                onChange={(event) => {
                  if (mutation.isBusy() || mutation.recovery) return;
                  setReason(event.target.value);
                  setValidation(null);
                  if (!mutation.conflict) mutation.reset();
                }}
              />
              {mutation.recovery ? (
                <FieldDescription id={hintId}>
                  已锁定原操作的理由与证据，重试不会更改请求。
                </FieldDescription>
              ) : (
                validation && <FieldError id={hintId}>{validation}</FieldError>
              )}
            </Field>
            {!mutation.recovery && <ErrorNotice error={mutation.error} />}
          </FieldGroup>
          <DialogFooter className="shrink-0 flex-row flex-wrap justify-end">
            <Button
              type="button"
              variant="outline"
              onClick={close}
              disabled={mutation.isPending}
            >
              {needsRefresh ? "关闭并刷新" : "取消"}
            </Button>
            {!mutation.conflict && (
              <Button
                type="submit"
                disabled={
                  mutation.isPending || (!mutation.recovery && !reason.trim())
                }
              >
                {mutation.isPending && (
                  <Spinner aria-hidden="true" data-icon="inline-start" />
                )}
                {mutation.recovery ? "重试原操作" : snapshot.action}
              </Button>
            )}
          </DialogFooter>
        </form>
        <OperationNavigationDialog
          navigation={navigation}
          operationId={mutation.submitted?.operationId}
          pending={mutation.isPending}
          finalFocus={() => content.current}
          onLeave={() => {
            mutation.stopWaiting();
            void refreshOperationalData();
            onClose();
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
