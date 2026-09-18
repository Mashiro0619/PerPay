export type CheckoutViewState =
  | "UNPAID"
  | "CONFIRMED"
  | "DISPUTED"
  | "CLOSED"
  | "EXPIRED"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "UNAVAILABLE";
export interface CheckoutViewOrder {
  merchant_order_no: string;
  requested_amount_cents: number;
  currency: "CNY";
  product_name: string;
  return_url: string | null;
  payment_instructions: {
    payable_amount_cents: number;
    currency: "CNY";
  } | null;
  checkout: {
    status: "OPEN" | "CLOSED" | "EXPIRED";
    expires_at: string;
    closed_at: string | null;
  };
  payment: {
    status: "UNPAID" | "CONFIRMED" | "DISPUTED";
    basis: "NONE" | "INFERRED" | "MANUAL";
    received_amount_cents: number | null;
  };
  refund: { status: "NONE" | "PARTIAL" | "FULL" };
}
export interface CheckoutInitial {
  showProductName?: boolean;
  checkout: CheckoutViewOrder | null;
  initialError: {
    status: 404 | 429 | 503;
    code: string;
    message: string;
    retryAfterSeconds: number | null;
  } | null;
  apiUrl: string;
  qrUrl: string;
  qrAvailable: boolean;
  serverTime: number;
}
export const checkoutCopy: Record<
  CheckoutViewState,
  { badge: string; heading: string; detail: string }
> = {
  UNPAID: {
    badge: "等待付款",
    heading: "支付宝付款",
    detail: "",
  },
  CONFIRMED: {
    badge: "付款已确认",
    heading: "付款已确认",
    detail: "已收到付款，请勿重复支付。",
  },
  DISPUTED: {
    badge: "付款有争议",
    heading: "付款需要核实",
    detail: "请联系商家核实，勿再次付款。",
  },
  CLOSED: {
    badge: "订单已关闭",
    heading: "订单已关闭",
    detail: "此订单不再收款，请勿付款。",
  },
  EXPIRED: {
    badge: "订单已过期",
    heading: "订单已过期",
    detail: "付款时间已结束，请返回商家重新下单。",
  },
  NOT_FOUND: {
    badge: "订单不可用",
    heading: "找不到这个订单",
    detail: "链接已失效或不完整，请向商家获取新链接。",
  },
  RATE_LIMITED: {
    badge: "正在等待刷新",
    heading: "请求过于频繁",
    detail: "请稍等，页面会自动重试。",
  },
  UNAVAILABLE: {
    badge: "收款暂不可用",
    heading: "暂时无法确认付款",
    detail: "收款服务暂不可用，请勿付款。页面会自动重试。",
  },
};
export function checkoutState(order: CheckoutViewOrder): CheckoutViewState {
  if (order.payment.status !== "UNPAID") return order.payment.status;
  if (order.checkout.status !== "OPEN") return order.checkout.status;
  return "UNPAID";
}
export function initialCheckoutState(
  initial: CheckoutInitial,
): CheckoutViewState {
  if (initial.initialError)
    return initial.initialError.status === 404
      ? "NOT_FOUND"
      : initial.initialError.status === 429
        ? "RATE_LIMITED"
        : "UNAVAILABLE";
  return initial.checkout ? checkoutState(initial.checkout) : "NOT_FOUND";
}
export function checkoutMoney(cents: number) {
  if (!Number.isSafeInteger(cents) || cents < 0)
    throw new TypeError("amount cents is invalid");
  return (
    "¥" +
    Math.floor(cents / 100)
      .toString()
      .replace(/\B(?=(\d{3})+(?!\d))/g, ",") +
    "." +
    String(cents % 100).padStart(2, "0")
  );
}
export function merchantReturnUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.hash
      ? url.href
      : null;
  } catch {
    return null;
  }
}
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};
const amount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
export function parseCheckoutPayload(payload: unknown): CheckoutViewOrder {
  const value = record(record(payload).data),
    checkout = record(value.checkout),
    payment = record(value.payment),
    refund = record(value.refund),
    instructions = record(value.payment_instructions);
  if (
    typeof value.merchant_order_no !== "string" ||
    !value.merchant_order_no ||
    typeof value.product_name !== "string" ||
    !value.product_name ||
    value.currency !== "CNY" ||
    !amount(value.requested_amount_cents) ||
    !["OPEN", "CLOSED", "EXPIRED"].includes(String(checkout.status)) ||
    typeof checkout.expires_at !== "string" ||
    !Number.isFinite(Date.parse(checkout.expires_at)) ||
    !["UNPAID", "CONFIRMED", "DISPUTED"].includes(String(payment.status)) ||
    !["NONE", "INFERRED", "MANUAL"].includes(String(payment.basis)) ||
    (payment.received_amount_cents !== null &&
      !amount(payment.received_amount_cents)) ||
    !["NONE", "PARTIAL", "FULL"].includes(String(refund.status)) ||
    (value.payment_instructions !== null &&
      (!amount(instructions.payable_amount_cents) ||
        instructions.currency !== "CNY"))
  )
    throw new TypeError("checkout response is invalid");
  return {
    merchant_order_no: value.merchant_order_no,
    product_name: value.product_name,
    currency: "CNY",
    requested_amount_cents: value.requested_amount_cents,
    return_url: merchantReturnUrl(value.return_url),
    payment_instructions:
      value.payment_instructions === null
        ? null
        : {
            payable_amount_cents: instructions.payable_amount_cents as number,
            currency: "CNY",
          },
    checkout: {
      status: checkout.status as CheckoutViewOrder["checkout"]["status"],
      expires_at: checkout.expires_at,
      closed_at:
        typeof checkout.closed_at === "string" ? checkout.closed_at : null,
    },
    payment: {
      status: payment.status as CheckoutViewOrder["payment"]["status"],
      basis: payment.basis as CheckoutViewOrder["payment"]["basis"],
      received_amount_cents: payment.received_amount_cents as number | null,
    },
    refund: { status: refund.status as CheckoutViewOrder["refund"]["status"] },
  };
}
