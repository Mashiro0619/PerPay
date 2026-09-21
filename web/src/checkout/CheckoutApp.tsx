import { buttonVariants } from "@/components/ui/button";
import { cn } from "cn";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Download,
  Maximize,
  RefreshCw,
  WalletCards,
} from "lucide-react";
import { Button } from "../components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  CardAction,
} from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "../components/ui/dialog";
import { Separator } from "../components/ui/separator";
import { Spinner } from "../components/ui/spinner";
import { ThemeControl } from "../theme";
import { CopyValue } from "../components/copy-value";
import {
  checkoutCopy,
  checkoutMoney,
  merchantReturnUrl,
  type CheckoutInitial,
} from "../../../src/shared/checkout-view";
import { createCheckoutController } from "./controller";
import { useQrDownload } from "./use-qr-download";
import { AlipayLogo } from "./AlipayLogo";
export function CheckoutApp({ initial }: { initial: CheckoutInitial }) {
  const [controller] = useState(() => createCheckoutController(initial));
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getServerSnapshot,
  );
  const [expanded, setExpanded] = useState(false),
    [qrFailed, setQrFailed] = useState(false),
    [qrRetry, setQrRetry] = useState(0);
  const qrImage = useRef<HTMLImageElement>(null),
    heading = useRef<HTMLHeadingElement>(null),
    wasExpanded = useRef(false);
  useEffect(() => controller.start(), [controller]);
  const order = state.order,
    copy = checkoutCopy[state.visual];
  const canPay =
    state.visual === "UNPAID" &&
    !state.suspended &&
    !!order?.payment_instructions &&
    state.qrAvailable &&
    !!initial.qrUrl;
  const qrSource =
    initial.qrUrl +
    (qrRetry
      ? (initial.qrUrl.includes("?") ? "&" : "?") + "retry=" + qrRetry
      : "");
  const download = useQrDownload(qrImage, canPay && !qrFailed);
  useEffect(() => {
    if (!canPay) {
      setExpanded(false);
      setQrFailed(false);
      if (wasExpanded.current) heading.current?.focus();
    }
    wasExpanded.current = expanded;
  }, [canPay, expanded]);
  useEffect(() => {
    document.title =
      (order?.merchant_order_no ?? copy.heading) + " | PerPay 收银台";
  }, [order?.merchant_order_no, copy.heading]);
  const cents =
    order?.payment_instructions?.payable_amount_cents ??
    order?.payment.received_amount_cents ??
    order?.requested_amount_cents ??
    0;
  const amountLabel = order?.payment_instructions
    ? "应付金额"
    : order && order.payment.status !== "UNPAID"
      ? "已收金额"
      : "订单金额";
  const remaining = order
    ? Math.max(
        0,
        Math.ceil((Date.parse(order.checkout.expires_at) - state.now) / 1000),
      )
    : 0;
  const countdown =
    (remaining >= 3600
      ? String(Math.floor(remaining / 3600)).padStart(2, "0") + ":"
      : "") +
    String(Math.floor(remaining / 60) % 60).padStart(2, "0") +
    ":" +
    String(remaining % 60).padStart(2, "0");
  const returnUrl =
    state.visual === "CONFIRMED" ? merchantReturnUrl(order?.return_url) : null;
  const retryAllowed =
    state.visual !== "NOT_FOUND" &&
    (!order ||
      ["UNPAID", "UNAVAILABLE", "RATE_LIMITED"].includes(state.visual));
  const blocked = state.busy || state.unavailable || state.retryAt > Date.now();
  const desktopWidth =
    order &&
    (initial.showProductName === false
      ? "md:max-w-3xl md:px-6"
      : "md:max-w-4xl md:px-6");
  const paymentHeading = (
    <CardTitle className="w-full">
      <h1
        tabIndex={-1}
        ref={heading}
        className="flex items-center justify-center gap-2 text-xl font-semibold outline-none md:text-2xl"
        data-status-heading
      >
        <AlipayLogo />
        {state.suspended ? "请暂勿付款" : copy.heading}
      </h1>
    </CardTitle>
  );
  const actions = (retryAllowed || returnUrl) && (
    <CardFooter
      className={cn(
        "flex flex-col items-stretch gap-3",
        order && "md:contents",
      )}
      data-checkout-actions
    >
      {returnUrl && (
        <a
          href={returnUrl}
          className={buttonVariants({ className: "w-full" })}
        >
          <CheckCircle2 data-icon="inline-start" />
          返回商家
        </a>
      )}
      {retryAllowed && (
        <Button
          variant="outline"
          className="w-full"
          disabled={blocked}
          onClick={() => void controller.refresh(true)}
        >
          {state.busy ? (
            <Spinner aria-hidden="true" data-icon="inline-start" />
          ) : (
            <RefreshCw data-icon="inline-start" />
          )}
          {order ? "查询付款状态" : "重新获取订单"}
        </Button>
      )}
      {state.feedback && (
        <p
          className="text-center text-sm text-muted-foreground md:text-left"
          role="status"
        >
          {state.feedback}
        </p>
      )}
    </CardFooter>
  );
  // Balanced tracks center the content; intrinsic height keeps short screens scrollable.
  return (
    <div
      className="grid h-svh min-h-min grid-rows-[1fr_auto_1fr]"
      data-checkout-page
    >
      <header
        className={cn(
          "mx-auto flex w-full max-w-lg items-center justify-between gap-4 self-start px-4 py-4 sm:py-6",
          desktopWidth,
        )}
      >
        <span className="flex items-center gap-2 font-semibold">
          <WalletCards className="size-5" />
          PerPay
        </span>
        <ThemeControl />
      </header>
      <main
        className={cn(
          "mx-auto flex w-full max-w-lg flex-col gap-4 px-4 py-4 sm:py-8",
          desktopWidth,
        )}
        id="checkout-main"
        data-checkout-root
      >
        {state.message && (
          <Alert role="status">
            <AlertCircle />
            <AlertDescription>{state.message}</AlertDescription>
          </Alert>
        )}
        <Card
          className={cn(
            order &&
              "md:relative md:grid md:grid-cols-[minmax(0,1.1fr)_auto_minmax(0,1fr)] md:gap-0 md:py-0",
          )}
          data-checkout-layout
          data-has-order={!!order}
        >
          <div
            className={cn(
              "flex min-w-0 flex-col gap-4",
              order && "md:gap-5 md:py-8",
              order && !canPay && "md:justify-center",
            )}
            data-checkout-payment
          >
            <CardHeader
              className={cn(
                "flex flex-col items-center gap-3 md:px-8",
                canPay && "md:contents",
              )}
            >
              <CardAction
                className={cn(
                  "self-end",
                  order && "md:absolute md:top-8 md:right-6",
                )}
              >
                <Badge
                  variant={
                    state.visual === "CONFIRMED"
                      ? "outline"
                      : ["DISPUTED", "NOT_FOUND"].includes(state.visual)
                        ? "destructive"
                        : "secondary"
                  }
                >
                  {state.suspended ? "等待状态确认" : copy.badge}
                  {canPay && order && (
                    <>
                      <span aria-hidden="true">·</span>
                      <time
                        className="tabular-nums"
                        dateTime={order.checkout.expires_at}
                        role="timer"
                        aria-live="off"
                        data-countdown
                      >
                        <span className="sr-only">剩余 </span>
                        {countdown}
                      </time>
                    </>
                  )}
                </Badge>
              </CardAction>
              {!canPay && paymentHeading}
              {(state.suspended || copy.detail) && (
                <CardDescription className="text-center">
                  {state.suspended
                    ? "付款期限已到，请重新检查订单状态。"
                    : copy.detail}
                </CardDescription>
              )}
            </CardHeader>
            {order && (
              <CardContent className="flex min-w-0 flex-col gap-3 md:px-8">
                {canPay && (
                  <>
                    {paymentHeading}
                    <div className="flex justify-center">
                      <img
                        ref={qrImage}
                        src={qrSource}
                        width={256}
                        height={256}
                        className="h-auto max-w-full rounded-lg bg-white md:w-66"
                        alt="用于支付此订单的支付宝付款二维码"
                        data-qr-image
                        onLoad={() => setQrFailed(false)}
                        onError={() => {
                          setQrFailed(true);
                          setExpanded(false);
                        }}
                      />
                    </div>
                  </>
                )}
                <div
                  className="flex min-w-0 items-baseline justify-center gap-2 text-center"
                  data-checkout-amount
                >
                  <span
                    className="shrink-0 text-sm text-muted-foreground"
                    data-amount-label
                  >
                    {amountLabel}
                  </span>
                  <strong
                    className="min-w-0 text-2xl font-semibold tracking-tight whitespace-nowrap tabular-nums md:text-3xl"
                    data-payable-amount
                  >
                    {checkoutMoney(cents)}
                  </strong>
                </div>
                {canPay && (
                  <>
                    {qrFailed ? (
                      <Alert variant="destructive">
                        <AlertCircle />
                        <AlertTitle>二维码加载失败</AlertTitle>
                        <AlertDescription>
                          <Button
                            variant="outline"
                            onClick={() => {
                              setQrFailed(false);
                              setQrRetry(Date.now());
                            }}
                          >
                            重新加载二维码
                          </Button>
                        </AlertDescription>
                      </Alert>
                    ) : (
                      <div className="flex flex-wrap justify-center gap-2">
                        <Dialog open={expanded} onOpenChange={setExpanded}>
                          <DialogTrigger render={<Button variant="outline" />}>
                            <Maximize data-icon="inline-start" />
                            放大二维码
                          </DialogTrigger>
                          <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md">
                            <DialogHeader>
                              <DialogTitle>支付宝付款二维码</DialogTitle>
                              <DialogDescription>
                                请按此金额付款，勿重复支付。
                              </DialogDescription>
                            </DialogHeader>
                            <p className="text-center text-2xl font-semibold tabular-nums">
                              {checkoutMoney(cents)}
                            </p>
                            <img
                              src={qrSource}
                              width={640}
                              height={640}
                              className="w-full rounded-lg bg-white"
                              alt="放大的支付宝付款二维码"
                              data-qr-dialog-image
                            />
                          </DialogContent>
                        </Dialog>
                        <Button
                          variant="outline"
                          disabled={download.busy || state.unavailable}
                          onClick={download.save}
                        >
                          {download.busy ? (
                            <Spinner
                              aria-hidden="true"
                              data-icon="inline-start"
                            />
                          ) : (
                            <Download data-icon="inline-start" />
                          )}
                          保存二维码
                        </Button>
                      </div>
                    )}
                    {download.message && (
                      <p
                        className="text-sm text-muted-foreground"
                        role="status"
                      >
                        {download.message}
                      </p>
                    )}
                  </>
                )}
              </CardContent>
            )}
          </div>
          {order ? (
            <>
              <div className="px-4 md:hidden">
                <Separator />
              </div>
              <Separator orientation="vertical" className="hidden md:block" />
              <section
                aria-label="订单信息"
                className="flex min-w-0 flex-col gap-5 md:self-center md:px-6 md:py-8"
                data-checkout-summary
              >
                <CardHeader className="hidden md:block md:px-0 md:pr-36">
                  <CardTitle>
                    <h2>订单信息</h2>
                  </CardTitle>
                </CardHeader>
                <CardContent className="flex min-w-0 flex-col gap-4 md:px-0">
                  <dl className="flex min-w-0 flex-col gap-3 text-sm md:gap-5">
                    {initial.showProductName !== false && (
                      <div className="flex flex-col gap-1">
                        <dt className="text-muted-foreground">商品</dt>
                        <dd className="wrap-anywhere" data-product-name>
                          {order.product_name}
                        </dd>
                      </div>
                    )}
                    <div className="flex flex-col gap-1">
                      <dt className="text-muted-foreground">商户订单号</dt>
                      <dd className="min-w-0" data-merchant-order-no>
                        <CopyValue
                          value={order.merchant_order_no}
                          label="复制商户订单号"
                        />
                      </dd>
                    </div>
                  </dl>
                  {order.refund.status !== "NONE" && (
                    <Alert>
                      <AlertCircle />
                      <AlertTitle>
                        {order.refund.status === "FULL"
                          ? "款项已全额退款"
                          : "款项已部分退款"}
                      </AlertTitle>
                      <AlertDescription>
                        此为历史退款记录，具体金额请联系商家。
                      </AlertDescription>
                    </Alert>
                  )}
                  {canPay && (
                    <p
                      className="hidden text-sm leading-relaxed text-muted-foreground md:block"
                      data-checkout-desktop-guide
                    >
                      用支付宝扫描二维码，付款后可在此核对结果。请勿重复支付。
                    </p>
                  )}
                </CardContent>
                {actions}
              </section>
            </>
          ) : (
            actions
          )}
        </Card>
        <noscript>
          <p className="text-sm text-muted-foreground">
            付款后请刷新页面确认。
          </p>
        </noscript>
        <p className="sr-only" role="status" aria-live="polite">
          {state.suspended ? "付款期限已到，请暂勿付款。" : copy.heading}
        </p>
      </main>
    </div>
  );
}
