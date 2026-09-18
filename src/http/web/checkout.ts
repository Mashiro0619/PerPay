import type { PublicCheckoutProjection } from "../../orders/model.ts";
import { checkoutFrontend } from "./checkout-frontend.ts";
import {
  checkoutCopy,
  initialCheckoutState,
  merchantReturnUrl,
  type CheckoutInitial,
} from "../../shared/checkout-view.ts";
export const CHECKOUT_PAGE_ASSETS = Object.freeze({
  checkoutStylesheet: checkoutFrontend?.styles[0] ?? "",
  checkoutScript: checkoutFrontend?.script ?? "",
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
  readonly showProductName?: boolean;
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
  if (!checkoutFrontend)
    throw new Error("公开收银台尚未构建，请运行 npm run build:checkout");
  const missing = input.checkout === null && input.initialError?.status === 404;
  const order = input.checkout;
  const initial: CheckoutInitial = {
    serverTime: Date.now(),
    showProductName: input.showProductName !== false,
    apiUrl: missing ? "" : checkoutApiPath(input.checkoutToken),
    qrUrl: missing
      ? ""
      : (input.qrImageUrl ?? checkoutQrPath(input.checkoutToken)),
    qrAvailable: input.qrImageUrl !== null,
    initialError: input.initialError,
    checkout: order
      ? {
          merchant_order_no: order.merchantOrderNo,
          requested_amount_cents: order.requestedAmountCents,
          currency: order.currency,
          product_name: input.showProductName === false ? "" : order.productName,
          return_url: merchantReturnUrl(order.returnUrl),
          payment_instructions: order.paymentInstructions
            ? {
                payable_amount_cents:
                  order.paymentInstructions.payableAmountCents,
                currency: order.paymentInstructions.currency,
              }
            : null,
          checkout: {
            status: order.checkout.status,
            expires_at: new Date(order.checkout.expiresAt).toISOString(),
            closed_at:
              order.checkout.closedAt === null
                ? null
                : new Date(order.checkout.closedAt).toISOString(),
          },
          payment: {
            status: order.payment.status,
            basis: order.payment.basis,
            received_amount_cents: order.payment.receivedAmountCents,
          },
          refund: { status: order.refund.status },
        }
      : null,
  };
  const title =
    (order?.merchantOrderNo ??
      checkoutCopy[initialCheckoutState(initial)].heading) + " | PerPay 收银台";
  return (
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="color-scheme" content="light dark"><meta name="theme-color" content="#ffffff"><meta name="robots" content="noindex, nofollow, noarchive"><title>' +
    escapeHtml(title) +
    '</title><script src="' +
    checkoutFrontend.theme +
    '"></script>' +
    checkoutFrontend.styles
      .map((href) => '<link rel="stylesheet" href="' + href + '">')
      .join("") +
    '</head><body><div id="checkout-root" data-initial="' +
    escapeHtml(JSON.stringify(initial)) +
    '">' +
    checkoutFrontend.render(initial) +
    '</div><script type="module" src="' +
    checkoutFrontend.script +
    '"></script></body></html>'
  );
}
function validateInput(input: CheckoutPageInput): void {
  if (input.checkout === null && input.initialError === null) {
    throw new TypeError(
      "checkout page requires checkout data or an initial error",
    );
  }
  if (input.qrImageUrl !== null)
    assertSameOriginPath(input.qrImageUrl, "QR image URL");
  if (
    input.initialError?.retryAfterSeconds !== null &&
    input.initialError?.retryAfterSeconds !== undefined &&
    (!Number.isSafeInteger(input.initialError.retryAfterSeconds) ||
      input.initialError.retryAfterSeconds < 0)
  ) {
    throw new TypeError(
      "retry-after seconds must be a non-negative safe integer",
    );
  }
}

function assertSameOriginPath(value: string, label: string): void {
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\r\n]/.test(value)
  ) {
    throw new TypeError(`${label} must be a same-origin absolute path`);
  }
  const parsed = new URL(value, "https://checkout.invalid");
  if (parsed.origin !== "https://checkout.invalid") {
    throw new TypeError(`${label} must be a same-origin absolute path`);
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
