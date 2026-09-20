import { useEffect, useRef, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, Clock3, RefreshCw } from "lucide-react";
import { api, queryClient, result, type Order } from "@/api/client";
import { Link } from "@/navigation";
import { dateTime, money, safeCheckoutUrl } from "@/lib/format";
import { StatusBadge } from "@/components/business-status";
import { DetailFields } from "@/components/detail/DetailPrimitives";
import { RecordTools } from "@/components/detail/RecordTools";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  CardHeader,
  CardTitle,
  CardAction,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import { DialogFooter } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";

// Mount this observer inside the popup: closing it stops polling and aborts unfinished reads.
export function TestPaymentResult({
  created,
  onNew,
  onClose,
}: {
  created: Order;
  onNew: () => void;
  onClose?: () => void;
}) {
  const title = useRef<HTMLHeadingElement>(null);
  const current = useQuery({
    queryKey: ["order", created.order_id],
    queryFn: ({ signal }) =>
      result(
        api.getAdministratorOrder({
          path: { orderId: created.order_id },
          signal,
        }),
      ),
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
    refetchInterval: (query) =>
      query.state.error || query.state.data?.data.payment.status === "CONFIRMED"
        ? false
        : 5000,
    refetchIntervalInBackground: false,
  });
  const order = current.data?.data ?? created;
  // Cached details and the creation response are snapshots, not a successful read for this opening.
  const verified =
    current.isFetchedAfterMount &&
    !current.isError &&
    !current.isPaused &&
    !!current.data;
  const confirmed = verified && order.payment.status === "CONFIRMED";
  const disputed = verified && order.payment.status === "DISPUTED";
  const checkoutUrl = safeCheckoutUrl(created.checkout.checkout_url);
  const canPay =
    verified &&
    order.payment.status === "UNPAID" &&
    order.checkout.status === "OPEN" &&
    !!checkoutUrl;
  useEffect(() => {
    title.current?.focus();
  }, []);
  const observed = useRef(
    created.payment.status +
      "/" +
      created.checkout.status +
      "/" +
      created.received_amount_cents,
  );
  useEffect(() => {
    if (!current.data) return;
    const latest = current.data.data;
    const state =
      latest.payment.status +
      "/" +
      latest.checkout.status +
      "/" +
      latest.received_amount_cents;
    if (observed.current === state) return;
    observed.current = state;
    // Keep the page underneath the dialog current without invalidating this observer again.
    for (const scope of ["orders", "analytics", "work-items"])
      void queryClient.invalidateQueries({ queryKey: [scope] });
  }, [current.data]);

  const notice = !verified
    ? current.isError
      ? {
          title: "最新状态暂不可用",
          description: "已保留这笔订单。请刷新状态或查看订单，勿重复付款。",
        }
      : current.isPaused
        ? {
            title: "等待网络恢复",
            description: "当前无法确认最新付款状态。订单已保留，勿重复付款。",
          }
        : {
            title: "正在更新订单状态",
            description: "正在读取这笔订单的最新状态，不会重复创建订单。",
          }
    : confirmed
      ? {
          title: "收款已确认",
          description: "这笔订单已确认收款，无需再次付款。",
        }
      : disputed
        ? {
            title: "收款需要核查",
            description:
              "当前收款存在争议，请查看订单与收款依据，不要重复付款。",
          }
        : order.checkout.status !== "OPEN"
          ? {
              title:
                order.checkout.status === "EXPIRED"
                  ? "收银台已过期"
                  : "收银台已关闭",
              description:
                "请勿继续付款。如果已经付款，请等待状态更新或查看订单核查。",
            }
          : !checkoutUrl
            ? {
                title: "收银台地址不可用",
                description: "请查看订单核查，不要为找回付款入口重复创建订单。",
              }
            : {
                title: "等待付款确认",
                description:
                  "请按收银台金额付款。付款后会自动更新，勿重复付款。",
              };
  const NoticeIcon = confirmed
    ? CheckCircle2
    : disputed || current.isError
      ? AlertCircle
      : Clock3;
  const badges = verified && (
    <div className="flex flex-wrap items-center gap-2">
      <StatusBadge value={order.payment.status} />
      {!confirmed && order.checkout.status !== "OPEN" && (
        <StatusBadge value={order.checkout.status} />
      )}
    </div>
  );
  const fields: Array<[string, ReactNode]> = [
    ["测试金额", money(order.requested_amount_cents)],
    [
      "实际应付",
      <strong className="tabular-nums">
        {money(order.payable_amount_cents)}
      </strong>,
    ],
    ["商户订单号", order.merchant_order_no],
  ];
  if (order.received_amount_cents !== null)
    fields.push([
      verified ? "实收金额" : "上次实收金额",
      money(order.received_amount_cents),
    ]);
  const content = (
    <div className="flex min-w-0 flex-col gap-4">
      {onClose && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 ref={title} tabIndex={-1} className="font-medium">
            测试订单已创建
          </h3>
          {badges}
        </div>
      )}
      <Alert
        role="status"
        aria-live="polite"
        variant={disputed ? "destructive" : "default"}
      >
        <NoticeIcon />
        <AlertTitle>{notice.title}</AlertTitle>
        <AlertDescription>
          {current.isError && <p>{current.error.message}</p>}
          <p>{notice.description}</p>
        </AlertDescription>
      </Alert>
      <DetailFields items={fields} wide={["商户订单号"]} />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={current.isFetching}
          focusableWhenDisabled
          aria-busy={current.isFetching}
          onClick={() => {
            void current.refetch();
          }}
        >
          {current.isFetching ? (
            <Spinner aria-hidden="true" data-icon="inline-start" />
          ) : (
            <RefreshCw data-icon="inline-start" />
          )}
          刷新状态
        </Button>
        {canPay && (
          <Link
            className={buttonVariants({ variant: "outline", size: "sm" })}
            to={"/orders/" + created.order_id}
          >
            查看订单
          </Link>
        )}
        <Button variant="ghost" size="sm" onClick={onNew}>
          再创建一笔
        </Button>
      </div>
      {current.dataUpdatedAt > 0 && (
        <p className="text-xs text-muted-foreground">
          上次更新：{dateTime(new Date(current.dataUpdatedAt).toISOString())}
        </p>
      )}
      <RecordTools
        data={order}
        identifiers={[["订单编号", created.order_id]]}
      />
    </div>
  );
  const action =
    canPay && checkoutUrl ? (
      <a
        className={buttonVariants()}
        href={checkoutUrl}
        target="_blank"
        rel="noopener noreferrer"
      >
        打开收银台
      </a>
    ) : (
      <Link className={buttonVariants()} to={"/orders/" + created.order_id}>
        查看订单
      </Link>
    );
  return onClose ? (
    <>
      <div className="-mx-4 min-h-0 overflow-auto px-4 pb-1">{content}</div>
      <DialogFooter className="shrink-0 flex-row justify-end">
        <Button variant="outline" onClick={onClose}>
          关闭
        </Button>
        {action}
      </DialogFooter>
    </>
  ) : (
    <>
      <CardHeader>
        <CardTitle role="heading" aria-level={2} ref={title} tabIndex={-1}>
          测试订单已创建
        </CardTitle>
        {badges && <CardAction>{badges}</CardAction>}
      </CardHeader>
      <CardContent>{content}</CardContent>
      <CardFooter>{action}</CardFooter>
    </>
  );
}
