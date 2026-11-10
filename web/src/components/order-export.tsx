import { useWorkspaceApi } from "@/workspace";
import { useEffect, useId, useRef, useState } from "react";
import { Download } from "lucide-react";
import { csvResult, type CheckoutStatus, type PaymentStatus } from "@/api/client";
import { beijingDate, createdDateRange } from "../../../src/shared/created-dates";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { ErrorNotice } from "@/components/request-state";
import { ListActionsMenu } from "@/components/list-actions-menu";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import type { useListQuery } from "@/lib/list-query";
import type { OrderSort } from "../../../src/shared/list-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogBody, DialogFooter } from "@/components/admin-dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { label } from "@/lib/labels";
export function OrderExport({
  query,
  payment,
  checkout,
  clientId = null,
  accountId,
  accountName,
  menu = false,
}: {
  query: ReturnType<typeof useListQuery<OrderSort>>["apiQuery"];
  payment: PaymentStatus | undefined;
  checkout: CheckoutStatus | undefined;
  clientId?: string | null;
  accountId?: string | undefined;
  accountName?: string | undefined;
  menu?: boolean;
}) {
  const api = useWorkspaceApi();
  const id = useId();
  const active = useRef<AbortController | null>(null);
  const finalFocus = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [pending, setPending] = useState(false),
    [error, setError] = useState<Error | null>(null);
  const scope = JSON.stringify([query, payment, checkout, clientId, accountId]);
  useEffect(() => {
    setError(null);
    setPending(false);
    setOpen(false);
    return () => {
      active.current?.abort();
      active.current = null;
    };
  }, [scope]);
  function showExport() {
    finalFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setFrom(query.created_from ?? beijingDate());
    setTo(query.created_to ?? beijingDate());
    setError(null);
    setOpen(true);
  }
  function closeExport() {
    active.current?.abort();
    active.current = null;
    setPending(false);
    setOpen(false);
  }
  async function download() {
    if (active.current) return;
    try {
      const range = createdDateRange(from, to);
      if (!range) throw new Error("请选择开始和结束日期。");
      if (range.days > 366)
        throw new Error("导出创建日期跨度最多 366 天，请缩小范围。");
    } catch (error) {
      setError(error as Error);
      return;
    }
    const operation = new AbortController();
    active.current = operation;
    setPending(true);
    setError(null);
    try {
      const blob = await csvResult(
        api.exportAdministratorOrders({
          signal: operation.signal,
          parseAs: "text",
          headers: { Origin: window.location.origin },
          body: {
            ...query,
            ...(clientId ? { api_client_id: clientId } : {}),
            created_from: from,
            created_to: to,
            ...(payment ? { payment_status: payment } : {}),
            ...(checkout ? { checkout_status: checkout } : {}),
            ...(accountId ? { alipay_account_id: accountId } : {}),
          },
        }),
      );
      if (active.current !== operation || operation.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download =
        "orders-" + from + "-" + to + ".csv";
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setOpen(false);
    } catch (error) {
      if (active.current === operation && !operation.signal.aborted)
        setError(
          error instanceof Error ? error : new Error("导出失败，请重试。"),
        );
    } finally {
      if (active.current === operation) {
        active.current = null;
        setPending(false);
      }
    }
  }
  return (
    <>
      {menu ? <ListActionsMenu label="更多订单操作">
        {() => <DropdownMenuItem disabled={pending} onClick={showExport}>
          {pending ? <Spinner /> : <Download />}
          导出 CSV
        </DropdownMenuItem>}
      </ListActionsMenu> : <Button
        className="ml-auto"
        variant="outline"
        disabled={pending}
        onClick={showExport}
      >
        {pending ? (
          <Spinner data-icon="inline-start" />
        ) : (
          <Download data-icon="inline-start" />
        )}
        导出 CSV
      </Button>}
      <Dialog open={open} onOpenChange={next => { if (!next) closeExport(); }}>
        <DialogContent finalFocus={() => finalFocus.current?.isConnected ? finalFocus.current : document.querySelector<HTMLElement>('[aria-label="更多订单操作"]')}>
          <DialogHeader><DialogTitle>导出订单</DialogTitle></DialogHeader>
          <form className="contents" onSubmit={event => { event.preventDefault(); void download(); }}>
            <DialogBody>
              <DialogDescription>按订单创建日期导出，使用北京时间，包含起止日期；金额单位为元。</DialogDescription>
              <p className="text-sm">{[
                clientId ? "当前网站" : "全部网站",
                query.q ? "关键词：“" + query.q + "”" : "",
                payment ? "付款：" + (payment === "UNPAID" ? "未付款" : label(payment)) : "",
                checkout ? "收银台：" + label(checkout) : "",
                accountId ? "收款账号：" + (accountName ?? accountId) : "",
              ].filter(Boolean).join(" · ")}</p>
              <FieldGroup>
                <Field><FieldLabel htmlFor={id + "-from"}>开始日期</FieldLabel><Input id={id + "-from"} type="date" required min="1970-01-01" value={from} disabled={pending} onChange={event => { setFrom(event.target.value); setError(null); }} /></Field>
                <Field><FieldLabel htmlFor={id + "-to"}>结束日期</FieldLabel><Input id={id + "-to"} type="date" required min={from || "1970-01-01"} value={to} disabled={pending} onChange={event => { setTo(event.target.value); setError(null); }} /></Field>
              </FieldGroup>
              <ErrorNotice error={error} />
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={closeExport}>取消</Button>
              <Button type="submit" disabled={pending}>{pending && <Spinner data-icon="inline-start" />}{pending ? "正在导出…" : "下载 CSV"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
