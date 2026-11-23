import { checkoutHelpUrl } from "../../../src/shared/checkout-help";
import { alipayQrLaunchUrl } from "../../../src/shared/collection-code";
import { cn } from "cn";
import { useEffect, useRef, useState, useSyncExternalStore, type MouseEvent } from "react";
import {
  AlertCircle,
  ArrowLeft,
  Ban,
  CheckCircle2,
  Clock,
  Download,
  ExternalLink,
  Maximize,
  RefreshCw,
  WalletCards,
  X,
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
  DialogClose,
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
import {
  copyCheckoutAmount,
  isAlipaySchemeBlockedBrowser,
  navigateToAlipayScheme,
} from "./alipay-launch";
import { createCheckoutController } from "./controller";
import { useQrDownload } from "./use-qr-download";
import { AlipayLogo } from "./AlipayLogo";
import "./checkout-layout.css";

export function CheckoutApp({ initial }: { initial: CheckoutInitial }) {
  const [controller] = useState(() => createCheckoutController(initial));
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getServerSnapshot,
  );
  const [expanded, setExpanded] = useState(false),
    [qrFailed, setQrFailed] = useState(false),
    [qrRetry, setQrRetry] = useState(0),
    [launchingAlipay, setLaunchingAlipay] = useState(false),
    [launchHint, setLaunchHint] = useState("");
  const qrImage = useRef<HTMLImageElement>(null),
    qrRetryButton = useRef<HTMLButtonElement>(null),
    heading = useRef<HTMLHeadingElement>(null),
    wasExpanded = useRef(false),
    launchToken = useRef(0);
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
  const directLaunchUrl = order?.payment_instructions?.collection_code_payload
    ? alipayQrLaunchUrl(order.payment_instructions.collection_code_payload)
    : null;
  const canLaunchAlipay =
    canPay && (directLaunchUrl !== null || Boolean(initial.alipayLaunchAvailable));
  const qrSource =
    initial.qrUrl +
    (qrRetry
      ? (initial.qrUrl.includes("?") ? "&" : "?") + "retry=" + qrRetry
      : "");
  const download = useQrDownload(qrImage, canPay && !qrFailed, systemName);
  useEffect(() => {
    if (!canPay) {
      launchToken.current += 1;
      setExpanded(false);
      setQrFailed(false);
      setLaunchingAlipay(false);
      setLaunchHint("");
      if (wasExpanded.current) heading.current?.focus();
    } else if (qrFailed && wasExpanded.current) {
      qrRetryButton.current?.focus();
    }
    wasExpanded.current = expanded;
  }, [canPay, expanded, qrFailed]);
  useEffect(() => {
    if (state.unavailable) {
      launchToken.current += 1;
      setLaunchingAlipay(false);
    }
  }, [state.unavailable]);
  useEffect(() => () => {
    launchToken.current += 1;
  }, []);
  useEffect(() => {
    if (state.feedback) setLaunchHint("");
  }, [state.feedback]);
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
  const formattedAmount = checkoutMoney(cents);
  const amountIntegerDigits = Math.floor(cents / 100).toString().length;
  const amountLabel = order?.payment_instructions
    ? "应付金额"
    : order?.payment.received_amount_cents != null
      ? "实付金额"
      : "订单金额";
  const adjustmentCents = order?.payment_instructions
    ? order.payment_instructions.payable_amount_cents -
      order.requested_amount_cents
    : 0;
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
    ? merchantReturnUrl(order?.return_url, initial.internalReturnUrl)
    : null;
  const helpUrl = checkoutHelpUrl(order?.display ? order.display.help_url : initial.helpUrl);
  const retryAllowed =
    state.visual !== "NOT_FOUND" &&
    (!order ||
      ["UNPAID", "EXPIRED", "CLOSED", "UNAVAILABLE", "RATE_LIMITED"].includes(state.visual));
  const blocked = state.busy || state.unavailable || state.retryAt > Date.now();
  const desktopWidth = order
    ? showProductName === false
      ? "lg:max-w-3xl lg:px-6"
      : "lg:max-w-[54rem] xl:max-w-[58rem] lg:px-6"
    : "max-w-[29rem]";
  const reloadPath = initial.apiUrl.startsWith("/api/public/v1/checkouts/")
    ? "/checkout/" + initial.apiUrl.slice("/api/public/v1/checkouts/".length)
    : "";

  const stateTone: "success" | "warning" | "danger" | "neutral" =
    state.visual === "CONFIRMED"
      ? "success"
      : state.visual === "DISPUTED" ||
          state.visual === "NOT_FOUND" ||
          state.visual === "UNAVAILABLE" ||
          state.visual === "RATE_LIMITED"
        ? "danger"
        : state.visual === "EXPIRED" || state.suspended
          ? "warning"
          : "neutral";

  const terminalIcon = order && !canPay && !awaitingStartup ? (
    <div className="checkout-state-icon" data-tone={stateTone} aria-hidden="true">
      {state.visual === "CONFIRMED" ? (
        <CheckCircle2 />
      ) : state.visual === "EXPIRED" || state.suspended ? (
        <Clock />
      ) : state.visual === "CLOSED" ? (
        <Ban />
      ) : (
        <AlertCircle />
      )}
    </div>
  ) : null;

  const headingText = awaitingStartup
    ? "正在加载收银台…"
    : state.suspended
      ? "请暂勿付款"
      : copy.heading;

  const statusBadge = (
    <Badge
      className="h-auto min-h-5 max-w-full whitespace-normal"
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
  );

  const exactPayableText = (cents / 100).toFixed(2);
  function handleDirectAlipayLaunch(event: MouseEvent<HTMLAnchorElement>) {
    if (state.unavailable) {
      event.preventDefault();
      return;
    }
    const token = ++launchToken.current;
    setLaunchingAlipay(false);
    if (isAlipaySchemeBlockedBrowser(navigator.userAgent)) {
      event.preventDefault();
      void copyCheckoutAmount(exactPayableText);
      setLaunchHint("微信或 QQ 内置浏览器不支持直接唤起支付宝，请点击右上角选择“在浏览器打开”，或保存二维码扫码付款。");
      return;
    }
    setLaunchHint(`正在打开支付宝，请严格按 ${formattedAmount} 付款；如未自动跳转，请保存二维码后扫码。`);
    void copyCheckoutAmount(exactPayableText).then((copied) => {
      if (copied && launchToken.current === token) {
        setLaunchHint(`已复制应付金额 ${formattedAmount}，正在打开支付宝；如未自动跳转，请保存二维码后扫码。`);
      }
    });
  }
  async function handleDeferredAlipayLaunch() {
    if (launchingAlipay || !canLaunchAlipay || state.unavailable || !initial.apiUrl) return;
    const token = ++launchToken.current;
    if (isAlipaySchemeBlockedBrowser(navigator.userAgent)) {
      void copyCheckoutAmount(exactPayableText);
      setLaunchHint("微信或 QQ 内置浏览器不支持直接唤起支付宝，请点击右上角选择“在浏览器打开”，或保存二维码扫码付款。");
      return;
    }
    // Start clipboard copy synchronously while transient user activation is still live.
    const copyPromise = copyCheckoutAmount(exactPayableText);
    setLaunchingAlipay(true);
    try {
      const latestSnapshot = await controller.ensureLatest();
      if (launchToken.current !== token) return;
      const latest = latestSnapshot.order;
      if (
        latestSnapshot.visual !== "UNPAID" ||
        latestSnapshot.suspended ||
        latestSnapshot.unavailable ||
        !latestSnapshot.qrAvailable ||
        !latest ||
        latest.checkout.status !== "OPEN" ||
        latest.payment.status !== "UNPAID"
      ) {
        setLaunchHint("");
        return;
      }
      const url = latest.payment_instructions?.collection_code_payload
        ? alipayQrLaunchUrl(latest.payment_instructions.collection_code_payload)
        : null;
      if (!url) {
        const refreshFailed =
          Boolean(latestSnapshot.message) || latestSnapshot.retryAt > Date.now();
        setLaunchHint(
          refreshFailed
            ? "暂时无法获取支付宝跳转链接，请保存二维码后扫码付款。"
            : "当前订单暂不支持直接唤起支付宝，请保存二维码后扫码付款。",
        );
        return;
      }
      const latestCents = latest.payment_instructions!.payable_amount_cents;
      const latestExact = (latestCents / 100).toFixed(2);
      const copied =
        latestExact === exactPayableText
          ? await copyPromise
          : await copyCheckoutAmount(latestExact);
      if (launchToken.current !== token) return;
      const latestFormatted = checkoutMoney(latestCents);
      setLaunchHint(
        copied
          ? `已复制应付金额 ${latestFormatted}，正在打开支付宝；如未自动跳转，请保存二维码后扫码。`
          : `正在打开支付宝，请严格按 ${latestFormatted} 付款；如未自动跳转，请保存二维码后扫码。`,
      );
      navigateToAlipayScheme(url);
    } catch {
      if (launchToken.current === token) {
        const current = controller.getSnapshot();
        if (current.visual === "UNPAID" && !current.suspended && !current.unavailable && current.qrAvailable) {
          setLaunchHint("暂时无法获取支付宝跳转链接，请保存二维码后扫码付款。");
        } else {
          setLaunchHint("");
        }
      }
    } finally {
      if (launchToken.current === token) setLaunchingAlipay(false);
    }
  }

  const desktopQueryIsPrimary = canPay && !returnUrl;
  const hasActions = Boolean(canLaunchAlipay || retryAllowed || returnUrl);
  const terminalNoteText =
    order && !canPay && !awaitingStartup
      ? state.suspended
        ? "付款时间已到，正在为您确认订单状态。"
        : copy.detail
      : "";
  const sideBySideTerminalActions = Boolean(!canPay && returnUrl && retryAllowed);

  const actions = hasActions && (
    <CardFooter
      className={cn(
        "checkout-actions flex flex-col items-stretch gap-2.5 border-t-0 bg-transparent",
        order
          ? "pt-0 pb-1 lg:col-start-1 lg:row-start-2 lg:rounded-none lg:px-8 lg:pt-0 lg:pb-8"
          : "px-6 pt-0 pb-6 sm:px-8 sm:pb-8",
      )}
      data-checkout-actions
    >
      <div
        className={cn(
          "flex w-full flex-col items-stretch gap-2.5",
          sideBySideTerminalActions && "lg:grid lg:grid-cols-2",
        )}
      >
        {returnUrl && (
          <a
            href={returnUrl}
            className={buttonVariants({
              size: "lg",
              className: "checkout-query-action h-auto min-h-10 w-full py-2",
            })}
          >
            <ArrowLeft aria-hidden="true" data-icon="inline-start" />
            {state.visual === "CONFIRMED" ? "返回商家" : "返回商家处理"}
          </a>
        )}
        {(canLaunchAlipay || retryAllowed) && (
          <div
            className={cn(
              canLaunchAlipay
                ? "checkout-primary-actions flex w-full flex-wrap items-stretch gap-2 lg:flex-col"
                : "flex w-full flex-col items-stretch",
            )}
          >
            {canLaunchAlipay &&
              (directLaunchUrl && !state.unavailable ? (
                <a
                  href={directLaunchUrl}
                  className={buttonVariants({
                    variant: "default",
                    size: "lg",
                    className: "checkout-query-action h-auto min-h-10 flex-auto py-2 lg:hidden",
                  })}
                  data-alipay-launch
                  onClick={handleDirectAlipayLaunch}
                >
                  <ExternalLink aria-hidden="true" data-icon="inline-start" />
                  打开支付宝
                </a>
              ) : (
                <Button
                  variant="default"
                  size="lg"
                  className="checkout-query-action h-auto min-h-10 flex-auto py-2 lg:hidden"
                  disabled={launchingAlipay || state.unavailable}
                  aria-busy={launchingAlipay || undefined}
                  data-alipay-launch
                  onClick={() => void handleDeferredAlipayLaunch()}
                >
                  {launchingAlipay ? (
                    <Spinner aria-hidden="true" data-icon="inline-start" />
                  ) : (
                    <ExternalLink aria-hidden="true" data-icon="inline-start" />
                  )}
                  打开支付宝
                </Button>
              ))}
            {retryAllowed &&
              (state.initialized ? (
                <Button
                  variant={!order && !returnUrl ? "default" : "outline"}
                  size="lg"
                  className={cn(
                    "checkout-query-action h-auto min-h-10 py-2",
                    desktopQueryIsPrimary && "checkout-desktop-primary",
                    canLaunchAlipay
                      ? "min-w-0 flex-[1_1_9.5rem] lg:w-full lg:flex-none"
                      : "w-full",
                  )}
                  disabled={blocked}
                  aria-busy={state.busy || undefined}
                  onClick={() => {
                    launchToken.current += 1;
                    setLaunchingAlipay(false);
                    setLaunchHint("");
                    void controller.refresh(true);
                  }}
                >
                  {state.busy ? (
                    <Spinner aria-hidden="true" data-icon="inline-start" />
                  ) : (
                    <RefreshCw aria-hidden="true" data-icon="inline-start" />
                  )}
                  {!order ? "重新获取订单" : canPay ? "我已付款，查询状态" : "刷新付款状态"}
                </Button>
              ) : (
                <a
                  href={reloadPath}
                  className={buttonVariants({
                    variant: "outline",
                    size: "lg",
                    className: "checkout-query-action h-auto min-h-10 w-full py-2",
                  })}
                  data-checkout-reload
                >
                  <RefreshCw aria-hidden="true" data-icon="inline-start" />
                  刷新页面
                </a>
              ))}
          </div>
        )}
      </div>
      <p
        className={cn(
          "text-center text-sm text-muted-foreground lg:text-left",
          !(launchHint || state.feedback) && "sr-only",
        )}
        role="status"
        data-checkout-action-feedback
      >
        {launchHint || state.feedback}
      </p>
    </CardFooter>
  );

  // Balanced tracks center the content; intrinsic height keeps short screens scrollable.
  return (
    <div
      className="checkout-stage grid h-svh min-h-min grid-cols-[minmax(0,1fr)] grid-rows-[1fr_auto_1fr]"
      data-checkout-page
    >
      <header
        className="checkout-topbar flex min-w-0 w-full items-center justify-between gap-4 self-start px-4 pt-4 pb-2 sm:px-6 sm:pt-5 sm:pb-2 lg:px-8 lg:pt-6"
      >
        <span className="checkout-brand">
          <span className="checkout-brand-mark" aria-hidden="true">
            <WalletCards className="size-4" />
          </span>
          <span className="truncate font-semibold tracking-tight text-foreground" title={systemName}>
            {systemName}
          </span>
        </span>
        <ThemeControl className="checkout-theme-control shrink-0" />
      </header>
      <main
        className={cn(
          "mx-auto flex min-w-0 w-full max-w-lg flex-col gap-3 px-4 py-3 sm:py-6",
          desktopWidth,
        )}
        id="checkout-main"
        data-checkout-root
      >
        {state.message && (
          <Alert role="status" className="checkout-notice-banner">
            <AlertCircle aria-hidden="true" />
            <AlertDescription>{state.message}</AlertDescription>
          </Alert>
        )}
        <Card
          className={cn(
            "checkout-card",
            order
              ? cn(
                  "pb-0 lg:grid lg:grid-cols-[minmax(0,1.15fr)_auto_minmax(0,0.85fr)] lg:grid-rows-[1fr_auto] lg:gap-0 lg:py-0",
                  !canPay && !awaitingStartup && "lg:min-h-[19.5rem]",
                )
              : "gap-5 py-6 sm:py-8",
          )}
          data-checkout-layout
          data-has-order={!!order}
        >
          <div
            className={cn(
              "flex min-w-0 flex-col gap-3",
              order &&
                (hasActions
                  ? "lg:col-start-1 lg:row-start-1 lg:gap-4 lg:pt-8 lg:pb-5"
                  : "lg:col-start-1 lg:row-start-1 lg:row-span-2 lg:gap-4 lg:py-8"),
              order && !canPay && "lg:justify-center",
            )}
            data-checkout-payment
          >
            {canPay ? (
              <CardHeader className="checkout-pay-header flex flex-row items-center justify-between gap-3 lg:justify-center lg:px-8">
                <CardTitle className="min-w-0">
                  <h1
                    tabIndex={-1}
                    ref={heading}
                    className="flex items-center gap-2 text-lg font-semibold tracking-tight outline-none lg:justify-center lg:text-xl"
                    data-status-heading
                  >
                    <AlipayLogo />
                    <span>{headingText}</span>
                  </h1>
                </CardTitle>
                <CardAction className="shrink-0 self-center lg:hidden">
                  {statusBadge}
                </CardAction>
              </CardHeader>
            ) : awaitingStartup ? (
              <CardHeader className="checkout-terminal-header flex flex-col gap-2.5 lg:items-center lg:px-8 lg:text-center">
                <div className="flex w-full min-w-0 items-center justify-between gap-3 lg:justify-center">
                  <CardTitle className="min-w-0">
                    <h1
                      tabIndex={-1}
                      ref={heading}
                      className="flex items-center gap-2 text-lg font-semibold tracking-tight outline-none lg:justify-center lg:text-2xl"
                      data-status-heading
                    >
                      <AlipayLogo />
                      <span>{headingText}</span>
                    </h1>
                  </CardTitle>
                  <CardAction className={cn("shrink-0 self-center", order && "lg:hidden")}>
                    {statusBadge}
                  </CardAction>
                </div>
                <CardDescription className="text-balance leading-relaxed lg:max-w-sm lg:text-center">
                  页面正在准备中，请稍候；如长时间未显示二维码，请刷新页面或更换浏览器打开。
                </CardDescription>
              </CardHeader>
            ) : order ? (
              <CardHeader className="checkout-terminal-header flex flex-col gap-2.5 lg:items-center lg:px-8 lg:text-center">
                <div className="flex w-full min-w-0 items-center justify-between gap-3 lg:flex-col lg:justify-center lg:gap-2.5">
                  <div className="flex min-w-0 items-center gap-2.5 lg:flex-col lg:gap-3">
                    {terminalIcon}
                    <CardTitle className="min-w-0 lg:w-full">
                      <h1
                        tabIndex={-1}
                        ref={heading}
                        className="text-lg font-semibold tracking-tight outline-none lg:text-2xl"
                        data-status-heading
                      >
                        {headingText}
                      </h1>
                    </CardTitle>
                  </div>
                  <CardAction className="shrink-0 self-center lg:hidden">
                    {statusBadge}
                  </CardAction>
                </div>
              </CardHeader>
            ) : (
              <CardHeader className="checkout-terminal-header flex flex-col items-center gap-3 px-6 text-center sm:px-8">
                <CardAction className="self-center">
                  <Badge
                    className="h-auto min-h-6 max-w-full gap-1.5 px-2.5 py-1 whitespace-normal"
                    variant={
                      ["DISPUTED", "NOT_FOUND"].includes(state.visual)
                        ? "destructive"
                        : "secondary"
                    }
                  >
                    <AlertCircle aria-hidden="true" />
                    {copy.badge}
                  </Badge>
                </CardAction>
                <CardTitle className="w-full">
                  <h1
                    tabIndex={-1}
                    ref={heading}
                    className="text-xl font-semibold tracking-tight outline-none lg:text-2xl"
                    data-status-heading
                  >
                    {headingText}
                  </h1>
                </CardTitle>
                {copy.detail && (
                  <CardDescription className="max-w-sm text-balance text-center leading-relaxed">
                    {copy.detail}
                  </CardDescription>
                )}
              </CardHeader>
            )}
            {order && (
              <CardContent className="flex min-w-0 flex-col gap-3 lg:px-8">
                <div className="checkout-amount-block">
                  <div
                    className="flex w-full min-w-0 flex-wrap items-baseline justify-center gap-2 text-center"
                    data-checkout-amount
                  >
                    <span
                      className="shrink-0 text-sm text-muted-foreground"
                      data-amount-label
                    >
                      {amountLabel}
                    </span>
                    <strong
                      className="min-w-0 text-[1.75rem] font-semibold tracking-tight whitespace-nowrap tabular-nums lg:text-[2.125rem]"
                      data-payable-amount
                      data-checkout-money-digits={amountIntegerDigits}
                    >
                      {formattedAmount}
                    </strong>
                    {canPay && (
                      <CopyValue
                        value={(cents / 100).toFixed(2)}
                        label="复制应付金额"
                        buttonOnly
                      />
                    )}
                  </div>
                  {canPay && adjustmentCents > 0 && (
                    <p
                      className="checkout-offset-pill"
                      data-checkout-amount-hint
                    >
                      <span className="sm:hidden">
                        含核对微调 +{checkoutMoney(adjustmentCents)}，勿改金额
                      </span>
                      <span className="hidden sm:inline">
                        为自动核对已微调 +{checkoutMoney(adjustmentCents)}，请按此金额付款，无需改回原价
                      </span>
                    </p>
                  )}
                </div>
                {canPay && (
                  <>
                    {qrFailed ? (
                      <Alert variant="destructive" data-checkout-qr-failed>
                        <AlertCircle aria-hidden="true" />
                        <AlertTitle>二维码加载失败</AlertTitle>
                        <AlertDescription>
                          <Button
                            ref={qrRetryButton}
                            variant="outline"
                            onClick={() => {
                              setQrFailed(false);
                              setQrRetry(retry => retry + 1);
                            }}
                          >
                            重新加载二维码
                          </Button>
                        </AlertDescription>
                      </Alert>
                    ) : (
                      <>
                        <div className="flex justify-center">
                          <div className="checkout-qr-frame">
                            <img
                              ref={qrImage}
                              src={qrSource}
                              width={240}
                              height={240}
                              className="block h-auto max-w-full bg-white"
                              alt="用于支付此订单的支付宝付款二维码"
                              data-qr-image
                              onLoad={() => setQrFailed(false)}
                              onError={() => {
                                setQrFailed(true);
                                setExpanded(false);
                              }}
                            />
                          </div>
                        </div>
                        <p className="text-balance text-center text-[0.8125rem] leading-relaxed text-muted-foreground lg:text-sm" data-checkout-payment-instructions>
                          <span className="lg:hidden">
                            {canLaunchAlipay
                              ? `点“打开支付宝”或扫码，严格按 ${formattedAmount} 付款`
                              : `保存二维码后用支付宝扫码，严格按 ${formattedAmount} 付款`}
                          </span>
                          <span className="hidden lg:inline">
                            打开支付宝“扫一扫”，严格按 {formattedAmount} 付款，切勿修改金额。
                          </span>
                        </p>
                        <div className="checkout-qr-tools flex flex-wrap justify-center gap-1.5">
                          <Dialog open={expanded} onOpenChange={setExpanded}>
                            <DialogTrigger render={<Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground" />}>
                              <Maximize aria-hidden="true" data-icon="inline-start" />
                              放大二维码
                            </DialogTrigger>
                            <DialogContent className="checkout-qr-dialog" showCloseButton={false}>
                              <DialogHeader className="checkout-qr-header">
                                <DialogTitle>付款二维码</DialogTitle>
                                <DialogClose render={<Button variant="ghost" size="icon-sm" aria-label="关闭二维码" />}>
                                  <X aria-hidden="true" />
                                </DialogClose>
                              </DialogHeader>
                              <div className="checkout-qr-body">
                                <div className="checkout-qr-stage" data-qr-dialog-body>
                                  <img
                                    src={qrSource}
                                    width={640}
                                    height={640}
                                    className="rounded-lg bg-white"
                                    alt="放大的支付宝付款二维码"
                                    data-qr-dialog-image
                                    onError={() => {
                                      setQrFailed(true);
                                      setExpanded(false);
                                    }}
                                  />
                                </div>
                                <div className="checkout-qr-information">
                                  <p
                                    className="checkout-qr-amount text-center text-2xl font-semibold tracking-tight whitespace-nowrap tabular-nums"
                                    data-checkout-money-digits={amountIntegerDigits}
                                  >
                                    {formattedAmount}
                                  </p>
                                  <DialogDescription>
                                    请严格按此金额付款，切勿修改金额或重复付款。
                                  </DialogDescription>
                                </div>
                              </div>
                            </DialogContent>
                          </Dialog>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-muted-foreground hover:text-foreground"
                            disabled={download.busy || state.unavailable}
                            onClick={download.save}
                          >
                            {download.busy ? (
                              <Spinner
                                aria-hidden="true"
                                data-icon="inline-start"
                              />
                            ) : (
                              <Download aria-hidden="true" data-icon="inline-start" />
                            )}
                            保存二维码
                          </Button>
                        </div>
                      </>
                    )}
                    {download.message && (
                      <p
                        className="text-center text-sm text-muted-foreground"
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
          {terminalNoteText && (
            <div
              className="px-4 text-center text-sm leading-relaxed text-muted-foreground lg:col-start-3 lg:row-start-2 lg:self-end lg:px-8 lg:pt-0 lg:pb-8 lg:text-left"
              data-checkout-terminal-note
            >
              <div className="lg:border-t lg:border-border/70 lg:pt-4">
                <p className="text-balance">{terminalNoteText}</p>
              </div>
            </div>
          )}
          {actions}
          {order && (
            <>
              <div className="px-4 lg:hidden">
                <Separator />
              </div>
              <Separator orientation="vertical" className="hidden lg:col-start-2 lg:row-start-1 lg:row-span-2 lg:block" />
              <section
                aria-label="订单信息"
                className={cn(
                  "checkout-summary flex min-w-0 flex-col gap-5 pb-(--card-spacing) lg:col-start-3 lg:row-start-1",
                  terminalNoteText
                    ? "lg:px-8 lg:pt-8 lg:pb-4"
                    : "lg:row-span-2 lg:p-8",
                )}
                data-checkout-summary
              >
                <CardHeader className="hidden min-w-0 flex-wrap items-center justify-between gap-2 lg:flex lg:px-0">
                  <CardTitle className="min-w-0">
                    <h2 className="text-base font-semibold tracking-tight">订单信息</h2>
                  </CardTitle>
                  <CardAction className="min-w-0 max-w-full self-center">{statusBadge}</CardAction>
                </CardHeader>
                <CardContent className="flex min-w-0 flex-1 flex-col gap-4 lg:px-0">
                  <dl className="flex min-w-0 flex-col gap-3.5 text-sm lg:gap-4">
                    {showProductName !== false && (
                      <div className="flex flex-col gap-1">
                        <dt className="text-xs text-muted-foreground">商品</dt>
                        <dd className="font-medium text-foreground wrap-anywhere" data-product-name>
                          {order.product_name}
                        </dd>
                      </div>
                    )}
                    <div className="flex flex-col gap-1">
                      <dt className="text-xs text-muted-foreground">商家订单号</dt>
                      <dd className="min-w-0" data-merchant-order-no>
                        <CopyValue
                          value={order.merchant_order_no}
                          label="复制商家订单号"
                        />
                      </dd>
                    </div>
                  </dl>
                  {canPay && adjustmentCents > 0 && (
                    <div className="checkout-breakdown">
                      <div className="checkout-breakdown-row">
                        <span className="text-muted-foreground">商品原价</span>
                        <span className="tabular-nums text-foreground">
                          {checkoutMoney(order.requested_amount_cents)}
                        </span>
                      </div>
                      <div className="checkout-breakdown-row">
                        <span className="text-muted-foreground">自动核对微调</span>
                        <span className="tabular-nums text-foreground">
                          +{checkoutMoney(adjustmentCents)}
                        </span>
                      </div>
                      <Separator />
                      <div className="checkout-breakdown-row font-medium">
                        <span className="text-foreground">实际应付</span>
                        <span className="tabular-nums text-foreground">
                          {formattedAmount}
                        </span>
                      </div>
                    </div>
                  )}
                  {order.refund.status !== "NONE" && (
                    <Alert className="checkout-refund-alert">
                      <AlertCircle aria-hidden="true" />
                      <AlertTitle>
                        {order.refund.status === "FULL"
                          ? "订单已有全额退款记录"
                          : "订单已有部分退款记录"}
                      </AlertTitle>
                      <AlertDescription>
                        具体退款金额与到账进度请联系商家确认。
                      </AlertDescription>
                    </Alert>
                  )}
                </CardContent>
              </section>
            </>
          )}
        </Card>
        {helpUrl && (
          <p className="checkout-help-row text-right text-sm text-muted-foreground" data-checkout-help>
            <a
              href={helpUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="checkout-help-link rounded-sm hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
            >
              商家帮助
            </a>
          </p>
        )}
        <p className="sr-only" role="status" aria-live="polite">
          {awaitingStartup
            ? "收银台正在加载中，请稍候。"
            : state.suspended
              ? "付款时间已到，请暂勿付款。"
              : copy.heading}
        </p>
      </main>
    </div>
  );
}
