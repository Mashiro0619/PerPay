import { useRef, useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import {
  ApiError,
  api,
  refreshOperationalData,
  result,
  type AdminOrderDetail,
} from "@/api/client";
import { useOperationKey } from "@/lib/idempotency";
import { dateTime, money } from "@/lib/format";
import { StatusBadge } from "@/components/business-status";
import { ErrorNotice } from "@/components/request-state";
import { RecordTools } from "@/components/detail/RecordTools";
import { SuccessMessage, useFeedback } from "@/components/Feedback";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import {
  Field,
  FieldGroup,
  FieldLabel,
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
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import {
  Item,
  ItemContent,
  ItemTitle,
  ItemDescription,
  ItemGroup,
} from "@/components/ui/item";
const disclaimer = "仅记录外部已完成的退款。PerPay 不执行转账，也未验证退款。";
export function RefundMarkPanel({
  order,
  includeOrderTools = false,
}: {
  order: AdminOrderDetail;
  includeOrderTools?: boolean;
}) {
  const [draft, setDraft] = useState<{
    version: number;
    marked: boolean;
  } | null>(null);
  const [message, setMessage] = useFeedback();
  const finalFocus = useRef<HTMLButtonElement | null>(null);
  const mark = order.refund_mark;
  const eligible =
    ["CONFIRMED", "DISPUTED"].includes(order.payment.status) &&
    (order.received_amount_cents ?? 0) > 0;
  const hasHistory = order.refund_mark_history.length > 0;
  if (!eligible && !mark.marked && !hasHistory && !includeOrderTools)
    return null;
  return (
    <div className="flex flex-col gap-4">
      {(mark.marked || hasHistory) && (
        <section aria-label="管理员退款标记" className="flex flex-col gap-2">
          <Item variant="outline">
            <ItemContent>
              <ItemTitle>
                <StatusBadge
                  value={mark.marked ? "ADMIN_REFUND_MARK" : "NONE"}
                  label={mark.marked ? "已标记退款" : "标记已撤销"}
                />
              </ItemTitle>
              <ItemDescription>
                {mark.updated_by ?? "管理员"} · {dateTime(mark.updated_at)}
              </ItemDescription>
              {mark.note && (
                <p className="text-sm whitespace-pre-wrap break-words">
                  {mark.note}
                </p>
              )}
            </ItemContent>
          </Item>
          {hasHistory && (
            <Collapsible>
              <CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>
                <ChevronDown data-icon="inline-start" />
                标记历史
              </CollapsibleTrigger>
              <CollapsibleContent>
                <ItemGroup>
                  {order.refund_mark_history.map((event) => (
                    <Item key={event.operation_id} size="sm">
                      <ItemContent>
                        <ItemTitle>
                          {event.marked ? "标记已退款" : "撤销退款标记"}
                        </ItemTitle>
                        <ItemDescription>
                          {event.updated_by ?? "管理员"} ·{" "}
                          {dateTime(event.updated_at)}
                        </ItemDescription>
                        {event.note && (
                          <p className="text-sm whitespace-pre-wrap break-words">
                            {event.note}
                          </p>
                        )}
                      </ItemContent>
                    </Item>
                  ))}
                </ItemGroup>
              </CollapsibleContent>
            </Collapsible>
          )}
        </section>
      )}
      <SuccessMessage message={message} />
      <RecordTools
        label="订单操作"
        data={order}
        identifiers={[["内部订单编号", order.order_id]]}
        actions={
          mark.marked || eligible
            ? [
                {
                  label: mark.marked ? "撤销退款标记" : "标记已退款",
                  onSelect: (trigger) => {
                    finalFocus.current = trigger;
                    setDraft({ version: mark.version, marked: !mark.marked });
                  },
                },
              ]
            : []
        }
      />
      {draft && (
        <RefundMarkDialog
          order={order}
          orderId={order.order_id}
          version={draft.version}
          marked={draft.marked}
          finalFocus={() => finalFocus.current}
          onClose={() => setDraft(null)}
          onSuccess={() => {
            setMessage(draft.marked ? "退款标记已保存" : "退款标记已撤销");
            setDraft(null);
            void refreshOperationalData();
          }}
        />
      )}
    </div>
  );
}
export function RefundMarkDialog({
  order,
  orderId,
  version,
  marked,
  onClose,
  onSuccess,
  finalFocus,
}: {
  order?: AdminOrderDetail;
  orderId: string;
  version: number;
  marked: boolean;
  onClose: () => void;
  onSuccess: () => void;
  finalFocus?: (() => HTMLElement | null) | undefined;
}) {
  const [note, setNote] = useState("");
  const key = useOperationKey();
  const count = Array.from(note).length;
  const save = useMutation({
    mutationFn: () => {
      const input = {
        version,
        marked,
        ...(note.trim() ? { note: note.trim() } : {}),
      };
      return result(
        api.setAdministratorRefundMark({
          path: { orderId },
          body: { ...input, operation_id: key({ orderId, ...input }) },
        }),
      );
    },
    onSuccess,
  });
  const stale =
    save.error instanceof ApiError &&
    save.error.code === "refund_mark_version_conflict";
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (count <= 500 && !stale && !save.isPending) save.mutate();
  }
  return (
    <Dialog
      open
      onOpenChange={(open, event) => {
        if (!open) {
          if (save.isPending) event.cancel();
          else onClose();
        }
      }}
    >
      <DialogContent
        showCloseButton={!save.isPending}
        finalFocus={finalFocus}
        className="flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden"
      >
        <DialogHeader className="shrink-0">
          <DialogTitle>{marked ? "标记已退款" : "撤销退款标记"}</DialogTitle>
          <DialogDescription>
            {disclaimer}
            {marked
              ? "不改变订单资金状态，也不会通知业务网站。"
              : "只撤销标记，不改变实际退款或订单资金。"}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="contents">
          <FieldGroup className="-mx-4 min-h-0 w-auto overflow-y-auto px-4">
            {order && (
              <Item variant="outline">
                <ItemContent>
                  <ItemTitle className="break-all">
                    {order.product_name}
                  </ItemTitle>
                  <ItemDescription>
                    实收 {money(order.received_amount_cents)}
                  </ItemDescription>
                  <ItemDescription className="break-all">
                    {order.merchant_order_no}
                  </ItemDescription>
                </ItemContent>
              </Item>
            )}
            <Field data-invalid={count > 500}>
              <FieldLabel htmlFor="refund-mark-note">备注（可选）</FieldLabel>
              <Textarea
                id="refund-mark-note"
                name="refund-mark-note"
                rows={3}
                maxLength={1000}
                disabled={save.isPending}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                aria-invalid={count > 500}
                aria-describedby="refund-mark-note-hint"
              />
              <FieldDescription id="refund-mark-note-hint">
                {count}/500 · 仅管理员可见
              </FieldDescription>
              {count > 500 && <FieldError>备注最多 500 字。</FieldError>}
            </Field>
            <ErrorNotice error={save.error} />
          </FieldGroup>
          <DialogFooter className="shrink-0">
            <Button
              variant="outline"
              type="button"
              disabled={save.isPending}
              onClick={onClose}
            >
              取消
            </Button>
            {stale ? (
              <Button
                type="button"
                onClick={() => {
                  onClose();
                  void refreshOperationalData();
                }}
              >
                关闭并刷新订单
              </Button>
            ) : (
              <Button type="submit" disabled={count > 500 || save.isPending}>
                {save.isPending && (
                  <Spinner aria-hidden="true" data-icon="inline-start" />
                )}
                {marked ? "确认标记已退款" : "确认撤销标记"}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
