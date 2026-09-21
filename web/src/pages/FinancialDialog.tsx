import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useMutation } from "@tanstack/react-query";
import { AlertCircle } from "lucide-react";
import { ApiError, api, refreshOperationalData, result } from "@/api/client";
import { resourceIdPattern } from "@/lib/format";
import { useOperationKey } from "@/lib/idempotency";
import { operationReasonError, useFixedOperation } from "@/lib/fixed-operation";
import { OperationRecoveryNotice } from "@/components/operation-recovery-notice";
import { OperationNavigationDialog } from "@/components/operation-navigation-dialog";
import { useOperationNavigation } from "@/drafts";
import { ErrorNotice } from "@/components/request-state";
import { OrderFacts } from "@/components/detail/DetailPrimitives";
import { LedgerFacts } from "@/components/detail/PaymentEvidence";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
  FieldError,
} from "@/components/ui/field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
export function FinancialDialog({
  initialOrderId = "",
  initialLedgerId = "",
  lockContext = false,
  orderLabel,
  ledgerLabel,
  onClose,
  onSuccess,
  finalFocus,
}: {
  initialOrderId?: string;
  initialLedgerId?: string;
  lockContext?: boolean;
  orderLabel?: string | undefined;
  ledgerLabel?: string | undefined;
  onClose: () => void;
  onSuccess: () => void;
  finalFocus?: (() => HTMLElement | null) | undefined;
}) {
  const [context] = useState(() => ({
    initialOrderId,
    initialLedgerId,
    lockContext,
    orderLabel,
    ledgerLabel,
  }));
  const [orderId, setOrderId] = useState(initialOrderId);
  const [ledgerId, setLedgerId] = useState(initialLedgerId);
  const [reason, setReason] = useState("");
  const key = useOperationKey();
  const [validation, setValidation] = useState<string | null>(null);
  const reasonField = useRef<HTMLTextAreaElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const hintId = useId();
  const previewController = useRef<AbortController | null>(null);
  const recheckedConflict = useRef(false);
  const preview = useMutation({
    networkMode: "always",
    mutationFn: async (input: {
      orderId: string;
      ledgerId: string;
      signal: AbortSignal;
    }) => {
      const [order, ledger] = await Promise.all([
        result(
          api.getAdministratorOrder({
            path: { orderId: input.orderId },
            signal: input.signal,
          }),
        ),
        result(
          api.getReconciliationLedgerEntry({
            path: { ledgerEntryId: input.ledgerId },
            signal: input.signal,
          }),
        ),
      ]);
      return { order: order.data, ledger: ledger.data };
    },
  });
  const readEvidence = useCallback(
    (nextOrderId: string, nextLedgerId: string) => {
      previewController.current?.abort();
      const operation = new AbortController();
      previewController.current = operation;
      preview.mutate({
        orderId: nextOrderId.trim(),
        ledgerId: nextLedgerId.trim(),
        signal: operation.signal,
      });
    },
    [preview.mutate],
  );
  useEffect(() => {
    if (
      context.lockContext &&
      context.initialOrderId &&
      context.initialLedgerId
    )
      readEvidence(context.initialOrderId, context.initialLedgerId);
    return () => {
      previewController.current?.abort();
    };
  }, [context, readEvidence]);
  const save = useFixedOperation({
    execute: (
      body: {
        order_id: string;
        ledger_entry_id: string;
        reason: string;
        financial_operation_id: string;
      },
      signal,
    ) => result(api.createManualSettlement({ body, signal })),
    onSuccess: () => {
      void refreshOperationalData();
      onSuccess();
    },
  });
  const navigation = useOperationNavigation(
    save.isPending || !!save.recovery,
    () => save.isBusy() || !!save.recovery,
  );
  const busy = preview.isPending || save.isPending;
  const stale =
    !save.recovery &&
    save.error instanceof ApiError &&
    save.error.code === "match_state_conflict";
  const needsRefresh =
    save.conflict || !!save.recovery || recheckedConflict.current;
  const directionValid = preview.data?.ledger.direction === "CREDIT";
  const stateValid =
    preview.data?.order.payment.status === "UNPAID" &&
    preview.data.order.payment.basis === "NONE" &&
    ["UNALLOCATED", "CANDIDATE", "CONFLICT"].includes(
      preview.data.ledger.state,
    );
  function close() {
    if (save.isBusy()) return;
    previewController.current?.abort();
    onClose();
    if (needsRefresh) void refreshOperationalData();
  }
  function resetPreview() {
    if (save.conflict) recheckedConflict.current = true;
    if (!save.reset()) return;
    preview.reset();
  }
  function recheckEvidence() {
    if (busy || save.isBusy() || save.recovery) return;
    recheckedConflict.current = true;
    save.reset();
    readEvidence(orderId, ledgerId);
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || save.isBusy() || save.conflict) return;
    if (save.recovery) {
      save.submit(save.recovery);
      return;
    }
    if (!preview.data) {
      readEvidence(orderId, ledgerId);
      return;
    }
    const error = operationReasonError(reason);
    setValidation(error);
    if (error) {
      reasonField.current?.focus();
      return;
    }
    if (directionValid && stateValid) {
      const body = {
        order_id: preview.data.order.order_id,
        ledger_entry_id: preview.data.ledger.ledger_entry_id,
        reason: reason.trim(),
      };
      save.submit({ ...body, financial_operation_id: key(body) });
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open, event) => {
        if (!open) {
          if (save.isBusy()) event.cancel();
          else close();
        }
      }}
    >
      <DialogContent
        ref={content}
        showCloseButton={!save.isPending}
        finalFocus={
          needsRefresh || navigation.blocked
            ? () =>
                document.getElementById("main-content") ??
                finalFocus?.() ??
                null
            : finalFocus
        }
        className="flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden sm:max-w-xl"
      >
        <DialogHeader className="shrink-0 pr-8">
          <DialogTitle>人工关联收款</DialogTitle>
          <DialogDescription>
            将这笔收入关联到订单并确认付款。
          </DialogDescription>
        </DialogHeader>
        <form className="contents" onSubmit={submit}>
          <FieldGroup className="-mx-4 min-h-0 w-auto overflow-y-auto px-4 pb-1">
            {save.recovery && (
              <OperationRecoveryNotice
                operationId={save.recovery.financial_operation_id}
                conflict={save.conflict}
                error={save.error}
                focusOnError={!navigation.blocked}
              />
            )}
            {context.lockContext && context.initialOrderId ? (
              !preview.data && (
                <p className="text-sm text-muted-foreground">
                  关联订单：{context.orderLabel ?? "当前订单"}
                </p>
              )
            ) : (
              <Field>
                <FieldLabel htmlFor="financial-order-id">
                  内部订单编号
                </FieldLabel>
                <Input
                  id="financial-order-id"
                  name="order-id"
                  required
                  pattern={resourceIdPattern.source}
                  value={orderId}
                  disabled={busy}
                  readOnly={!!save.recovery}
                  onChange={(event) => {
                    if (busy || save.isBusy() || save.recovery) return;
                    setOrderId(event.target.value);
                    resetPreview();
                  }}
                  placeholder="输入完整订单编号"
                />
              </Field>
            )}
            {context.lockContext && context.initialLedgerId ? (
              !preview.data && (
                <p className="text-sm text-muted-foreground">
                  收入流水：{context.ledgerLabel ?? "当前流水"}
                </p>
              )
            ) : (
              <Field>
                <FieldLabel htmlFor="financial-ledger-id">
                  收入流水编号
                </FieldLabel>
                <Input
                  id="financial-ledger-id"
                  name="ledger-entry-id"
                  required
                  pattern={resourceIdPattern.source}
                  value={ledgerId}
                  disabled={busy}
                  readOnly={!!save.recovery}
                  onChange={(event) => {
                    if (busy || save.isBusy() || save.recovery) return;
                    setLedgerId(event.target.value);
                    resetPreview();
                  }}
                  placeholder="输入完整流水编号"
                />
              </Field>
            )}
            <ErrorNotice error={preview.error} />
            {preview.data && (
              <>
                <OrderFacts order={preview.data.order} linked={false} />
                <LedgerFacts entry={preview.data.ledger} />
                {!directionValid && (
                  <Alert variant="destructive">
                    <AlertCircle />
                    <AlertDescription>
                      只能关联收入流水，请更换流水编号。
                    </AlertDescription>
                  </Alert>
                )}
                {!stateValid && (
                  <Alert>
                    <AlertCircle />
                    <AlertDescription>
                      订单或流水状态已变化，请关闭后刷新。
                    </AlertDescription>
                  </Alert>
                )}
                {preview.data.order.payable_amount_cents !==
                  preview.data.ledger.amount_cents && (
                  <Alert>
                    <AlertCircle />
                    <AlertDescription>
                      金额与订单应付不同，请在理由中说明。
                    </AlertDescription>
                  </Alert>
                )}
                <Field data-invalid={!!validation}>
                  <FieldLabel htmlFor="financial-reason">操作理由</FieldLabel>
                  <Textarea
                    ref={reasonField}
                    id="financial-reason"
                    name="reason"
                    required
                    maxLength={500}
                    rows={3}
                    value={reason}
                    disabled={busy}
                    readOnly={!!save.recovery}
                    aria-invalid={!!validation}
                    aria-describedby={
                      save.recovery || validation ? hintId : undefined
                    }
                    onChange={(event) => {
                      if (busy || save.isBusy() || save.recovery) return;
                      setReason(event.target.value);
                      setValidation(null);
                      if (!save.conflict) save.reset();
                    }}
                  />
                  {save.recovery ? (
                    <FieldDescription id={hintId}>
                      原操作的理由、订单与流水已锁定，重试不会更换证据。
                    </FieldDescription>
                  ) : (
                    validation && (
                      <FieldError id={hintId}>{validation}</FieldError>
                    )
                  )}
                </Field>
                {!save.recovery && <ErrorNotice error={save.error} />}
              </>
            )}
          </FieldGroup>
          <DialogFooter className="shrink-0 flex-row flex-wrap justify-end">
            <Button
              type="button"
              variant="outline"
              onClick={close}
              disabled={save.isPending}
            >
              {needsRefresh ? "关闭并刷新" : "取消"}
            </Button>
            {(!save.conflict || stale) && (
              <Button
                type={stale ? "button" : "submit"}
                onClick={stale ? recheckEvidence : undefined}
                disabled={
                  busy ||
                  (!stale &&
                    !save.recovery &&
                    !!preview.data &&
                    (!directionValid || !stateValid || !reason.trim()))
                }
              >
                {busy && (
                  <Spinner aria-hidden="true" data-icon="inline-start" />
                )}
                {stale
                  ? "重新核对证据"
                  : save.recovery
                    ? "重试原操作"
                    : preview.data
                      ? "确认关联收款"
                      : "查看关联信息"}
              </Button>
            )}
          </DialogFooter>
        </form>
        <OperationNavigationDialog
          navigation={navigation}
          operationId={save.submitted?.financial_operation_id}
          pending={save.isPending}
          finalFocus={() => content.current}
          onLeave={() => {
            save.stopWaiting();
            void refreshOperationalData();
            onClose();
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
