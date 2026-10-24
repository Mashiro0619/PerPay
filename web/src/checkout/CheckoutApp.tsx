import { checkoutHelpUrl } from "../../../src/shared/checkout-help";
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
import { Button, buttonVariants } from "../components/ui/button";
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
  const systemName = order?.display?.name ?? initial.systemName ?? "PerPay";
  const showProductName = order?.display?.show_product_name ?? initial.showProductName;
  const awaitingStartup = state.visual === "UNPAID" && !state.initialized;
  const canPay =
    state.initialized &&
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
  const download = useQrDownload(qrImage, canPay && !qrFailed, systemName);
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
      (order?.merchant_order_no ?? copy.heading) +
      " | " +
      systemName +
      " 收银台";
  }, [order?.merchant_order_no, copy.heading, systemName]);
  const cents =
    order?.payment_instructions?.payable_amount_cents ??
    order?.payment.received_amount_cents ??
    order?.requested_amount_cents ??
    0;
  const amountLabel = order?.payment_instructions
    ? "应付金额"
    : order && order.payment.status !== "UNPAID"
      ? "已收金额"
      : "下单金额";
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
  const returnUrl = [
    "CONFIRMED",
    "CLOSED",
    "EXPIRED",
    "DISPUTED",
    "UNAVAILABLE",
  ].includes(state.visual)
    ? merchantReturnUrl(order?.return_url)
    : null;
  const helpUrl = checkoutHelpUrl(order?.display ? order.display.help_url : initial.helpUrl);
  const retryAllowed =
    state.visual !== "NOT_FOUND" &&
    (!order ||
      ["UNPAID", "EXPIRED", "CLOSED", "UNAVAILABLE", "RATE_LIMITED"].includes(state.visual));
  const blocked = state.busy || state.unavailable || state.retryAt > Date.now();
  const desktopWidth =
    order &&
    (showProductName === false
      ? "lg:max-w-3xl lg:px-6"
      : "lg:max-w-5xl lg:px-6 xl:max-w-6xl");
  const reloadPath = initial.apiUrl.startsWith("/api/public/v1/checkouts/")
    ? "/checkout/" + initial.apiUrl.slice("/api/public/v1/checkouts/".length)
    : "";
  const paymentHeading = (
    <CardTitle className="w-full">
      <h1
        tabIndex={-1}
        ref={heading}
        className="flex items-center justify-center gap-2 text-xl font-semibold outline-none lg:text-2xl"
        data-status-heading
      >
        <AlipayLogo />
        {awaitingStartup || state.suspended ? "请暂勿付款" : copy.heading}
      </h1>
    </CardTitle>
  );
  const actions = (retryAllowed || returnUrl) && (
    <CardFooter
      className={cn(
        "flex flex-col items-stretch gap-3",
        order && "lg:col-start-3 lg:row-start-2 lg:self-start lg:px-6 lg:pb-8",
      )}
      data-checkout-actions
    >
      {returnUrl && (
        <a href={returnUrl} className={buttonVariants({ className: "w-full" })}>
          <CheckCircle2 data-icon="inline-start" />
          {state.visual === "CONFIRMED" ? "返回商家" : "返回商家处理"}
        </a>
      )}
      {retryAllowed &&
        (state.initialized ? (
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
        ) : (
          <a
            href={reloadPath}
            className={buttonVariants({
              variant: "outline",
              className: "w-full",
            })}
            data-checkout-reload
          >
            <RefreshCw data-icon="inline-start" />
            刷新页面
          </a>
        ))}
      {state.feedback && (
        <p
          className="text-center text-sm text-muted-foreground lg:text-left"
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
      className="grid h-svh min-h-min grid-cols-[minmax(0,1fr)] grid-rows-[1fr_auto_1fr]"
      data-checkout-page
    >
      <header
        className={cn(
          "mx-auto flex min-w-0 w-full max-w-lg items-center justify-between gap-4 self-start px-4 py-4 sm:py-6",
          desktopWidth,
        )}
      >
        <span className="flex min-w-0 items-center gap-2 font-semibold">
          <WalletCards className="size-5 shrink-0" />
          <span className="truncate" title={systemName}>
            {systemName}
          </span>
        </span>
        <ThemeControl />
      </header>
      <main
        className={cn(
          "mx-auto flex min-w-0 w-full max-w-lg flex-col gap-4 px-4 py-4 sm:py-8",
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
              "lg:relative lg:grid lg:grid-cols-[minmax(0,1.1fr)_auto_minmax(0,1fr)] lg:gap-0 lg:py-0",
          )}
          data-checkout-layout
          data-has-order={!!order}
        >
          <div
            className={cn(
              "flex min-w-0 flex-col gap-4",
              order && "lg:col-start-1 lg:row-start-1 lg:row-span-2 lg:gap-5 lg:py-8",
              order && !canPay && "lg:justify-center",
            )}
            data-checkout-payment
          >
            <CardHeader
              className={cn(
                "flex flex-col items-center gap-3 lg:px-8",
                canPay && "lg:contents",
              )}
            >
              <CardAction
                className={cn(
                  "self-end",
                  order && "lg:absolute lg:top-8 lg:right-6",
                )}
              >
                <Badge
                  variant={
                    state.visual === "CONFIRMED"
                      ? "success"
                      : ["DISPUTED", "NOT_FOUND"].includes(state.visual)
                        ? "destructive"
                        : "secondary"
                  }
                >
                  {awaitingStartup
                    ? "加载中"
                    : state.suspended
                      ? "等待状态确认"
                      : copy.badge}
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
              {(awaitingStartup || state.suspended || copy.detail) && (
                <CardDescription className="text-center">
                  {awaitingStartup
                    ? "请启用 JavaScript 或刷新页面后再付款。"
                    : state.suspended
                      ? "付款期限已到，请重新检查订单状态。"
                      : copy.detail}
                </CardDescription>
              )}
            </CardHeader>
            {order && (
              <CardContent className="flex min-w-0 flex-col gap-3 lg:px-8">
                {canPay && paymentHeading}
                <div
                  className="flex min-w-0 flex-wrap items-baseline justify-center gap-2 text-center"
                  data-checkout-amount
                >
                  <span
                    className="shrink-0 text-sm text-muted-foreground"
                    data-amount-label
                  >
                    {amountLabel}
                  </span>
                  <strong
                    className="min-w-0 text-2xl font-semibold tracking-tight whitespace-nowrap tabular-nums lg:text-3xl"
                    data-payable-amount
                  >
                    {checkoutMoney(cents)}
                  </strong>
                </div>
                {canPay && (
                  <>
                    <div className="flex justify-center">
                      <img
                        ref={qrImage}
                        src={qrSource}
                        width={256}
                        height={256}
                        className="h-auto w-60 max-w-full rounded-lg bg-white lg:w-72 xl:w-80"
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
                          <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden sm:max-w-md">
                            <DialogHeader className="shrink-0 pr-12">
                              <DialogTitle>支付宝付款二维码</DialogTitle>
                              <DialogDescription>
                                请按此金额付款，勿重复支付。
                              </DialogDescription>
                            </DialogHeader>
                            <div className="flex min-h-0 flex-col gap-4 overflow-y-auto" data-qr-dialog-body>
                              <p className="text-center text-2xl font-semibold tabular-nums">
                                {checkoutMoney(cents)}
                              </p>
                              <img
                                src={qrSource}
                                width={640}
                                height={640}
                                className="w-full shrink-0 rounded-lg bg-white"
                                alt="放大的支付宝付款二维码"
                                data-qr-dialog-image
                              />
                            </div>
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
          {actions}
          {order && (
            <>
              <div className="px-4 lg:hidden">
                <Separator />
              </div>
              <Separator orientation="vertical" className="hidden lg:col-start-2 lg:row-start-1 lg:row-span-2 lg:block" />
              <section
                aria-label="订单信息"
                className="flex min-w-0 flex-col gap-5 lg:col-start-3 lg:row-start-1 lg:self-end lg:px-6 lg:pt-8 lg:pb-4"
                data-checkout-summary
              >
                <CardHeader className="hidden lg:block lg:px-0 lg:pr-36">
                  <CardTitle>
                    <h2>订单信息</h2>
                  </CardTitle>
                </CardHeader>
                <CardContent className="flex min-w-0 flex-col gap-4 lg:px-0">
                  <dl className="flex min-w-0 flex-col gap-3 text-sm lg:gap-5">
                    {showProductName !== false && (
                      <div className="flex flex-col gap-1">
                        <dt className="text-muted-foreground">商品</dt>
                        <dd className="wrap-anywhere" data-product-name>
                          {order.product_name}
                        </dd>
                      </div>
                    )}
                    <div className="flex flex-col gap-1">
                      <dt className="text-muted-foreground">商家订单号</dt>
                      <dd className="min-w-0" data-merchant-order-no>
                        <CopyValue
                          value={order.merchant_order_no}
                          label="复制商家订单号"
                        />
                      </dd>
                    </div>
                  </dl>
                  {order.refund.status !== "NONE" && (
                    <Alert>
                      <AlertCircle />
                      <AlertTitle>
                        {order.refund.status === "FULL"
                          ? "历史退款记录：全额"
                          : "历史退款记录：部分"}
                      </AlertTitle>
                      <AlertDescription>
                        此为历史退款记录，具体金额请联系商家。
                      </AlertDescription>
                    </Alert>
                  )}
                  {canPay && (
                    <p
                      className="hidden text-sm leading-relaxed text-muted-foreground lg:block"
                      data-checkout-desktop-guide
                    >
                      用支付宝扫码，核对收款方并按准确金额付款。
                    </p>
                  )}
                </CardContent>
              </section>
            </>
          )}
        </Card>
        {helpUrl && (
          <p className="text-right text-sm text-muted-foreground" data-checkout-help>
            <a
              href={helpUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-sm hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
            >
              商家帮助
            </a>
          </p>
        )}
        <p className="sr-only" role="status" aria-live="polite">
          {awaitingStartup
            ? "页面加载中，请暂勿付款。"
            : state.suspended
              ? "付款期限已到，请暂勿付款。"
              : copy.heading}
        </p>
      </main>
    </div>
  );
}
