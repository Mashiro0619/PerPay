import { useWorkspace } from "@/workspace";
import { Link } from "@/navigation";
import { useWorkspaceApi } from "@/workspace";
import { useRef, useState } from "react";
import { refreshOperationalData, result, type PaymentMatchDetail } from "../../api/client";
import { FinancialDialog } from "../../pages/FinancialDialog";
import { ReasonDialog } from "../ReasonDialog";
import { useSuccessToast } from "../Feedback";
import { Button } from "@/components/ui/button";
import { money } from "../../lib/format";
import { DetailFields } from "./DetailPrimitives";
import { RecordTools } from "./RecordTools";
export function AssociateIncomeAction({
  orderId = "",
  ledgerId = "",
  orderLabel,
  ledgerLabel,
}: {
  orderId?: string;
  ledgerId?: string;
  orderLabel?: string;
  ledgerLabel?: string;
}) {
  const { clientId } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const setMessage = useSuccessToast();
  const finalFocus = useRef<HTMLElement | null>(null);
  if (clientId && !orderId) return <Link global to="/reconciliation">请从本站订单发起关联，或到「对账（全部网站）」处理。</Link>;
  return (
    <>
      <Button
        disabled={saved}
        onClick={(event) => {
          finalFocus.current = event.currentTarget;
          setOpen(true);
        }}
      >
        人工关联收款
      </Button>
      {open && (
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
      )}
    </>
  );
}
export function ReverseMatchAction({
  match,
  embedded = false,
  inline = false,
  includeOrderIdentifiers = false,
  movesOnSuccess = false,
}: {
  match: PaymentMatchDetail;
  embedded?: boolean;
  inline?: boolean;
  includeOrderIdentifiers?: boolean;
  /** The surrounding list moves a reversed record into its history section. */
  movesOnSuccess?: boolean;
}) {
  const api = useWorkspaceApi();
  const [snapshot, setSnapshot] = useState<PaymentMatchDetail | null>(null);
  const finalFocus = useRef<HTMLElement | null>(null);
  const [saved, setSaved] = useState(false);
  const setMessage = useSuccessToast();
  return (
    <>
      <RecordTools
        inline={inline}
        label="收款关联记录操作"
        data={match}
        identifiers={[
          ["关联编号", match.payment_match_id],
          ["流水编号", match.ledger_entry_id],
          ["可能匹配记录编号", match.candidate_id],
          ...(includeOrderIdentifiers ? [
            ["内部订单编号", match.order.order_id],
            ["客户端 ID", match.order.api_client_id],
          ] as const : []),
        ]}
        to={
          embedded
            ? "/reconciliation/matches/" + match.payment_match_id
            : undefined
        }
        actions={
          match.status === "SETTLED"
            ? [
                {
                  label: "撤销错误关联",
                  danger: true,
                  disabled: saved,
                  onSelect: (trigger) => {
                    finalFocus.current = trigger;
                    setSnapshot(match);
                  },
                },
              ]
            : []
        }
      />
      {snapshot && (
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
            if (embedded || movesOnSuccess)
              finalFocus.current = document.getElementById("main-content");
            setSnapshot(null);
            setSaved(true);
            setMessage("关联已撤销");
            void refreshOperationalData();
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
      )}
    </>
  );
}
