import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { AlertCircle } from "lucide-react";
import { ApiError, api, refreshOperationalData, result } from "@/api/client";
import { resourceIdPattern } from "@/lib/format";
import { useOperationKey } from "@/lib/idempotency";
import { ErrorNotice } from "@/components/request-state";
import { OrderFacts } from "@/components/detail/DetailPrimitives";
import { LedgerFacts } from "@/components/detail/PaymentEvidence";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
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
  const [orderId, setOrderId] = useState(initialOrderId);
  const [ledgerId, setLedgerId] = useState(initialLedgerId);
  const [reason, setReason] = useState("");
  const key = useOperationKey();
  const preview = useMutation({
    mutationFn: async () => {
      const [order, ledger] = await Promise.all([
        result(
          api.getAdministratorOrder({ path: { orderId: orderId.trim() } }),
        ),
        result(
          api.getReconciliationLedgerEntry({
            path: { ledgerEntryId: ledgerId.trim() },
          }),
        ),
      ]);
      return { order: order.data, ledger: ledger.data };
    },
  });
  const save = useMutation({
    mutationFn: async () => {
      if (!preview.data) throw new Error("请先读取并核对订单与流水证据。");
      const body = {
        order_id: preview.data.order.order_id,
        ledger_entry_id: preview.data.ledger.ledger_entry_id,
        reason: reason.trim(),
      };
      await result(
        api.createManualSettlement({
          body: { ...body, financial_operation_id: key(body) },
        }),
      );
    },
    onSuccess: () => {
      void refreshOperationalData();
      onSuccess();
    },
  });
  const automaticPreview = useRef(false);
  useEffect(() => {
    if (
      lockContext &&
      initialOrderId &&
      initialLedgerId &&
      !automaticPreview.current
    ) {
      automaticPreview.current = true;
      preview.mutate();
    }
  }, [lockContext, initialOrderId, initialLedgerId, preview.mutate]);
  const busy = preview.isPending || save.isPending;
  const stale =
    save.error instanceof ApiError &&
    save.error.code === "match_state_conflict";
  const directionValid = preview.data?.ledger.direction === "CREDIT";
  const stateValid =
    preview.data?.order.payment.status === "UNPAID" &&
    preview.data.order.payment.basis === "NONE" &&
    ["UNALLOCATED", "CANDIDATE", "CONFLICT"].includes(
      preview.data.ledger.state,
    );
  function resetPreview() {
    preview.reset();
    save.reset();
  }
  function recheckEvidence() {
    if (busy) return;
    save.reset();
    preview.mutate();
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || stale) return;
    if (!preview.data) {
      preview.mutate();
      return;
    }
    if (directionValid && stateValid && reason.trim()) save.mutate();
  }

  return (
    <Dialog
      open
      onOpenChange={(open, event) => {
        if (!open) {
          if (busy) event.cancel();
          else onClose();
        }
      }}
    >
      <DialogContent
        showCloseButton={!busy}
        finalFocus={finalFocus}
        className="flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden sm:max-w-xl"
      >
        <DialogHeader className="shrink-0">
          <DialogTitle>人工关联收款</DialogTitle>
          <DialogDescription>
            将这笔收入关联到订单并确认付款。
          </DialogDescription>
        </DialogHeader>
        <form className="contents" onSubmit={submit}>
          <FieldGroup className="-mx-4 min-h-0 w-auto overflow-y-auto px-4 pb-1">
            {lockContext && initialOrderId ? (
              !preview.data && (
                <p className="text-sm text-muted-foreground">
                  关联订单：{orderLabel ?? "当前订单"}
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
                  onChange={(event) => {
                    setOrderId(event.target.value);
                    resetPreview();
                  }}
                  placeholder="输入完整订单编号"
                />
              </Field>
            )}
            {lockContext && initialLedgerId ? (
              !preview.data && (
                <p className="text-sm text-muted-foreground">
                  收入流水：{ledgerLabel ?? "当前流水"}
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
                  onChange={(event) => {
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
                <Field>
                  <FieldLabel htmlFor="financial-reason">操作理由</FieldLabel>
                  <Textarea
                    id="financial-reason"
                    name="reason"
                    required
                    maxLength={500}
                    rows={3}
                    value={reason}
                    disabled={busy}
                    onChange={(event) => setReason(event.target.value)}
                  />
                </Field>
                <ErrorNotice error={save.error} />
              </>
            )}
          </FieldGroup>
          <DialogFooter className="shrink-0">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={busy}
            >
              取消
            </Button>
            <Button
              type={stale ? "button" : "submit"}
              onClick={stale ? recheckEvidence : undefined}
              disabled={
                busy ||
                (!stale &&
                  !!preview.data &&
                  (!directionValid || !stateValid || !reason.trim()))
              }
            >
              {busy && <Spinner aria-hidden="true" data-icon="inline-start" />}
              {stale
                ? "重新核对证据"
                : preview.data
                  ? "确认关联收款"
                  : "查看关联信息"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
