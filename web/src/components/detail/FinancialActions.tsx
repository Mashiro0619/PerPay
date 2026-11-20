import { useWorkspace } from "@/workspace";
import { Link } from "@/navigation";
import { useWorkspaceApi } from "@/workspace";
import { useRef, useState } from "react";
import { result, type PaymentMatchDetail } from "../../api/client";
import { refreshFinancialRecords } from "@/lib/record-refresh";
import { FinancialDialog } from "../../pages/FinancialDialog";
import { ReasonDialog } from "../ReasonDialog";
import { useSuccessToast } from "../Feedback";
import { Button } from "@/components/ui/button";
import { money } from "../../lib/format";
import { FieldList } from "@/components/record/FieldList";
import type { RecordAction } from "@/components/record/ActionMenu";
type AssociateIncomeOptions = {
  orderId?: string;
  ledgerId?: string;
  orderLabel?: string | undefined;
  ledgerLabel?: string | undefined;
  actionLabel?: string;
};
/** The association dialog and the action that opens it, for callers that place the action themselves. */
export function useAssociateIncome({
  orderId = "",
  ledgerId = "",
  orderLabel,
  ledgerLabel,
  actionLabel = "人工关联收款",
}: AssociateIncomeOptions) {
  const { clientId } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const setMessage = useSuccessToast();
  const finalFocus = useRef<HTMLElement | null>(null);
  // A site workspace cannot choose the order for a bare ledger entry.
  const action: RecordAction = clientId && !orderId ? {
    label: "到全部网站处理" + (ledgerId ? "这笔流水" : "收款关联"),
    to: ledgerId ? "/reconciliation/transactions/" + encodeURIComponent(ledgerId) : "/reconciliation",
    global: true,
  } : {
    label: actionLabel,
    disabled: saved,
    onSelect: (trigger) => {
      finalFocus.current = trigger;
      setOpen(true);
    },
  };
  const dialog = open && (
    <FinancialDialog
      initialOrderId={orderId}
      initialLedgerId={ledgerId}
      lockContext
      finalFocus={() => finalFocus.current}
      orderLabel={orderLabel}
      ledgerLabel={ledgerLabel}
      onClose={() => setOpen(false)}
      onSuccess={() => {
        // The completed action can disappear when the parent reloads its evidence.
        finalFocus.current = document.getElementById("main-content");
        setOpen(false);
        setSaved(true);
        setMessage("关联已保存");
      }}
    />
  );
  return { action, dialog };
}
export function AssociateIncomeAction(props: AssociateIncomeOptions) {
  const { action, dialog } = useAssociateIncome(props);
  if (action.to) return <Link global to={action.to}>{action.label}</Link>;
  return (
    <>
      <Button
        className="h-auto min-h-8 min-w-0 max-w-full whitespace-normal py-1.5"
        disabled={action.disabled}
        onClick={(event) => action.onSelect?.(event.currentTarget)}
      >
        {action.label}
      </Button>
      {dialog}
    </>
  );
}
/**
 * The reversal dialog and the action that opens it. There is no action once a
 * match is reversed, nor while its detail is still being read.
 */
export function useReverseMatch(match: PaymentMatchDetail | undefined, movesOnSuccess = false) {
  const api = useWorkspaceApi();
  const [snapshot, setSnapshot] = useState<PaymentMatchDetail | null>(null);
  const finalFocus = useRef<HTMLElement | null>(null);
  const [saved, setSaved] = useState(false);
  const setMessage = useSuccessToast();
  const action: RecordAction | null = match?.status === "SETTLED"
    ? {
        label: "撤销错误关联",
        danger: true,
        disabled: saved,
        onSelect: (trigger) => {
          finalFocus.current = trigger;
          setSnapshot(match);
        },
      }
    : null;
  const dialog = snapshot && (
    <ReasonDialog
      finalFocus={() => finalFocus.current}
      title="撤销收款关联？"
      intent="destructive"
      description="订单将进入争议状态。仅撤销账务关联，不会转出资金。"
      action="确认撤销关联"
      onClose={() => setSnapshot(null)}
      execute={(reason, operationId, signal) =>
        result(
          api.reversePaymentSettlement({
            signal,
            path: { paymentMatchId: snapshot.payment_match_id },
            body: { reason, financial_operation_id: operationId },
          }),
        )
      }
      onSuccess={() => {
        // Embedded matches can move into history after reversal.
        if (movesOnSuccess)
          finalFocus.current = document.getElementById("main-content");
        setSnapshot(null);
        setSaved(true);
        setMessage("关联已撤销");
        void refreshFinancialRecords();
      }}
    >
      <FieldList
        items={[
          { label: "商品", value: snapshot.order.product_name },
          { label: "商户订单号", kind: "id", value: snapshot.order.merchant_order_no },
          { label: "支付宝交易金额", kind: "money", value: money(snapshot.ledger_entry.amount_cents) },
          { label: "支付宝订单号", kind: "id", value: snapshot.ledger_entry.provider_order_no },
        ]}
      />
    </ReasonDialog>
  );
  return { action, dialog };
}
