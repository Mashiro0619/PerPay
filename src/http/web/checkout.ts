import type { PublicCheckoutProjection } from "../../orders/model.ts";
import { WEB_ASSET_URLS } from "./assets.ts";

export const CHECKOUT_PAGE_ASSETS = Object.freeze({
  checkoutStylesheet: WEB_ASSET_URLS.checkoutStylesheet,
  checkoutScript: WEB_ASSET_URLS.checkoutScript,
});

export type CheckoutPageErrorStatus = 404 | 429 | 503;

export interface CheckoutPageInitialError {
  readonly status: CheckoutPageErrorStatus;
  readonly code: string;
  readonly message: string;
  readonly retryAfterSeconds: number | null;
}

export interface CheckoutPageInput {
  readonly checkoutToken: string;
  readonly checkout: PublicCheckoutProjection | null;
  readonly qrImageUrl: string | null;
  readonly initialError: CheckoutPageInitialError | null;
}

export type CheckoutVisualState =
  | "UNPAID"
  | "CONFIRMED"
  | "DISPUTED"
  | "CLOSED"
  | "EXPIRED"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "UNAVAILABLE";

interface StateCopy {
  readonly badge: string;
  readonly heading: string;
  readonly detail: string;
  readonly badgeClass: string;
}

const STATE_COPY: Readonly<Record<CheckoutVisualState, StateCopy>> = Object.freeze({
  UNPAID: {
    badge: "等待付款",
    heading: "支付宝付款",
    detail: "金额需完全一致，付款后自动确认。",
    badgeClass: "",
  },
  CONFIRMED: {
    badge: "付款已确认",
    heading: "付款已确认",
    detail: "已收到付款，请勿重复支付。",
    badgeClass: "is-success",
  },
  DISPUTED: {
    badge: "付款有争议",
    heading: "付款需要核实",
    detail: "请联系商家核实，勿再次付款。",
    badgeClass: "is-danger",
  },
  CLOSED: {
    badge: "订单已关闭",
    heading: "订单已关闭",
    detail: "此订单不再收款，请勿付款。",
    badgeClass: "is-warning",
  },
  EXPIRED: {
    badge: "订单已过期",
    heading: "订单已过期",
    detail: "付款时间已结束，请返回商家重新下单。",
    badgeClass: "is-warning",
  },
  NOT_FOUND: {
    badge: "订单不可用",
    heading: "找不到这个订单",
    detail: "链接已失效或不完整，请向商家获取新链接。",
    badgeClass: "is-danger",
  },
  RATE_LIMITED: {
    badge: "正在等待刷新",
    heading: "请求过于频繁",
    detail: "请稍等，页面会自动重试。",
    badgeClass: "is-warning",
  },
  UNAVAILABLE: {
    badge: "收款暂不可用",
    heading: "暂时无法确认付款",
    detail: "收款服务暂不可用，请勿付款。页面会自动重试。",
    badgeClass: "is-warning",
  },
});

export function checkoutApiPath(checkoutToken: string): string {
  if (checkoutToken.length === 0 || checkoutToken.length > 512) {
    throw new TypeError("checkout token length is invalid");
  }
  return `/api/public/v1/checkouts/${encodeURIComponent(checkoutToken)}`;
}

export function checkoutQrPath(checkoutToken: string): string {
  return `${checkoutApiPath(checkoutToken)}/qr.svg`;
}

export function deriveCheckoutVisualState(
  checkout: PublicCheckoutProjection,
): CheckoutVisualState {
  if (checkout.payment.status === "DISPUTED") return "DISPUTED";
  if (checkout.payment.status === "CONFIRMED") return "CONFIRMED";
  if (checkout.checkout.status === "CLOSED") return "CLOSED";
  if (checkout.checkout.status === "EXPIRED") return "EXPIRED";
  return "UNPAID";
}

export function renderCheckoutPage(input: CheckoutPageInput): string {
  validateInput(input);

  const finalNotFound = input.checkout === null && input.initialError?.status === 404;
  const pageToken = finalNotFound ? "" : input.checkoutToken;
  const apiUrl = finalNotFound ? "" : checkoutApiPath(input.checkoutToken);
  const recoverableQrUrl = finalNotFound
    ? ""
    : input.qrImageUrl ?? checkoutQrPath(input.checkoutToken);
  const visualState = initialVisualState(input);
  const stateCopy = STATE_COPY[visualState];
  const checkout = input.checkout;
  const paymentInstructions = checkout?.paymentInstructions ?? null;
  const displayedAmountCents = paymentInstructions?.payableAmountCents
    ?? checkout?.payment.receivedAmountCents
    ?? checkout?.requestedAmountCents
    ?? 0;
  const amountLabel = paymentInstructions !== null
    ? "应付金额"
    : checkout?.payment.status === "CONFIRMED" || checkout?.payment.status === "DISPUTED"
      ? "已收金额"
      : "订单金额";
  const formattedAmount = formatCents(displayedAmountCents);
  const amountLengthClass = formattedAmount.length >= 13
    ? "is-very-long"
    : formattedAmount.length >= 10
      ? "is-long"
      : "";
  const amountContent = `
              <p class="checkout-amount-label" data-amount-label>${escapeHtml(amountLabel)}</p>
              <p class="checkout-amount ${amountLengthClass}">
                <span class="checkout-sr-only" data-amount-accessible>${formatAmountAccessible(displayedAmountCents, amountLabel)}</span>
                <span class="checkout-currency" aria-hidden="true">¥</span>
                <strong data-payable-amount aria-hidden="true">${formattedAmount}</strong>
              </p>`;
  const routeErrorVisible = checkout === null;
  const checkoutVisible = checkout !== null;
  const qrVisible =
    checkout !== null
    && deriveCheckoutVisualState(checkout) === "UNPAID"
    && paymentInstructions !== null
    && input.initialError?.status !== 503
    && input.initialError?.status !== 404
    && input.qrImageUrl !== null;
  const manualRefreshVisible =
    checkout !== null && ["UNPAID", "UNAVAILABLE"].includes(visualState);
  const returnMerchantVisible =
    checkout !== null && visualState === "CONFIRMED" && checkout.returnUrl !== null;
  const paymentColumnVisible = qrVisible || manualRefreshVisible;
  const refundMessage = refundCopy(checkout);
  const title = checkout === null
    ? `${stateCopy.heading} | PerPay`
    : `${checkout.merchantOrderNo} | PerPay 收银台`;
  const retryAfter = input.initialError?.retryAfterSeconds;

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="color-scheme" content="light dark">
  <meta name="theme-color" content="#f7f8fa" media="(prefers-color-scheme: light)">
  <meta name="theme-color" content="#111214" media="(prefers-color-scheme: dark)">
  <meta name="robots" content="noindex, nofollow, noarchive">
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="${CHECKOUT_PAGE_ASSETS.checkoutStylesheet}">
  <script src="${CHECKOUT_PAGE_ASSETS.checkoutScript}" defer></script>
</head>
<body class="checkout-page">
  <a class="checkout-skip-link" href="#checkout-main">跳到付款内容</a>
  <header class="checkout-masthead">
    <span class="checkout-brand">PerPay</span>
    <span class="checkout-masthead-label">收银台</span>
  </header>

  <div class="checkout-network-banner checkout-alert checkout-alert--warning" data-network-banner role="status" aria-live="polite" hidden></div>

  <main
    class="checkout-shell"
    id="checkout-main"
    data-checkout-root
    data-server-time="${Date.now()}"
    data-checkout-token="${escapeHtml(pageToken)}"
    data-checkout-api-url="${escapeHtml(apiUrl)}"
    data-checkout-qr-url="${escapeHtml(recoverableQrUrl)}"
    data-initial-state="${visualState}"
    data-checkout-status="${checkout?.checkout.status ?? ""}"
    data-payment-status="${checkout?.payment.status ?? ""}"
    data-payment-basis="${checkout?.payment.basis ?? ""}"
    data-refund-status="${checkout?.refund.status ?? ""}"
    data-expires-at="${checkout === null ? "" : new Date(checkout.checkout.expiresAt).toISOString()}"
    data-retry-after-seconds="${retryAfter ?? ""}"
  >
    <section class="checkout-route-error" data-route-error${hiddenAttribute(!routeErrorVisible)} aria-labelledby="route-error-title" role="alert" aria-live="assertive" aria-atomic="true" tabindex="-1">
      <p class="checkout-route-code checkout-mono" data-route-error-code>${input.initialError?.status ?? ""}</p>
      <h1 id="route-error-title" data-route-error-title tabindex="-1">${escapeHtml(stateCopy.heading)}</h1>
      <p data-route-error-message>${escapeHtml(stateCopy.detail)}</p>
      <div class="checkout-route-actions">
        <button class="checkout-button checkout-button--primary" type="button" data-checkout-retry${hiddenAttribute(input.initialError?.status === 404)}>重新获取订单</button>
      </div>
      <p class="checkout-request-reference checkout-muted" data-request-reference${hiddenAttribute(input.initialError === null)}>
        错误代码：<span class="checkout-mono">${escapeHtml(input.initialError?.code ?? "")}</span>
      </p>
    </section>

    <article class="checkout-receipt" data-checkout-content${hiddenAttribute(!checkoutVisible)} data-state="${visualState}" aria-labelledby="checkout-title">
      <header class="checkout-statebar">
        <span class="checkout-state-badge ${stateCopy.badgeClass}" data-status-badge>${escapeHtml(stateCopy.badge)}</span>
        <div class="checkout-countdown" data-countdown-wrap${hiddenAttribute(visualState !== "UNPAID")}>
          <span>剩余</span>
          <time class="checkout-mono" data-countdown datetime="${checkout === null ? "" : new Date(checkout.checkout.expiresAt).toISOString()}">--:--</time>
        </div>
      </header>

      <div class="checkout-receipt-body${paymentColumnVisible ? "" : " is-summary-only"}${qrVisible ? " has-qr" : ""}">
        <section class="checkout-summary" aria-labelledby="checkout-title">
          <h1 id="checkout-title" data-status-heading tabindex="-1">${escapeHtml(stateCopy.heading)}</h1>
          <div class="checkout-amount-block" data-amount-block>
            ${amountContent}
          </div>
          <p class="checkout-status-detail" data-status-detail>${escapeHtml(stateCopy.detail)}</p>
          <a class="checkout-button checkout-button--primary checkout-return-merchant" data-return-merchant${linkHrefAttribute(returnMerchantVisible ? checkout?.returnUrl ?? null : null)}${hiddenAttribute(!returnMerchantVisible)}>返回商家</a>
        </section>

        <div class="checkout-payment-column" data-payment-column${hiddenAttribute(!paymentColumnVisible)}>
          <section class="checkout-code-panel" data-qr-panel${hiddenAttribute(!qrVisible)} aria-labelledby="code-title">
            <h2 class="checkout-sr-only" id="code-title">支付宝付款二维码</h2>
            <figure class="checkout-code-figure">
              <img
                data-qr-image
                ${imageSourceAttributes(input.qrImageUrl, qrVisible)}
                width="320"
                height="320"
                alt="用于支付此订单的支付宝付款二维码"
                decoding="async"
              >
              <figcaption data-payment-guidance${hiddenAttribute(!qrVisible)}>打开支付宝，扫一扫</figcaption>
            </figure>
            <div class="checkout-code-error checkout-inline-error" data-qr-error role="alert" hidden>
              <strong>二维码加载失败</strong>
              <p>检查网络后重试。</p>
              <button class="checkout-button" type="button" data-qr-reload>重新加载二维码</button>
            </div>
          </section>

          <div class="checkout-code-actions"${hiddenAttribute(!qrVisible)}>
            <button class="checkout-button checkout-button--quiet" type="button" data-qr-expand>放大二维码</button>
            <button class="checkout-button checkout-button--quiet" type="button" data-qr-download${qrVisible ? "" : " disabled"}>保存二维码</button>
          </div>
          <p class="checkout-album-hint" data-payment-guidance${hiddenAttribute(!qrVisible)}>同一部手机付款：保存图片 → 支付宝扫一扫 → 相册。</p>
          <p class="checkout-save-message" data-qr-download-status role="status" hidden></p>
          <button class="checkout-button checkout-button--primary checkout-manual-refresh" type="button" data-checkout-refresh${hiddenAttribute(!manualRefreshVisible)}>
            <span data-checkout-refresh-label>查询付款状态</span>
          </button>
          <div class="checkout-update-message checkout-alert" data-update-message role="status" aria-live="polite" hidden></div>
        </div>

        <dl class="checkout-order-details">
          <div data-product-name-row${hiddenAttribute(!checkout?.productName)}>
            <dt>商品</dt>
            <dd data-product-name>${escapeHtml(checkout?.productName ?? "")}</dd>
          </div>
          <div>
            <dt>订单号</dt>
            <dd class="checkout-mono" data-merchant-order-no>${escapeHtml(checkout?.merchantOrderNo ?? "-")}</dd>
          </div>
          <div>
            <dt>订单金额</dt>
            <dd data-requested-amount>${checkout === null ? "-" : formatMoney(checkout.requestedAmountCents, checkout.currency)}</dd>
          </div>
        </dl>
      </div>

      <div class="checkout-refund checkout-alert ${refundMessage.className}" data-refund-message role="status"${hiddenAttribute(refundMessage.text === null)}>
        <div class="checkout-message-body">
          <h2 data-refund-title>${escapeHtml(refundMessage.title)}</h2>
          <p data-refund-detail>${escapeHtml(refundMessage.text ?? "")}</p>
        </div>
      </div>
      <p class="checkout-sr-only" data-state-announcement role="status" aria-live="polite" aria-atomic="true"></p>
    </article>
  </main>

  <dialog class="checkout-code-dialog" data-qr-dialog aria-labelledby="expanded-code-title">
    <div class="checkout-dialog-header">
      <h2 id="expanded-code-title">支付宝付款</h2>
      <button class="checkout-button" type="button" data-qr-dialog-close>关闭</button>
    </div>
    <p class="checkout-dialog-amount" data-qr-dialog-amount>${formatMoney(displayedAmountCents, "CNY")}</p>
    <img ${imageSourceAttributes(input.qrImageUrl, qrVisible)} width="640" height="640" alt="放大的支付宝付款二维码" data-qr-dialog-image>
    <p>请按此金额付款，勿重复支付。</p>
  </dialog>
</body>
</html>`;
}

function initialVisualState(input: CheckoutPageInput): CheckoutVisualState {
  if (input.initialError?.status === 404) return "NOT_FOUND";
  if (input.initialError?.status === 429) return "RATE_LIMITED";
  if (input.initialError?.status === 503) return "UNAVAILABLE";
  if (input.checkout === null) return "NOT_FOUND";
  return deriveCheckoutVisualState(input.checkout);
}

function validateInput(input: CheckoutPageInput): void {
  if (input.checkout === null && input.initialError === null) {
    throw new TypeError("checkout page requires checkout data or an initial error");
  }
  if (input.qrImageUrl !== null) assertSameOriginPath(input.qrImageUrl, "QR image URL");
  if (input.initialError?.retryAfterSeconds !== null
    && input.initialError?.retryAfterSeconds !== undefined
    && (!Number.isSafeInteger(input.initialError.retryAfterSeconds)
      || input.initialError.retryAfterSeconds < 0)) {
    throw new TypeError("retry-after seconds must be a non-negative safe integer");
  }
}

function assertSameOriginPath(value: string, label: string): void {
  if (!value.startsWith("/") || value.startsWith("//") || /[\r\n]/.test(value)) {
    throw new TypeError(`${label} must be a same-origin absolute path`);
  }
  const parsed = new URL(value, "https://checkout.invalid");
  if (parsed.origin !== "https://checkout.invalid") {
    throw new TypeError(`${label} must be a same-origin absolute path`);
  }
}

function refundCopy(checkout: PublicCheckoutProjection | null): {
  readonly title: string;
  readonly text: string | null;
  readonly className: string;
} {
  if (checkout?.refund.status === "FULL") {
    return {
      title: "款项已全额退款",
      text: "此订单的已收款项已登记为全额退款。",
      className: "checkout-alert--info",
    };
  }
  if (checkout?.refund.status === "PARTIAL") {
    return {
      title: "款项已部分退款",
      text: "此订单已有部分退款，具体金额请联系订单提供方确认。",
      className: "checkout-alert--info",
    };
  }
  return { title: "", text: null, className: "" };
}

function formatCents(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new TypeError("amount cents is invalid");
  const whole = Math.floor(cents / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${whole}.${String(cents % 100).padStart(2, "0")}`;
}

function formatMoney(cents: number, currency: "CNY"): string {
  return `${currency === "CNY" ? "¥" : currency} ${formatCents(cents)}`;
}

function formatAmountAccessible(cents: number, label: string): string {
  return escapeHtml(`${label} ${formatCents(cents)} 元`);
}

function hiddenAttribute(hidden: boolean): string {
  return hidden ? " hidden" : "";
}

function imageSourceAttributes(source: string | null, loadImmediately: boolean): string {
  if (source === null) return 'data-original-src=""';
  const escaped = escapeHtml(source);
  return `${loadImmediately ? `src="${escaped}" ` : ""}data-original-src="${escaped}"`;
}

function linkHrefAttribute(source: string | null): string {
  return source === null ? "" : ` href="${escapeHtml(source)}"`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
