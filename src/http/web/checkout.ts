import type { PublicCheckoutProjection } from "../../orders/model.ts";
import { WEB_ASSET_URLS } from "./assets.ts";

export const CHECKOUT_PAGE_ASSETS = Object.freeze({
  usuzumiStylesheet: WEB_ASSET_URLS.usuzumiStylesheet,
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
    heading: "请支付以下准确金额",
    detail: "付款后请停留在本页，系统确认后会自动更新。请勿重复付款。",
    badgeClass: "",
  },
  CONFIRMED: {
    badge: "付款已确认",
    heading: "付款已确认",
    detail: "订单已经完成确认，无需再次付款。",
    badgeClass: "uzu-badge-success",
  },
  DISPUTED: {
    badge: "付款有争议",
    heading: "付款关联需要处理",
    detail: "这笔付款的关联存在争议，请联系订单提供方处理，勿再次付款。",
    badgeClass: "uzu-badge-danger",
  },
  CLOSED: {
    badge: "订单已关闭",
    heading: "订单已关闭",
    detail: "此订单不再收款，请勿扫描或再次付款。",
    badgeClass: "uzu-badge-warning",
  },
  EXPIRED: {
    badge: "订单已过期",
    heading: "订单已过期",
    detail: "付款时间已经结束，请返回订单提供方重新创建订单。",
    badgeClass: "uzu-badge-warning",
  },
  NOT_FOUND: {
    badge: "订单不可用",
    heading: "找不到这个订单",
    detail: "链接可能不完整、已经失效，或订单的查询期限已经结束。",
    badgeClass: "uzu-badge-danger",
  },
  RATE_LIMITED: {
    badge: "正在等待刷新",
    heading: "请求过于频繁",
    detail: "页面会在稍后自动重新获取订单状态，也可以手动重试。",
    badgeClass: "uzu-badge-warning",
  },
  UNAVAILABLE: {
    badge: "收款暂不可用",
    heading: "暂时无法确认付款",
    detail: "自动确认服务尚未就绪，请暂勿付款。页面会自动重试。",
    badgeClass: "uzu-badge-warning",
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
    ? "本次应付"
    : checkout?.payment.status === "CONFIRMED" || checkout?.payment.status === "DISPUTED"
      ? "已收金额"
      : "订单金额";
  const formattedAmount = formatCents(displayedAmountCents);
  const amountLengthClass = formattedAmount.length >= 13
    ? "is-very-long"
    : formattedAmount.length >= 10
      ? "is-long"
      : "";
  const routeErrorVisible = checkout === null;
  const checkoutVisible = checkout !== null;
  const qrVisible =
    checkout !== null
    && deriveCheckoutVisualState(checkout) === "UNPAID"
    && paymentInstructions !== null
    && input.initialError?.status !== 503
    && input.initialError?.status !== 404
    && input.qrImageUrl !== null;
  const refundMessage = refundCopy(checkout);
  const evidence = evidenceCopy(checkout, visualState);
  const title = checkout === null
    ? `${stateCopy.heading} | PerPay`
    : `${checkout.merchantOrderNo} | PerPay 收银台`;
  const footerCopy = checkout === null
    ? input.initialError?.status === 404
      ? "请向订单提供方确认收银台链接是否完整、有效。"
      : "页面会自动重新获取订单状态；恢复前请暂勿付款。"
    : "支付结果以本页的订单状态为准。遇到异常时请保留付款记录并联系订单提供方。";
  const retryAfter = input.initialError?.retryAfterSeconds;

  return `<!doctype html>
<html class="uzu-root" lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <meta name="robots" content="noindex, nofollow, noarchive">
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="${CHECKOUT_PAGE_ASSETS.usuzumiStylesheet}">
  <link rel="stylesheet" href="${CHECKOUT_PAGE_ASSETS.checkoutStylesheet}">
  <script src="${CHECKOUT_PAGE_ASSETS.checkoutScript}" defer></script>
</head>
<body class="uzu-app checkout-page">
  <a class="checkout-skip-link" href="#checkout-main">跳到付款内容</a>
  <header class="checkout-masthead">
    <span class="checkout-brand">PerPay</span>
    <span class="checkout-masthead-label">收银台</span>
  </header>

  <div class="checkout-network-banner uzu-alert uzu-alert-warning" data-network-banner role="status" aria-live="polite" hidden></div>

  <main
    class="checkout-shell"
    id="checkout-main"
    data-checkout-root
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
    <section class="uzu-error-page uzu-error-page-screen checkout-route-error" data-route-error${hiddenAttribute(!routeErrorVisible)} aria-labelledby="route-error-title" role="alert" aria-live="assertive" aria-atomic="true" tabindex="-1">
      <p class="uzu-error-page-code checkout-route-code uzu-mono" data-route-error-code>${input.initialError?.status ?? ""}</p>
      <h1 id="route-error-title" data-route-error-title tabindex="-1">${escapeHtml(stateCopy.heading)}</h1>
      <p data-route-error-message>${escapeHtml(stateCopy.detail)}</p>
      <div class="uzu-error-page-actions">
        <button class="uzu-button uzu-button-primary" type="button" data-checkout-retry${hiddenAttribute(input.initialError?.status === 404)}>重新获取订单</button>
      </div>
      <p class="checkout-request-reference uzu-muted" data-request-reference${hiddenAttribute(input.initialError === null)}>
        错误代码：<span class="uzu-mono">${escapeHtml(input.initialError?.code ?? "")}</span>
      </p>
    </section>

    <article class="uzu-card checkout-receipt" data-checkout-content${hiddenAttribute(!checkoutVisible)} aria-labelledby="checkout-title">
      <header class="checkout-statebar">
        <span class="checkout-state-badge uzu-badge ${stateCopy.badgeClass}" data-status-badge>${escapeHtml(stateCopy.badge)}</span>
        <div class="checkout-countdown" data-countdown-wrap${hiddenAttribute(visualState !== "UNPAID")}>
          <span>付款时间</span>
          <time class="uzu-mono" data-countdown datetime="${checkout === null ? "" : new Date(checkout.checkout.expiresAt).toISOString()}">--:--</time>
        </div>
      </header>

      <div class="checkout-service-alert uzu-alert uzu-alert-warning" data-service-alert role="status"${hiddenAttribute(input.initialError?.status !== 503)}>
        <div class="uzu-title-pair">
          <h2>暂时无法确认付款</h2>
          <p>自动确认服务尚未就绪，请暂勿付款。页面会自动重试。</p>
        </div>
      </div>

      <div class="checkout-receipt-body">
        <section class="checkout-summary" aria-labelledby="checkout-title">
          <div class="checkout-heading-block">
            <h1 id="checkout-title" data-status-heading tabindex="-1">${escapeHtml(stateCopy.heading)}</h1>
            <p class="checkout-status-detail" data-status-detail>${escapeHtml(stateCopy.detail)}</p>
          </div>

          <div class="checkout-amount-block" data-amount-block>
            <p class="checkout-amount-label" data-amount-label>${escapeHtml(amountLabel)}</p>
            <p class="checkout-amount ${amountLengthClass}">
              <span class="uzu-sr-only" data-amount-accessible>${formatAmountAccessible(displayedAmountCents, amountLabel)}</span>
              <span class="checkout-currency" aria-hidden="true">¥</span>
              <strong class="uzu-mono" data-payable-amount aria-hidden="true">${formattedAmount}</strong>
              <span class="checkout-currency-code" aria-hidden="true">CNY</span>
            </p>
          </div>

          <div class="checkout-exact-note uzu-alert uzu-alert-info" data-payment-guidance${hiddenAttribute(!qrVisible)}>
            <div class="uzu-title-pair">
              <h2>金额必须完全一致</h2>
              <p>请按上方金额付款。金额不同将无法自动确认。</p>
            </div>
          </div>

          <dl class="checkout-order-details">
            <div>
              <dt>订单号</dt>
              <dd class="uzu-mono" data-merchant-order-no>${escapeHtml(checkout?.merchantOrderNo ?? "-")}</dd>
            </div>
            <div data-description-row${hiddenAttribute(checkout?.description === null || checkout?.description === undefined)}>
              <dt>订单说明</dt>
              <dd data-description>${escapeHtml(checkout?.description ?? "")}</dd>
            </div>
            <div>
              <dt>原始金额</dt>
              <dd class="uzu-mono" data-requested-amount>${checkout === null ? "-" : formatMoney(checkout.requestedAmountCents, checkout.currency)}</dd>
            </div>
          </dl>
        </section>

        <section class="checkout-code-panel" data-qr-panel${hiddenAttribute(!qrVisible)} aria-labelledby="code-title">
          <div class="checkout-code-heading">
            <h2 id="code-title">经营码</h2>
            <p>请使用支付宝扫描</p>
          </div>
          <figure class="checkout-code-figure">
            <img
              data-qr-image
              ${imageSourceAttributes(input.qrImageUrl, qrVisible)}
              width="320"
              height="320"
              alt="用于支付此订单的经营码"
              decoding="async"
            >
            <figcaption>付款前请再次核对金额</figcaption>
          </figure>
          <div class="checkout-code-error uzu-error-state" data-qr-error role="alert" hidden>
            <strong>经营码加载失败</strong>
            <p>请检查网络连接后重新加载。</p>
            <button class="uzu-button" type="button" data-qr-reload>重新加载经营码</button>
          </div>
          <div class="checkout-code-actions">
            <button class="uzu-button" type="button" data-qr-expand>放大经营码</button>
            <a class="uzu-button uzu-button-primary"${linkHrefAttribute(input.qrImageUrl)} download="perpay-collection-code.svg" data-qr-download>保存图片</a>
          </div>
        </section>
      </div>

      <div class="checkout-refund uzu-alert ${refundMessage.className}" data-refund-message role="status"${hiddenAttribute(refundMessage.text === null)}>
        <div class="uzu-title-pair">
          <h2 data-refund-title>${escapeHtml(refundMessage.title)}</h2>
          <p data-refund-detail>${escapeHtml(refundMessage.text ?? "")}</p>
        </div>
      </div>

      <section class="checkout-evidence" data-evidence-panel aria-labelledby="evidence-title">
        <div class="checkout-evidence-heading">
          <h2 id="evidence-title">付款确认进度</h2>
          <p>本页只显示服务器已经确认的结果</p>
        </div>
        <ol class="checkout-evidence-track">
          ${renderEvidenceStep("payment", "付款", evidence.payment)}
          ${renderEvidenceStep("ledger", "流水核对", evidence.ledger)}
          ${renderEvidenceStep("confirmation", "订单确认", evidence.confirmation)}
        </ol>
      </section>

      <div class="checkout-update-message uzu-alert" data-update-message role="status" aria-live="polite" hidden></div>
    </article>
  </main>

  <footer class="uzu-footer checkout-footer">
    <p>${escapeHtml(footerCopy)}</p>
  </footer>

  <dialog class="uzu-modal checkout-code-dialog" data-qr-dialog aria-labelledby="expanded-code-title">
    <div class="uzu-dialog-header checkout-dialog-header">
      <h2 id="expanded-code-title">经营码</h2>
      <button class="uzu-button" type="button" data-qr-dialog-close>关闭</button>
    </div>
    <img ${imageSourceAttributes(input.qrImageUrl, qrVisible)} width="640" height="640" alt="放大的经营码" data-qr-dialog-image>
    <p>请按页面显示的准确金额付款</p>
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
      className: "uzu-alert-info",
    };
  }
  if (checkout?.refund.status === "PARTIAL") {
    return {
      title: "款项已部分退款",
      text: "此订单已有部分退款，具体金额请联系订单提供方确认。",
      className: "uzu-alert-info",
    };
  }
  return { title: "", text: null, className: "" };
}

type EvidenceStepState = "complete" | "current" | "pending" | "danger" | "stopped";

interface EvidenceStepCopy {
  readonly state: EvidenceStepState;
  readonly detail: string;
}

function evidenceCopy(
  checkout: PublicCheckoutProjection | null,
  visualState: CheckoutVisualState,
): Readonly<Record<"payment" | "ledger" | "confirmation", EvidenceStepCopy>> {
  if (visualState === "CONFIRMED") {
    return {
      payment: { state: "complete", detail: "付款已到账" },
      ledger: { state: "complete", detail: "流水已核对" },
      confirmation: {
        state: "complete",
        detail: checkout?.payment.basis === "INFERRED" ? "已自动确认" : "订单已确认",
      },
    };
  }
  if (visualState === "DISPUTED") {
    return {
      payment: { state: "complete", detail: "已有付款记录" },
      ledger: { state: "complete", detail: "已有流水关联" },
      confirmation: { state: "danger", detail: "关联存在争议" },
    };
  }
  if (visualState === "CLOSED" || visualState === "EXPIRED") {
    return {
      payment: { state: "stopped", detail: visualState === "CLOSED" ? "订单已关闭" : "付款时间已结束" },
      ledger: { state: "pending", detail: "未进入核对" },
      confirmation: { state: "pending", detail: "未确认" },
    };
  }
  return {
    payment: { state: "current", detail: "等待付款" },
    ledger: { state: "pending", detail: "等待流水" },
    confirmation: { state: "pending", detail: "匹配后自动确认" },
  };
}

function renderEvidenceStep(
  name: "payment" | "ledger" | "confirmation",
  title: string,
  step: EvidenceStepCopy,
): string {
  return `<li class="checkout-evidence-step is-${step.state}" data-evidence-step="${name}" data-step-state="${step.state}">
            <span class="checkout-evidence-marker" aria-hidden="true"></span>
            <div>
              <strong>${title}</strong>
              <span data-evidence-detail>${escapeHtml(step.detail)}</span>
            </div>
          </li>`;
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
