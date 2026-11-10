import { useRef, useState } from "react";
import { result, type AdminOrderDetail } from "@/api/client";
import { useWorkspaceApi } from "@/workspace";
import { useOperationKey } from "@/lib/idempotency";
import { useFixedOperation } from "@/lib/fixed-operation";
import { refreshFinancialRecords } from "@/lib/record-refresh";
import { dateTime } from "@/lib/format";
import { ErrorNotice } from "@/components/request-state";
import { useSuccessToast } from "@/components/Feedback";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { RefundMarkDialog } from "@/pages/RefundMark";
import { DetailSection } from "./DetailSections";
import { AssociateIncomeAction } from "./FinancialActions";

export function DisputedOrderActions({ order }: { order: AdminOrderDetail }) {
  const [refundOpen, setRefundOpen] = useState(false);
  const refundTrigger = useRef<HTMLButtonElement | null>(null);
  const message = useSuccessToast();
  const refunded = order.refund_mark.marked || order.refund.status !== "NONE";
  const unresolved = order.reconciliation.exceptions.filter(exception => exception.status === "OPEN" &&
    !exception.reminder_ignored && exception.exception_type === "RECONCILIATION_CONFLICT" && exception.details.reason === "settlement_reversed");
  const released = [...new Map(order.reconciliation.matches.filter(match => match.status === "REVERSED" &&
    ["UNALLOCATED", "CANDIDATE", "CONFLICT"].includes(match.ledger_entry.state)).map(match => [match.ledger_entry_id, match])).values()];
  return <DetailSection title="争议处理">
    {refunded ? <>
      <p className="text-sm">已登记退款。核对完成后可忽略本次争议提醒，处理记录保留在订单历史中。</p>
      {unresolved.map(exception => <IgnoreDisputeReminder key={exception.exception_id} exceptionId={exception.exception_id}
        createdAt={exception.created_at} />)}
    </> : <>
      <p className="text-sm">核对付款人、交易凭证和金额；确认属于本订单后重新关联收款。暂不能确认时保留争议，补齐凭证后继续。</p>
      <div className="flex flex-wrap items-center gap-2">
        <AssociateIncomeAction orderId={order.order_id} orderLabel={order.product_name} actionLabel="重新核对并确认收款" />
        <Button ref={refundTrigger} variant="outline" onClick={() => setRefundOpen(true)}>登记外部退款</Button>
      </div>
    </>}
    {!refunded && released.length > 0 && <div className="flex flex-col gap-2">
      <p className="text-sm text-muted-foreground">原流水属于其他订单时，选择正确订单继续处理：</p>
      {released.map(match => <AssociateIncomeAction key={match.payment_match_id} ledgerId={match.ledger_entry_id}
        ledgerLabel={match.ledger_entry.external_event_id} actionLabel="将原流水关联到正确订单" />)}
    </div>}
    {refundOpen && <RefundMarkDialog order={order} orderId={order.order_id} version={order.refund_mark.version} marked
      finalFocus={() => refundTrigger.current} onClose={() => setRefundOpen(false)} onSuccess={() => {
        setRefundOpen(false); message("外部退款已登记"); void refreshFinancialRecords();
      }} />}
  </DetailSection>;
}

function IgnoreDisputeReminder({ exceptionId, createdAt }: { exceptionId: string; createdAt: string }) {
  const api = useWorkspaceApi();
  const key = useOperationKey();
  const message = useSuccessToast();
  const [saved, setSaved] = useState(false);
  const save = useFixedOperation({
    execute: (body: { operation_id: string; type: "FINANCIAL_EXCEPTION"; resource_id: string }, signal) =>
      result(api.ignoreAllAdministratorWorkItems({ body, signal })),
    onSuccess: () => { setSaved(true); message("本条争议提醒已忽略"); void refreshFinancialRecords(); },
  });
  return <div className="flex flex-col gap-2">
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm text-muted-foreground">{dateTime(createdAt)} 的争议</span>
      <Button variant="outline" disabled={save.isPending || saved} onClick={() => {
        if (save.recovery) save.submit(save.recovery);
        else save.submit({ operation_id: key(exceptionId), type: "FINANCIAL_EXCEPTION", resource_id: exceptionId });
      }}>
        {save.isPending && <Spinner data-icon="inline-start" />}
        {saved ? "已忽略" : save.recovery ? "重试忽略此提醒" : "忽略此提醒"}
      </Button>
    </div>
    <ErrorNotice error={save.error} />
  </div>;
}
