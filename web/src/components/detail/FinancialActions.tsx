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
import { DetailFields } from "./DetailPrimitives";
import { RecordTools, type RecordAction } from "./RecordTools";
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
/** The reversal dialog and the action that opens it; there is no action once a match is reversed. */
export function useReverseMatch(match: PaymentMatchDetail, movesOnSuccess = false) {
  const api = useWorkspaceApi();
  const [snapshot, setSnapshot] = useState<PaymentMatchDetail | null>(null);
  const finalFocus = useRef<HTMLElement | null>(null);
  const [saved, setSaved] = useState(false);
  const setMessage = useSuccessToast();
  const action: RecordAction | null = match.status === "SETTLED"
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
      <DetailFields
        items={[
          ["商品", snapshot.order.product_name],
          ["商户订单号", snapshot.order.merchant_order_no],
          ["支付宝交易金额", money(snapshot.ledger_entry.amount_cents)],
          ["支付宝订单号", snapshot.ledger_entry.provider_order_no],
        ]}
      />
    </ReasonDialog>
  );
  return { action, dialog };
}
export function ReverseMatchAction({
  match,
  embedded = false,
  inline = false,
  technical = true,
  includeOrderIdentifiers = false,
  movesOnSuccess = false,
}: {
  match: PaymentMatchDetail;
  embedded?: boolean;
  inline?: boolean;
  technical?: boolean;
  includeOrderIdentifiers?: boolean;
  /** The surrounding list moves a reversed record into its history section. */
  movesOnSuccess?: boolean;
}) {
  const { action, dialog } = useReverseMatch(match, embedded || movesOnSuccess);
  return (
    <>
      <RecordTools
        inline={inline}
        technical={technical}
        label="收款关联记录操作"
        data={match}
        identifiers={[
          ["关联编号", match.payment_match_id],
          ["流水编号", match.ledger_entry_id],
          ["可能匹配记录编号", match.candidate_id],
          ...(includeOrderIdentifiers ? [
            ["内部订单编号", match.order.order_id],
            ["网站编号", match.order.api_client_id],
          ] as const : []),
        ]}
        to={
          embedded
            ? "/reconciliation/matches/" + match.payment_match_id
            : undefined
        }
        actions={action ? [action] : []}
      />
      {dialog}
    </>
  );
}
