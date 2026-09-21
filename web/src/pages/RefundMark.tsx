import { useId, useRef, useState, type FormEvent } from "react";
import { ChevronDown } from "lucide-react";
import {
  api,
  refreshOperationalData,
  result,
  type AdminOrderDetail,
  type AdminRefundMarkRequest,
} from "@/api/client";
import { useOperationKey } from "@/lib/idempotency";
import { useFixedOperation } from "@/lib/fixed-operation";
import { isRefundMarkReceipt, refundMarkNoteError } from "@/lib/refund-mark";
import { useOperationNavigation } from "@/drafts";
import { OperationRecoveryNotice } from "@/components/operation-recovery-notice";
import { OperationNavigationDialog } from "@/components/operation-navigation-dialog";
import { dateTime, money } from "@/lib/format";
import { StatusBadge } from "@/components/business-status";
import { CopyValue } from "@/components/copy-value";
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
  FieldTitle,
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
  if (!eligible && !mark.marked && !hasHistory && !includeOrderTools && !draft)
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
                    <Item key={event.operation_id} role="listitem" size="sm">
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
                        <Field className="gap-1">
                          <FieldTitle>操作编号</FieldTitle>
                          <CopyValue
                            value={event.operation_id}
                            label="复制标记操作编号"
                          />
                        </Field>
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
            setMessage(
              draft.marked ? "本次退款标记已保存" : "本次撤销标记已保存",
            );
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
  const [context] = useState(() => ({ order, orderId, version, marked }));
  const [note, setNote] = useState("");
  const noteField = useRef<HTMLTextAreaElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const hintId = useId();
  const errorId = useId();
  const key = useOperationKey();
  const count = Array.from(note).length;
  const validation = refundMarkNoteError(note);
  const save = useFixedOperation({
    execute: async (
      command: { orderId: string; body: AdminRefundMarkRequest },
      signal,
    ) => {
      const response = await result(
        api.setAdministratorRefundMark({
          path: { orderId: command.orderId },
          body: command.body,
          signal,
        }),
      );
      if (!isRefundMarkReceipt(response, command.body)) {
        throw new Error(
          "标记响应不完整或与本次请求不一致，暂时无法确认保存结果。请重试原标记，或关闭并刷新订单核查。",
        );
      }
      return response;
    },
    onSuccess,
  });
  const navigation = useOperationNavigation(
    save.isPending || !!save.recovery,
    () => save.isBusy() || !!save.recovery,
  );
  const needsRefresh = save.conflict || !!save.recovery;
  function close() {
    if (save.isBusy()) return;
    onClose();
    if (needsRefresh) void refreshOperationalData();
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (save.isBusy() || save.conflict) return;
    if (save.recovery) {
      save.submit(save.recovery);
      return;
    }
    if (validation) {
      noteField.current?.focus();
      return;
    }
    const input = {
      version: context.version,
      marked: context.marked,
      ...(note.trim() ? { note: note.trim() } : {}),
    };
    save.submit({
      orderId: context.orderId,
      body: {
        ...input,
        operation_id: key({ orderId: context.orderId, ...input }),
      },
    });
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
        className="flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden"
      >
        <DialogHeader className="shrink-0 pr-8">
          <DialogTitle>
            {context.marked ? "标记已退款" : "撤销退款标记"}
          </DialogTitle>
          <DialogDescription>
            {disclaimer}
            {context.marked
              ? "不改变订单资金状态，也不会通知业务网站。"
              : "只撤销标记，不改变实际退款或订单资金。"}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="contents">
          <FieldGroup className="-mx-4 min-h-0 w-auto overflow-y-auto px-4 pb-1">
            {save.recovery && (
              <OperationRecoveryNotice
                heading="标记结果待确认"
                operationId={save.recovery.body.operation_id}
                conflict={save.conflict}
                error={save.error}
                focusOnError={!navigation.blocked}
                description={
                  <>
                    {save.conflict
                      ? "标记状态已变化。请关闭并刷新订单，核对标记历史中的本次操作编号，再决定是否修改。"
                      : "本次标记可能已保存。重试会沿用原订单、版本、备注和操作编号，找回本次保存结果，不会重复追加相同记录。"}
                    <p>
                      关闭不会撤销已保存的标记。这里只更新管理员记录，不执行实际退款。
                    </p>
                  </>
                }
              />
            )}
            {context.order && (
              <Item variant="outline">
                <ItemContent>
                  <ItemTitle className="line-clamp-none break-all">
                    {context.order.product_name}
                  </ItemTitle>
                  <ItemDescription>
                    实收 {money(context.order.received_amount_cents)}
                  </ItemDescription>
                  <ItemDescription className="break-all">
                    {context.order.merchant_order_no}
                  </ItemDescription>
                </ItemContent>
              </Item>
            )}
            <Field data-invalid={!!validation} data-disabled={save.isPending}>
              <FieldLabel htmlFor="refund-mark-note">备注（可选）</FieldLabel>
              <Textarea
                ref={noteField}
                id="refund-mark-note"
                name="refund-mark-note"
                rows={3}
                maxLength={1000}
                disabled={save.isPending}
                readOnly={!!save.recovery}
                value={note}
                onChange={(event) => {
                  if (save.isBusy() || save.recovery) return;
                  setNote(event.target.value);
                  if (!save.conflict) save.reset();
                }}
                aria-invalid={!!validation}
                aria-describedby={validation ? hintId + " " + errorId : hintId}
              />
              <FieldDescription id={hintId}>
                {count}/500 · 仅管理员可见
                {save.recovery && (
                  <span className="block">
                    原备注已锁定，重试不会更换订单、版本或内容。
                  </span>
                )}
              </FieldDescription>
              {validation && <FieldError id={errorId}>{validation}</FieldError>}
            </Field>
            {!save.recovery && <ErrorNotice error={save.error} />}
          </FieldGroup>
          <DialogFooter className="shrink-0 flex-row flex-wrap justify-end">
            <Button
              variant="outline"
              type="button"
              disabled={save.isPending}
              onClick={close}
            >
              {needsRefresh ? "关闭并刷新订单" : "取消"}
            </Button>
            {!save.conflict && (
              <Button
                type="submit"
                disabled={(!save.recovery && !!validation) || save.isPending}
              >
                {save.isPending && (
                  <Spinner aria-hidden="true" data-icon="inline-start" />
                )}
                {save.recovery
                  ? "重试原标记"
                  : context.marked
                    ? "确认标记已退款"
                    : "确认撤销标记"}
              </Button>
            )}
          </DialogFooter>
        </form>
        <OperationNavigationDialog
          navigation={navigation}
          operationId={save.submitted?.body.operation_id}
          pending={save.isPending}
          title="标记结果尚未确认，仍要离开？"
          description={
            <>
              <p>
                {save.isPending
                  ? "正在等待标记保存结果。离开只会停止本页等待，服务端仍可能保存。"
                  : "本次标记可能已保存。离开会关闭本页的原标记重试入口，不会撤销已保存的记录。"}
              </p>
              <p>
                退款标记不影响实际资金。建议留在此页找回保存结果；也可以保留操作编号，离开后在订单标记历史中核查。
              </p>
            </>
          }
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
