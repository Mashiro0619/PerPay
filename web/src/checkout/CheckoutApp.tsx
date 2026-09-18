import { buttonVariants } from "@/components/ui/button";
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
    ? "应付金额（请勿修改）"
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
  return (
    <div className="flex min-h-svh flex-col">
      <header className="mx-auto flex w-full max-w-lg items-center justify-between gap-4 px-4 py-4 sm:py-6">
        <span className="flex items-center gap-2 font-semibold">
          <WalletCards className="size-5" />
          PerPay
        </span>
        <ThemeControl />
      </header>
      <main
        className="mx-auto flex w-full max-w-lg flex-1 flex-col gap-4 px-4 py-4 sm:py-8"
        id="checkout-main"
        data-checkout-root
      >
        {state.message && (
          <Alert role="status">
            <AlertCircle />
            <AlertDescription>{state.message}</AlertDescription>
          </Alert>
        )}
        <Card>
          <CardHeader>
            <CardTitle>
              <h1
                tabIndex={-1}
                ref={heading}
                className="flex items-center gap-2 outline-none"
                data-status-heading
              >
                <AlipayLogo />
                {state.suspended ? "请暂勿付款" : copy.heading}
              </h1>
            </CardTitle>
            {(state.suspended || copy.detail) && (
              <CardDescription>
                {state.suspended
                  ? "付款期限已到，请重新检查订单状态。"
                  : copy.detail}
              </CardDescription>
            )}
            <CardAction>
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
              </Badge>
            </CardAction>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            {order && (
              <>
                <div className="flex flex-col gap-1">
                  <span
                    className="text-sm text-muted-foreground"
                    data-amount-label
                  >
                    {amountLabel}
                  </span>
                  <strong
                    className="text-4xl font-semibold tracking-tight tabular-nums break-all"
                    data-payable-amount
                  >
                    {checkoutMoney(cents)}
                  </strong>
                </div>
                {canPay && (
                  <>
                    <div className="flex justify-between text-sm">
                      <span>扫码付款</span>
                      <span className="text-muted-foreground">
                        剩余{" "}
                        <time
                          className="font-mono tabular-nums"
                          dateTime={order.checkout.expires_at}
                          data-countdown
                        >
                          {countdown}
                        </time>
                      </span>
                    </div>
                    <div className="flex justify-center">
                      <img
                        ref={qrImage}
                        src={qrSource}
                        width={256}
                        height={256}
                        className="max-w-full rounded-lg bg-white p-3"
                        alt="用于支付此订单的支付宝付款二维码"
                        data-qr-image
                        onLoad={() => setQrFailed(false)}
                        onError={() => {
                          setQrFailed(true);
                          setExpanded(false);
                        }}
                      />
                    </div>
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
                              className="w-full rounded-lg bg-white p-4"
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
                <Separator />
                <dl className="flex flex-col gap-3 text-sm">
                  {initial.showProductName !== false && (
                    <div className="flex flex-col gap-1">
                      <dt className="text-muted-foreground">商品</dt>
                      <dd className="break-words" data-product-name>
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
              </>
            )}
          </CardContent>
          {(retryAllowed || returnUrl) && (
            <CardFooter className="flex flex-wrap gap-2">
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
            </CardFooter>
          )}
        </Card>
        {state.feedback && (
          <p
            className="text-center text-sm text-muted-foreground"
            role="status"
          >
            {state.feedback}
          </p>
        )}
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
