import { useEffect, useRef, useState } from "react";
import { Download } from "lucide-react";
import {
  api,
  csvResult,
  type CheckoutStatus,
  type PaymentStatus,
} from "@/api/client";
import { createdDateRange } from "../../../src/shared/created-dates";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { ErrorNotice } from "@/components/request-state";
import type { useListQuery } from "@/lib/list-query";
import type { OrderSort } from "../../../src/shared/list-query";
export function OrderExport({
  query,
  payment,
  checkout,
}: {
  query: ReturnType<typeof useListQuery<OrderSort>>["apiQuery"];
  payment: PaymentStatus | undefined;
  checkout: CheckoutStatus | undefined;
}) {
  const active = useRef<AbortController | null>(null);
  const [pending, setPending] = useState(false),
    [error, setError] = useState<Error | null>(null);
  const scope = JSON.stringify([query, payment, checkout]);
  useEffect(() => {
    setError(null);
    setPending(false);
    return () => {
      active.current?.abort();
      active.current = null;
    };
  }, [scope]);
  async function download() {
    if (active.current) return;
    try {
      const range = createdDateRange(query.created_from, query.created_to);
      if (!range) throw new Error("请先选择创建日期范围，再导出全部匹配订单。");
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
            created_from: query.created_from!,
            created_to: query.created_to!,
            ...(payment ? { payment_status: payment } : {}),
            ...(checkout ? { checkout_status: checkout } : {}),
          },
        }),
      );
      if (active.current !== operation || operation.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download =
        "orders-" + query.created_from + "-" + query.created_to + ".csv";
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
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
      <Button
        className="ml-auto"
        variant="outline"
        disabled={pending}
        onClick={() => void download()}
      >
        {pending ? (
          <Spinner data-icon="inline-start" />
        ) : (
          <Download data-icon="inline-start" />
        )}
        导出 CSV
      </Button>
      {error && (
        <div className="w-full">
          <ErrorNotice error={error} />
        </div>
      )}
    </>
  );
}
